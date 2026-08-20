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
  ARRIVE_RADIUS, BROADCAST_HZ, PALETTE, RACE, STAMINA, TICK_HZ, WS_PORT,
} from '../shared/constants.js';
import { buildCity } from '../shared/city.js';
import { type Body, newBody, stepBody } from '../shared/movement.js';
import { allVehicles } from '../shared/vehicles.js';
import { platformAt, snapToStreet } from '../shared/streets.js';
import type { C2SMessage, City, PlayerState, S2CMessage, WorldState } from '../shared/types.js';

type Client = {
  id: string;
  socket: WebSocket;
  wx: number;
  wy: number;
  facing: number;
  sprint: boolean;
  jump: boolean;
};

const clients = new Map<string, Client>();
const players = new Map<string, PlayerState>();
/**
 * Velocity and stamina live here rather than in PlayerState — velocity because
 * nobody else needs it, stamina because the server is the only thing allowed
 * to decide how much of it you have. A copy of the latter is published each
 * tick so the bar has something to draw and a rival's dash is readable.
 */
const bodies = new Map<string, Body>();

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
  // On the PLATFORM, not in the road — see PLATFORM.offset. Standing where
  // the vehicles stop would mean being scooped up by the first thing to
  // arrive, which is the choice the round is supposed to open with.
  const stop = city.stops[city.origin];
  const pad = platformAt(city.streets, stop, city.origin);
  // Scatter ALONG the platform, never across it. A radial scatter reached far
  // enough to put somebody in the middle of the road, where the first vehicle
  // through picks them up before the round has started.
  /**
   * A ring a metre wide, and no wider.
   *
   * Every attempt to spread people out along the platform eventually put
   * somebody back on a centre line — a radial scatter reached into the road,
   * and scattering "along the platform" is meaningless at a crossroads, where
   * the platform steps diagonally off both streets at once. Players do not
   * collide with each other, so standing on top of one another for the first
   * second of a round costs nothing at all, and being run over before the
   * clock starts costs the round.
   */
  const a = Math.random() * Math.PI * 2;
  p.x = pad.x + Math.cos(a) * 1.2;
  p.y = pad.y + Math.sin(a) * 1.2;
  p.h = 0;
  p.grounded = true;
  p.riding = null;
  p.finished = null;
  p.place = 0;
  p.stamina = 1;
  p.sprinting = false;
  bodies.set(p.id, newBody(p.x, p.y));
}

/**
 * The R key. It puts you back on the nearest street, on your feet, off
 * whatever you were riding — and that is all.
 *
 * It used to call `spawn`, which had two problems. It teleported you to the
 * ORIGIN, so an escape hatch for being stuck cost you the entire race; and
 * spawn also clears `finished` and `place`, so a player who had already
 * crossed the line could press R and quietly un-finish themselves — leaving
 * the finisher count one too high, the next player's placing wrong, and the
 * round unable to end because somebody was racing again.
 *
 * Stamina is carried over. Refilling it would make this a free sprint.
 */
function unstick(p: PlayerState) {
  if (p.finished !== null) return;
  const here = snapToStreet(city.streets, { x: p.x, y: p.y });
  const body = bodies.get(p.id);
  const stamina = body?.stamina ?? 1;
  p.x = here.x; p.y = here.y; p.h = 0;
  p.grounded = true;
  p.riding = null;
  p.sprinting = false;
  const fresh = newBody(p.x, p.y);
  fresh.stamina = stamina;
  bodies.set(p.id, fresh);
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

function tick(dt: number) {
  time += dt;
  elapsed += dt;

  if (phase === 'intermission') {
    if (elapsed >= RACE.intermissionSeconds) startRound();
    return;
  }

  const dest = city.stops[city.destination];
  // One evaluation of the timetable for the whole tick: every body needs the
  // same fleet, and it is a pure function of the clock anyway.
  const vehicles = allVehicles(city, time);
  const ground = { streets: city.streets, river: city.river, transit: { city, vehicles, time } };

  for (const p of players.values()) {
    if (p.finished !== null) continue;

    const c = clients.get(p.id);
    let body = bodies.get(p.id);
    if (!body) { body = newBody(p.x, p.y); bodies.set(p.id, body); }

    stepBody(body, {
      wx: c?.wx ?? 0, wy: c?.wy ?? 0,
      sprint: c?.sprint ?? false, jump: c?.jump ?? false,
    }, dt, ground);

    p.x = body.x; p.y = body.y; p.h = body.h;
    p.grounded = body.grounded;
    p.riding = body.riding;
    p.sprinting = body.sprinting;
    // Sitting down is resting: you get your legs back on the way, which is
    // what makes spending the whole tank on the first dash affordable.
    if (body.riding) body.stamina = Math.min(1, body.stamina + dt / STAMINA.recover);
    p.stamina = body.stamina;
    if (c) p.facing = c.facing;

    // You finish on your feet. The last leg of every race is the walk from
    // the platform to the door, which is where a close one is decided — and
    // being carried past it by a tram does not count.
    if (!p.riding && Math.hypot(p.x - dest.x, p.y - dest.y) <= ARRIVE_RADIUS) {
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
    x: 0, y: 0, h: 0, facing: 0, grounded: true, riding: null,
    stamina: 1, sprinting: false, finished: null, place: 0,
  };
  players.set(id, player);
  clients.set(id, { id, socket, wx: 0, wy: 0, facing: 0, sprint: false, jump: false });
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
      c.sprint = !!msg.sprint;
      c.jump = !!msg.jump;
    } else if (msg.type === 'action') {
      if (msg.action === 'reset') unstick(player);
    } else if (msg.type === 'name') {
      player.name = String(msg.name).slice(0, 16) || player.name;
    }
  });

  socket.on('close', () => {
    clients.delete(id);
    players.delete(id);
    bodies.delete(id);
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
