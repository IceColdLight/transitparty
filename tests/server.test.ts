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
import { WALK } from '../src/shared/constants.js';
import { platformAt } from '../src/shared/streets.js';
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

/** Half the longest vehicle: how far from its centre a passenger may stand. */
const BODY_SLACK = 24;

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
  const pad = platformAt(city.streets, origin, city.origin);
  check('everybody starts on the platform, not in the road',
    a.state!.players.every((p) => Math.hypot(p.x - pad.x, p.y - pad.y) < 8),
    `furthest ${Math.max(...a.state!.players.map((p) =>
      Math.hypot(p.x - pad.x, p.y - pad.y))).toFixed(1)}m from the platform`);
  check('and nobody is standing on anything yet', a.state!.players.every((p) => p.riding === null));
  check('everybody starts on their feet, on the ground',
    a.state!.players.every((p) => p.h === 0 && p.grounded));

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
  a.send({ type: 'walk', seq: 0, wx: dirX, wy: dirY, facing: 0, sprint: false, jump: false });
  await sleep(1200);
  a.send({ type: 'walk', seq: 0, wx: 0, wy: 0, facing: 0, sprint: false, jump: false });
  await sleep(200);
  const moved = Math.hypot(me(a).x - before.x, me(a).y - before.y);
  /**
   * Only a lower bound, and it checks you are still on your own two feet.
   * The upper bound used to be there too and it failed at random: the streets
   * have traffic on them, anything standing over a deck is lifted onto it, and
   * a bus coming through the junction picks you up mid-test and carries you
   * fifteen metres. That is the game working.
   */
  check('walk input reaches the server and moves you',
    moved > WALK.speed * 0.35,
    `${moved.toFixed(1)}m in ~1.2s at ${WALK.speed.toFixed(1)} m/s` +
    (me(a).riding ? ' — and then picked up by traffic, which counts' : ''));
  check('and it does not move anybody else',
    Math.hypot(me(b).x - pad.x, me(b).y - pad.y) < 8, 'b stayed put');

  a.send({ type: 'action', action: 'reset' });
  await sleep(200);

  describe('boarding, which is just walking onto something');

  /**
   * There is no board key any more, so this has to be done the way a player
   * does it: stand on the platform, wait for something with its doors open,
   * and walk out into the road onto its deck.
   */
  // From the platform towards the middle of the road, where the vehicles stop.
  const toRoad = { x: origin.x - pad.x, y: origin.y - pad.y };
  const toRoadLen = Math.hypot(toRoad.x, toRoad.y) || 1;
  toRoad.x /= toRoadLen; toRoad.y /= toRoadLen;

  const halt = () =>
    b.send({ type: 'walk', seq: 0, wx: 0, wy: 0, facing: 0, sprint: false, jump: false });

  /** Head for a point, or stand still once you are on it. */
  const headFor = (tx: number, ty: number) => {
    const dx = tx - me(b).x, dy = ty - me(b).y;
    const len = Math.hypot(dx, dy);
    if (len < 0.8) { halt(); return; }
    b.send({
      type: 'walk', seq: 0, wx: dx / len, wy: dy / len,
      facing: 0, sprint: false, jump: false,
    });
  };

  /**
   * Wait on the platform; when something pulls up, walk out to it.
   *
   * The first version of this loop walked backwards whenever the stop was
   * empty, which is most of the time, so the client drifted steadily away
   * from the platform and was never close enough to reach a vehicle inside a
   * four-second dwell. Aim for a fixed point instead of pushing in a
   * direction.
   */
  let boarded = false;
  for (let i = 0; i < 900 && !boarded; i++) {
    const here = allVehicles(city, b.state!.time).some((v) => v.atStop === city.origin);
    if (here) headFor(origin.x, origin.y); else headFor(pad.x, pad.y);
    await sleep(50);
    // Stop the INSTANT you are aboard. A deck is three metres wide and you
    // cross two of them in the time it takes to notice.
    if (me(b).riding) { halt(); boarded = true; }
  }
  halt();

  check('walking onto a vehicle at a stop puts you aboard it',
    boarded, boarded ? `${me(b).riding}` : 'never got on');

  if (boarded) {
    const id = me(b).riding!;
    const line = city.lines[Number(id.split('.')[0])];
    note(`stepped onto ${line.name} (${line.mode}) at ${origin.name}`);
    check('and standing on a deck puts your feet above the road',
      me(b).h > 0.2, `${me(b).h.toFixed(2)}m up`);

    let departed = false;
    for (let i = 0; i < 300 && !departed; i++) {
      const v = allVehicles(city, b.state!.time).find((x) => x.id === id);
      if (v && v.atStop < 0) departed = true; else await sleep(100);
    }
    check('the doors shut and it pulls away', departed);

    /**
     * The property is that you go exactly where the vehicle goes — not that
     * you cover some particular distance, because it might spend the window
     * standing at the next stop with its doors open.
     */
    const start = { x: me(b).x, y: me(b).y };
    const vStart = allVehicles(city, b.state!.time).find((x) => x.id === id)!;
    await sleep(2000);
    const vEnd = allVehicles(city, b.state!.time).find((x) => x.id === id)!;
    const carried = Math.hypot(me(b).x - start.x, me(b).y - start.y);
    const vehicleWent = Math.hypot(vEnd.x - vStart.x, vEnd.y - vStart.y);
    check('the deck takes you exactly where it goes',
      Math.abs(carried - vehicleWent) < 6,
      `you moved ${carried.toFixed(0)}m, it moved ${vehicleWent.toFixed(0)}m`);
    check('and you are still standing on the same vehicle',
      me(b).riding === id, `${me(b).riding}`);

    const v = allVehicles(city, b.state!.time).find((x) => x.id === id);
    check('the server has you exactly where the timetable says the vehicle is',
      !!v && Math.hypot(v.x - me(b).x, v.y - me(b).y) < BODY_SLACK,
      v ? `${Math.hypot(v.x - me(b).x, v.y - me(b).y).toFixed(1)}m from its centre` : 'vehicle gone');

    describe('and getting off is jumping off');

    /**
     * Road vehicles are open, so you can leave whenever you like. Rail ones
     * are not, and that is checked below.
     */
    const road = line.mode === 'bus' || line.mode === 'tram';
    if (road) {
      let off = false;
      for (let i = 0; i < 80 && !off; i++) {
        b.send({ type: 'walk', seq: 0, wx: toRoad.x, wy: toRoad.y, facing: 0, sprint: false, jump: true });
        await sleep(120);
        if (me(b).riding === null) off = true;
      }
          halt();
      check('you can jump off a moving bus', off, off ? 'landed' : 'still aboard');
      await sleep(900);
      /**
       * Where you land is not the point and is not predictable — the street,
       * another vehicle, or back on the one you left, depending on how close
       * to the edge you were when you jumped. The point is that you came down
       * on something and are not falling through the world.
       */
      check('and you come back down onto something solid',
        me(b).grounded && me(b).h >= 0,
        `h=${me(b).h.toFixed(2)} on ${me(b).riding ?? 'the street'}`);
    } else {
      let escaped = false;
      for (let i = 0; i < 30; i++) {
        const now = allVehicles(city, b.state!.time).find((x) => x.id === id);
        if (now && now.atStop >= 0) break;   // it stopped; the doors are open
        b.send({ type: 'walk', seq: 0, wx: toRoad.x, wy: toRoad.y, facing: 0, sprint: true, jump: true });
        await sleep(100);
        if (me(b).riding === null) { escaped = true; break; }
      }
      b.send({ type: 'walk', seq: 0, wx: 0, wy: 0, facing: 0, sprint: false, jump: false });
      check('you cannot get out of a metro between stations',
        !escaped, escaped ? 'ESCAPED INTO A TUNNEL' : `${line.name} kept hold of you`);
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
