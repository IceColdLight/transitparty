/**
 * The authoritative server.
 *
 * It is small, and it is small for one reason: the city and every vehicle in
 * it are pure functions of (seed, clock). The server does not simulate a
 * network — it picks a seed, advances a clock, and the only thing it actually
 * owns is where the players are and whether they are aboard something.
 *
 * So the state packet is a handful of players and a seed, no matter how big
 * the city gets.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ARRIVE_RADIUS, BOARD_RADIUS, BROADCAST_HZ, PALETTE, RACE, TICK_HZ, WS_PORT,
} from '../shared/constants.js';
import { buildCity } from '../shared/city.js';
import { stepWalk, type Walker } from '../shared/movement.js';
import { allVehicles, vehicleById } from '../shared/vehicles.js';
import type { C2SMessage, City, PlayerState, S2CMessage, WorldState } from '../shared/types.js';

type Client = {
  id: string;
  socket: WebSocket;
  wx: number;
  wy: number;
  facing: number;
};

const clients = new Map<string, Client>();
const players = new Map<string, PlayerState>();
/** Velocity is server-only; nobody else needs it and it doubles the packet. */
const vel = new Map<string, { vx: number; vy: number }>();

let city: City = buildCity(newSeed());
let roundIndex = 1;
let phase: 'racing' | 'intermission' = 'racing';
let elapsed = 0;
let finishers = 0;
/** Sim clock in seconds. Only ever advanced in exact fixed steps. */
let time = 0;

function newSeed(): number {
  return (Math.random() * 0x7fffffff) >>> 0;
}

function spawn(p: PlayerState) {
  const s = city.stops[city.origin];
  // Scatter them a little so a full lobby is not one token deep.
  const a = Math.random() * Math.PI * 2;
  const d = Math.random() * 9;
  p.x = s.x + Math.cos(a) * d;
  p.y = s.y + Math.sin(a) * d;
  p.riding = null;
  p.finished = null;
  p.place = 0;
  vel.set(p.id, { vx: 0, vy: 0 });
}

function startRound() {
  roundIndex++;
  city = buildCity(newSeed());
  phase = 'racing';
  elapsed = 0;
  finishers = 0;
  for (const p of players.values()) spawn(p);
  const s = city.stops[city.origin], d = city.stops[city.destination];
  console.log(
    `round ${roundIndex}: seed ${city.seed} — ${s.name} → ${d.name}, ` +
    `par ${city.par.time.toFixed(0)}s / ${city.par.transfers} changes ` +
    `(walk ${city.par.walk.toFixed(0)}s), ${city.stops.length} stops, ` +
    `${city.par.strict ? 'strict' : 'FALLBACK'} in ${city.par.attempts}`,
  );
}

function endRound() {
  phase = 'intermission';
  elapsed = 0;
  for (const p of players.values()) p.riding = null;
}

function interact(p: PlayerState) {
  if (phase !== 'racing' || p.finished !== null) return;

  if (p.riding) {
    const v = vehicleById(city, p.riding, time);
    // You cannot step off a moving tram. The doors are the whole timing game:
    // miss your stop and you are carried to the next one, which is a real
    // punishment and takes no rule of its own to express.
    if (v && v.atStop >= 0) {
      const s = city.stops[v.atStop];
      const a = Math.random() * Math.PI * 2;
      p.x = s.x + Math.cos(a) * 7;
      p.y = s.y + Math.sin(a) * 7;
      p.riding = null;
      vel.set(p.id, { vx: 0, vy: 0 });
    }
    return;
  }

  let best: string | null = null;
  let bestD = BOARD_RADIUS;
  for (const v of allVehicles(city, time)) {
    if (v.atStop < 0) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= bestD) { bestD = d; best = v.id; }
  }
  if (best) p.riding = best;
}

function tick(dt: number) {
  time += dt;
  elapsed += dt;

  if (phase === 'intermission') {
    if (elapsed >= RACE.intermissionSeconds) startRound();
    return;
  }

  const dest = city.stops[city.destination];
  for (const p of players.values()) {
    if (p.finished !== null) continue;

    if (p.riding) {
      const v = vehicleById(city, p.riding, time);
      if (!v) { p.riding = null; continue; }
      p.x = v.x;
      p.y = v.y;
      continue;
    }

    const c = clients.get(p.id);
    const w = vel.get(p.id) ?? { vx: 0, vy: 0 };
    const walker: Walker = { x: p.x, y: p.y, vx: w.vx, vy: w.vy };
    stepWalk(walker, c?.wx ?? 0, c?.wy ?? 0, dt, city.streets, city.river);
    p.x = walker.x; p.y = walker.y;
    vel.set(p.id, { vx: walker.vx, vy: walker.vy });
    if (c) p.facing = c.facing;

    // You finish on your feet. The last leg of every race is a walk from the
    // platform to the door, which is where a close one is actually decided.
    if (Math.hypot(p.x - dest.x, p.y - dest.y) <= ARRIVE_RADIUS) {
      p.finished = elapsed;
      p.place = ++finishers;
      console.log(`  ${p.name} finished ${p.place}. in ${elapsed.toFixed(1)}s`);
    }
  }

  const racing = [...players.values()].filter((p) => p.finished === null);
  if ((players.size > 0 && racing.length === 0) || elapsed >= RACE.roundSeconds) endRound();
}

function snapshot(): WorldState {
  return {
    time,
    round: {
      seed: city.seed,
      index: roundIndex,
      phase,
      elapsed,
      duration: phase === 'racing' ? RACE.roundSeconds : RACE.intermissionSeconds,
    },
    players: [...players.values()],
  };
}

/** PORT lets a test (or a second instance) run alongside the real server. */
const port = Number(process.env.PORT) || WS_PORT;
const wss = new WebSocketServer({ port });
let nextId = 1;

wss.on('connection', (socket) => {
  const id = `p${nextId++}`;
  const color = PALETTE[(nextId - 2) % PALETTE.length];
  const player: PlayerState = {
    id, name: `Player ${nextId - 1}`, color,
    x: 0, y: 0, facing: 0, riding: null, finished: null, place: 0,
  };
  players.set(id, player);
  clients.set(id, { id, socket, wx: 0, wy: 0, facing: 0 });
  spawn(player);

  const send = (m: S2CMessage) => socket.send(JSON.stringify(m));
  send({ type: 'welcome', id, color, tickRate: TICK_HZ });
  console.log(`+ ${id} (${players.size} playing)`);

  socket.on('message', (raw) => {
    let msg: C2SMessage;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const c = clients.get(id);
    if (!c) return;
    if (msg.type === 'walk') {
      const len = Math.hypot(msg.wx, msg.wy);
      c.wx = len > 1 ? msg.wx / len : msg.wx;
      c.wy = len > 1 ? msg.wy / len : msg.wy;
      c.facing = msg.facing;
    } else if (msg.type === 'action') {
      if (msg.action === 'interact') interact(player);
      else if (msg.action === 'reset') spawn(player);
    } else if (msg.type === 'name') {
      player.name = String(msg.name).slice(0, 16) || player.name;
    }
  });

  socket.on('close', () => {
    clients.delete(id);
    players.delete(id);
    vel.delete(id);
    console.log(`- ${id} (${players.size} playing)`);
  });
});

const dt = 1 / TICK_HZ;
let acc = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  acc += (now - last) / 1000;
  last = now;
  // Never let a stalled process catch up in one lurch — a tab that was
  // backgrounded for a minute would teleport everybody.
  if (acc > 0.5) acc = 0.5;
  while (acc >= dt) { tick(dt); acc -= dt; }
}, 1000 / TICK_HZ);

setInterval(() => {
  const msg = JSON.stringify({ type: 'state', state: snapshot() });
  for (const c of clients.values()) {
    if (c.socket.readyState === 1) c.socket.send(msg);
  }
}, 1000 / BROADCAST_HZ);

{
  const s = city.stops[city.origin], d = city.stops[city.destination];
  console.log(`transit party server on :${port}`);
  console.log(
    `round 1: seed ${city.seed} — ${s.name} → ${d.name}, ` +
    `par ${city.par.time.toFixed(0)}s / ${city.par.transfers} changes`,
  );
}
