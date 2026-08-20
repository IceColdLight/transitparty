/**
 * The server, driven over a real socket.
 *
 * Everything else in this directory tests pure functions. This one boots the
 * actual process and plays it, because the interesting failures in a
 * networked prototype live exactly where the pure parts meet the wire: a
 * player who spawns in the wrong city, a board that succeeds while the tram
 * is still moving, a client whose walk input is dropped.
 *
 * It rebuilds the city from the seed the server sends and then asserts things
 * about the server's OWN state — which is also a direct check of the claim the
 * whole design rests on, that a seed is enough to agree on a city.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_RADIUS, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { allVehicles } from '../src/shared/vehicles.js';
import type { S2CMessage, WorldState } from '../src/shared/types.js';
import { check, describe, note, report } from './harness.js';

const PORT = 8199;
const here = dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, ['--import', 'tsx', join(here, '../src/server/index.ts')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Peer = {
  id: string; color: string; ws: WebSocket;
  state: WorldState | null;
  send: (m: unknown) => void;
};

async function connectPeer(): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const peer: Peer = {
    id: '', color: '', ws, state: null,
    send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
  };
  // Both handlers go on BEFORE the open is awaited. The server sends its
  // welcome the instant the socket opens, and a 'message' emitted before
  // anyone is listening is simply gone — which showed up here as a client
  // that had joined the game and did not know its own id.
  const errors: Error[] = [];
  ws.on('error', (e) => errors.push(e as Error));
  ws.on('message', (raw) => {
    const msg: S2CMessage = JSON.parse(String(raw));
    if (msg.type === 'welcome') { peer.id = msg.id; peer.color = msg.color; }
    else if (msg.type === 'state') peer.state = msg.state;
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  for (let i = 0; i < 100 && (!peer.id || !peer.state); i++) await sleep(30);
  return peer;
}

const me = (p: Peer) => p.state!.players.find((q) => q.id === p.id)!;

async function main() {
  // The process needs a moment to build its first city.
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { const t = await connectPeer(); t.ws.close(); break; } catch { /* not up yet */ }
  }

  describe('joining');

  const a = await connectPeer();
  const b = await connectPeer();
  check('two clients get a welcome each', !!a.id && !!b.id, `${a.id}, ${b.id}`);
  check('with different identities and colours',
    a.id !== b.id && a.color !== b.color, `${a.color} vs ${b.color}`);
  check('and both see the same city', a.state!.round.seed === b.state!.round.seed,
    `seed ${a.state!.round.seed}`);

  const city = buildCity(a.state!.round.seed);
  note(`${city.stops[city.origin].name} → ${city.stops[city.destination].name}, ` +
    `par ${city.par.time.toFixed(0)}s, ${city.par.transfers} changes`);

  const origin = city.stops[city.origin];
  check('everybody starts on the origin platform',
    a.state!.players.every((p) => Math.hypot(p.x - origin.x, p.y - origin.y) < 20),
    `furthest ${Math.max(...a.state!.players.map((p) =>
      Math.hypot(p.x - origin.x, p.y - origin.y))).toFixed(1)}m`);
  check('and nobody is aboard anything yet', a.state!.players.every((p) => p.riding === null));

  describe('walking');

  /**
   * Walk ALONG the street the origin sits on. An earlier version always
   * walked east and failed on any seed where east was a building or the
   * river — which read as "the server dropped my input" and was nothing of
   * the kind.
   */
  const onVertical = city.streets.xs.some((x) => Math.abs(x - origin.x) <= city.streets.width / 2);
  const dirX = onVertical ? 0 : 1, dirY = onVertical ? 1 : 0;
  note(`origin sits on a ${onVertical ? 'north-south' : 'east-west'} street`);

  const before = { x: me(a).x, y: me(a).y };
  a.send({ type: 'walk', seq: 0, wx: dirX, wy: dirY, facing: 0 });
  await sleep(1200);
  a.send({ type: 'walk', seq: 0, wx: 0, wy: 0, facing: 0 });
  await sleep(200);
  const moved = Math.hypot(me(a).x - before.x, me(a).y - before.y);
  check('walk input moves you, at about walking pace',
    moved > WALK.speed * 0.6 && moved < WALK.speed * 1.6,
    `${moved.toFixed(1)}m in ~1.2s at ${WALK.speed.toFixed(1)} m/s`);
  check('and it does not move anybody else',
    Math.hypot(me(b).x - origin.x, me(b).y - origin.y) < 20, 'b stayed put');

  a.send({ type: 'action', action: 'reset' });
  await sleep(200);

  describe('boarding');

  // Ask for a boarding while nothing has its doors open here.
  let quiet = false;
  for (let i = 0; i < 200 && !quiet; i++) {
    const t = b.state!.time;
    const near = allVehicles(city, t).some((v) =>
      v.atStop >= 0 && Math.hypot(v.x - me(b).x, v.y - me(b).y) <= BOARD_RADIUS);
    if (!near) {
      b.send({ type: 'action', action: 'interact' });
      await sleep(150);
      quiet = true;
      check('you cannot board thin air', me(b).riding === null, `riding ${me(b).riding}`);
    } else await sleep(60);
  }
  if (!quiet) note('platform never went quiet — skipped the empty-platform check');

  // Now wait for something with its doors open and get on it.
  let boarded = false;
  for (let i = 0; i < 400 && !boarded; i++) {
    const t = b.state!.time;
    const v = allVehicles(city, t).find((x) =>
      x.atStop >= 0 && Math.hypot(x.x - me(b).x, x.y - me(b).y) <= BOARD_RADIUS);
    if (v) {
      b.send({ type: 'action', action: 'interact' });
      await sleep(150);
      if (me(b).riding) {
        boarded = true;
        check('you can board a vehicle standing at your platform', true, `${me(b).riding}`);
        const line = city.lines[Number(me(b).riding!.split('.')[0])];
        note(`boarded ${line.name} (${line.mode}) at ${city.stops[city.origin].name}`);
      }
    } else await sleep(60);
  }
  check('a vehicle turned up and was boardable', boarded);

  if (boarded) {
    const id = me(b).riding!;

    // Wait for the doors to shut before timing anything. Boarding at a
    // TERMINUS means sitting through a double dwell — the end of one
    // direction's and the start of the other's — so a first attempt at this
    // check measured a bus that had every right not to have moved yet.
    let departed = false;
    for (let i = 0; i < 300 && !departed; i++) {
      const v = allVehicles(city, b.state!.time).find((x) => x.id === id);
      if (v && v.atStop < 0) departed = true; else await sleep(100);
    }
    check('the doors eventually shut and it pulls away', departed);
    const start = { x: me(b).x, y: me(b).y };
    await sleep(2500);
    const carried = Math.hypot(me(b).x - start.x, me(b).y - start.y);
    check('riding carries you along, faster than you could walk',
      carried > 8, `${carried.toFixed(0)}m in 2.5s — walking would be ~6m`);

    // The server puts riders exactly on their vehicle, which is what lets the
    // client draw a full carriage as one object instead of a shivering cloud.
    const v = allVehicles(city, b.state!.time).find((x) => x.id === id);
    check('and the server has you exactly where the timetable says the vehicle is',
      !!v && Math.hypot(v.x - me(b).x, v.y - me(b).y) < 12,
      v ? `${Math.hypot(v.x - me(b).x, v.y - me(b).y).toFixed(1)}m apart` : 'vehicle gone');

    /**
     * Getting off is only allowed with the doors open — so hammer the key the
     * whole way and check WHERE you end up, not what the timetable said when
     * the key was pressed.
     *
     * The first version of this check did the latter and failed
     * intermittently for a good reason: the client samples the timetable, then
     * the server acts on the request up to a broadcast later, by which time
     * the tram has legitimately arrived. Asserting on the outcome — you are
     * standing on a platform of the line you were riding — has no such window.
     */
    let gotOff = false;
    for (let i = 0; i < 400 && !gotOff; i++) {
      b.send({ type: 'action', action: 'interact' });
      await sleep(120);
      if (me(b).riding === null) gotOff = true;
    }
    check('and you can get off at all', gotOff);
    if (gotOff) {
      const line = city.lines[Number(id.split('.')[0])];
      let nearest = -1, nd = Infinity;
      for (const sid of line.stops) {
        const d = Math.hypot(city.stops[sid].x - me(b).x, city.stops[sid].y - me(b).y);
        if (d < nd) { nd = d; nearest = sid; }
      }
      check('you can only step off at a stop on the line you were riding',
        nd < 12, `${nd.toFixed(1)}m from ${city.stops[nearest].name}`);
    }
  }

  describe('leaving');

  const seen = a.state!.players.length;
  b.ws.close();
  await sleep(400);
  check('a disconnect removes the player from the world',
    me(a) && a.state!.players.length === seen - 1,
    `${seen} → ${a.state!.players.length}`);

  a.ws.close();
  server.kill();
  report();
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
