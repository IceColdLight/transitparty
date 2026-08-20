/**
 * The river, the bridges, and walking into both.
 *
 * The river exists to stop the network being a mesh — see src/shared/river.ts
 * for the measurement that forced it in. These checks hold the two halves of
 * that: that the water genuinely blocks a walk, and that a bridge genuinely
 * does not, because a barrier you cannot cross anywhere is a bug and one you
 * can cross anywhere is scenery.
 */
import { CITY, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { stepWalk, type Walker } from '../src/shared/movement.js';
import { bankOf, illegalCrossing, nearestOnRiver } from '../src/shared/river.js';
import { walkNeighbours } from '../src/shared/routing.js';
import { check, describe, note, report } from './harness.js';

const city = buildCity(9001);
const river = city.river;
describe(`the water — seed ${city.seed}`);

note(`${river.bridges.length} bridges, ${river.poly.length}-point channel`);

check('the river reaches both edges of the map, so it really divides it',
  river.poly[0].x < 0 || river.poly[0].y < 0 || river.poly[0].x > CITY.width || river.poly[0].y > CITY.height,
  `starts at ${river.poly[0].x.toFixed(0)},${river.poly[0].y.toFixed(0)}`);

const banks = city.stops.map((s) => bankOf(river, s));
const left = banks.filter((b) => b === 1).length;
check('both banks have a real share of the city',
  Math.min(left, banks.length - left) >= banks.length * 0.2,
  `${left} / ${banks.length - left} stops`);

describe('walking into it');

/** Two points straight across the water, far from any bridge. */
function crossingPair(): [Walker, { x: number; y: number }] | null {
  const total = river.poly.length;
  for (let i = 3; i < total - 3; i++) {
    const p = river.poly[i];
    if (p.x < 200 || p.x > CITY.width - 200 || p.y < 200 || p.y > CITY.height - 200) continue;
    let clearOfBridges = true;
    for (const b of river.bridges) if (Math.hypot(b.x - p.x, b.y - p.y) < 400) clearOfBridges = false;
    if (!clearOfBridges) continue;
    const q = river.poly[i + 1];
    const nx = -(q.y - p.y), ny = q.x - p.x;
    const len = Math.hypot(nx, ny) || 1;
    return [
      { x: p.x - (nx / len) * 120, y: p.y - (ny / len) * 120, vx: 0, vy: 0 },
      { x: p.x + (nx / len) * 120, y: p.y + (ny / len) * 120 },
    ];
  }
  return null;
}

const pair = crossingPair();
check('the map has a stretch of open water to test against', pair !== null);

if (pair) {
  const [start, target] = pair;
  const startBank = bankOf(river, start);
  check('the two test points are on opposite banks',
    startBank !== bankOf(river, target), `${startBank} vs ${bankOf(river, target)}`);

  const w: Walker = { ...start };
  const dx = target.x - w.x, dy = target.y - w.y;
  const len = Math.hypot(dx, dy);
  // Walk straight at the far bank for a minute, which is four times as long
  // as it would take on dry land.
  for (let i = 0; i < 60 / (1 / 30); i++) stepWalk(w, dx / len, dy / len, 1 / 30, river);
  check('you cannot walk across the river away from a bridge',
    bankOf(river, w) === startBank,
    `ended ${Math.hypot(w.x - start.x, w.y - start.y).toFixed(0)}m along, still on bank ${bankOf(river, w)}`);

  // And having been stopped, you are not welded to the spot: the axis-split
  // retry has to leave you sliding along the bank towards a bridge.
  const slid: Walker = { ...start };
  const along = { x: -dy / len, y: dx / len };
  for (let i = 0; i < 300; i++) stepWalk(slid, (dx / len + along.x) / 1.414, (dy / len + along.y) / 1.414, 1 / 30, river);
  check('but a diagonal into the bank slides you along it rather than sticking',
    Math.hypot(slid.x - start.x, slid.y - start.y) > 12,
    `${Math.hypot(slid.x - start.x, slid.y - start.y).toFixed(0)}m travelled in 10s`);
}

describe('crossing at a bridge');

let bridged = 0;
for (const b of river.bridges) {
  const near = nearestOnRiver(river, { x: b.x + 1, y: b.y });
  const nx = b.x - near.x, ny = b.y - near.y;
  const len = Math.hypot(nx, ny) || 1;
  // Approach along the deck: perpendicular to the water at the bridge.
  const dir = { x: -ny / len, y: nx / len };
  const w: Walker = { x: b.x - dir.x * 90, y: b.y - dir.y * 90, vx: 0, vy: 0 };
  const startBank = bankOf(river, w);
  for (let i = 0; i < 30 * 120; i++) {
    stepWalk(w, dir.x, dir.y, 1 / 30, river);
    if (bankOf(river, w) !== startBank) break;
  }
  if (bankOf(river, w) !== startBank) bridged++;
}
check('every bridge actually gets you to the other side',
  bridged === river.bridges.length, `${bridged}/${river.bridges.length}`);

describe('the planner knows about it');

const nb = walkNeighbours(city);
let bogus = 0, blocked = 0;
for (let i = 0; i < city.stops.length; i++) {
  for (const w of nb[i]) {
    if (illegalCrossing(river, city.stops[i], city.stops[w.to], CITY.bridgeRadius)) bogus++;
  }
}
check('no walking transfer in the planner crosses open water', bogus === 0, `${bogus} bogus edges`);

/**
 * The good moment the river buys: two stops close enough to stroll between
 * and no way to do it. It does not happen in every city — the water has to
 * run past a pair of stations for it to — and it should not be forced, but if
 * it stops happening at all the riverside has quietly been emptied again.
 */
let citiesWithCut = 0;
const SEEDS = 40;
for (let seed = 1; seed <= SEEDS; seed++) {
  const c = buildCity(seed);
  let cut = 0;
  for (let i = 0; i < c.stops.length; i++) {
    for (let j = i + 1; j < c.stops.length; j++) {
      const d = Math.hypot(c.stops[i].x - c.stops[j].x, c.stops[i].y - c.stops[j].y);
      if (d > WALK.transferMax) continue;
      if (illegalCrossing(c.river, c.stops[i], c.stops[j], CITY.bridgeRadius)) cut++;
    }
  }
  blocked += cut;
  if (cut > 0) citiesWithCut++;
}
note(`${blocked} pairs across ${SEEDS} cities are within ${WALK.transferMax}m and still not walkable`);
check('the water strands a near-neighbour often enough to be a real hazard',
  citiesWithCut >= SEEDS * 0.25, `${citiesWithCut}/${SEEDS} cities have at least one`);

report();
