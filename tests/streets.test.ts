/**
 * The street grid: what you can walk on, and who has to respect it.
 *
 * Three rules, and they are not the same rule:
 *   - you may only walk on a street. Blocks are solid
 *   - buses and trams are laid ALONG the grid, because a bus that cuts
 *     diagonally across a block is not on a road
 *   - metros and trains ignore it entirely, because they are under it and over
 *     it — but their STATIONS still have to be somewhere a person can stand
 *
 * The third is the one that fails silently: a metro corridor runs wherever it
 * likes, and a station left in the middle of a block is a station nobody can
 * ever board at. Nothing throws; the race just becomes unwinnable.
 */
import { WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { newBody, stepBody } from '../src/shared/movement.js';
import { onStreet } from '../src/shared/streets.js';
import { pedestrian, walkNeighbours } from '../src/shared/routing.js';
import { walkDistances } from '../src/shared/streets.js';
import { avg, check, describe, note, report } from './harness.js';

const N = 40;
const cities = Array.from({ length: N }, (_, i) => buildCity(i + 1));

describe(`the grid — ${N} cities`);

note(`streets per city: ${avg(cities.map((c) => c.streets.xs.length)).toFixed(1)} north-south, ` +
  `${avg(cities.map((c) => c.streets.ys.length)).toFixed(1)} east-west, ` +
  `${cities[0].streets.width}m wide`);
note(`blocks per city: ${avg(cities.map((c) => c.blocks.length)).toFixed(0)}`);

let offStreet = 0;
for (const c of cities) for (const s of c.stops) if (!onStreet(c.streets, s)) offStreet++;
check('every station in every city is somewhere you can stand',
  offStreet === 0, `${offStreet} stranded stations`);

describe('who respects the grid');

/** A leg is on the grid if its two ends share a street. */
const onGrid = (c: typeof cities[0], a: number, b: number) => {
  const p = c.stops[a], q = c.stops[b];
  return Math.min(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= c.streets.width / 2;
};

const tally = { road: { on: 0, all: 0 }, rail: { on: 0, all: 0 } };
for (const c of cities) {
  for (const l of c.lines) {
    const bucket = l.mode === 'bus' || l.mode === 'tram' ? tally.road : tally.rail;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      bucket.all++;
      if (onGrid(c, l.stops[i], l.stops[i + 1])) bucket.on++;
    }
  }
}
check('every single bus and tram leg runs along a street',
  tally.road.on === tally.road.all, `${tally.road.on}/${tally.road.all} legs`);

/**
 * And the rail modes genuinely do NOT — if they did, the distinction would be
 * costing complexity and buying nothing, and a metro would be a fast bus.
 */
const railOff = tally.rail.all - tally.rail.on;
check('metros and trains cut straight across the city instead',
  railOff > tally.rail.all * 0.4,
  `${railOff}/${tally.rail.all} rail legs ignore the grid`);

describe('walking');

/** A point well inside a block: solid ground, and you should not get there. */
function insideBlock(c: typeof cities[0]) {
  for (const b of c.blocks) {
    if (b.w > 120 && b.h > 120) return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  return null;
}

let walkedIn = 0, tried = 0;
for (const c of cities.slice(0, 12)) {
  const target = insideBlock(c);
  if (!target) continue;
  tried++;
  // Start on the nearest street and march straight at the middle of the block.
  const start = c.stops.reduce((best, s) =>
    Math.hypot(s.x - target.x, s.y - target.y) < Math.hypot(best.x - target.x, best.y - target.y)
      ? s : best);
  const w = newBody(start.x, start.y);
  const ground = { streets: c.streets, river: c.river, transit: null };
  for (let i = 0; i < 30 * 30; i++) {
    const dx = target.x - w.x, dy = target.y - w.y;
    const len = Math.hypot(dx, dy) || 1;
    stepBody(w, { wx: dx / len, wy: dy / len, sprint: false, jump: false }, 1 / 30, ground);
  }
  if (!onStreet(c.streets, w)) walkedIn++;
}
check('you cannot walk into a building, however hard you try at it',
  walkedIn === 0, `${walkedIn} of ${tried} walked off the street`);

/** And the grid is not a cage: a diagonal should carry you round a corner. */
const c0 = cities[0];
const from = c0.stops[c0.origin];
const w = newBody(from.x, from.y);
const g0 = { streets: c0.streets, river: c0.river, transit: null };
for (let i = 0; i < 30 * 12; i++) {
  stepBody(w, { wx: 0.707, wy: 0.707, sprint: false, jump: false }, 1 / 30, g0);
}
const travelled = Math.hypot(w.x - from.x, w.y - from.y);
check('holding a diagonal walks you around blocks rather than into them',
  travelled > WALK.speed * 12 * 0.35,
  `${travelled.toFixed(0)}m of a possible ${(WALK.speed * 12).toFixed(0)}m in 12s`);

describe('what it costs to walk');

/**
 * The whole point of blocks: distance is no longer what a ruler says. If these
 * came out equal, walking would still be crossing the city as the crow flies
 * and `par` would be quoting journeys nobody can make.
 */
const detours: number[] = [];
let unreachable = 0;
for (const c of cities.slice(0, 12)) {
  const g = pedestrian(c);
  const d = walkDistances(g, g.stopNode[c.origin]);
  for (const s of c.stops) {
    const straight = Math.hypot(s.x - c.stops[c.origin].x, s.y - c.stops[c.origin].y);
    if (straight < 200) continue;
    const walk = d[g.stopNode[s.id]];
    if (!isFinite(walk)) { unreachable++; continue; }
    detours.push(walk / straight);
  }
}
note(`walking a straight line is a myth: routes average ` +
  `${avg(detours).toFixed(2)}x the distance a ruler gives`);
check('walking never beats a straight line', Math.min(...detours) >= 0.999,
  `shortest ratio ${Math.min(...detours).toFixed(3)}`);
check('and going round the blocks costs real distance', avg(detours) > 1.1,
  `avg x${avg(detours).toFixed(2)}`);
note(`${unreachable} stop pairs are unreachable on foot at all — the far bank`);

const nb = walkNeighbours(cities[0]);
const reach = nb.filter((n) => n.length > 0).length;
check('short transfers still exist once you have to walk round things',
  reach > cities[0].stops.length * 0.5,
  `${reach}/${cities[0].stops.length} stops have a walkable neighbour`);

report();
