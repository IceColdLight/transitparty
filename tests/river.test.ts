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
import { newBody, stepBody } from '../src/shared/movement.js';
import { bankOf, illegalCrossing, nearestOnRiver } from '../src/shared/river.js';
import { bridgeSites, onStreet } from '../src/shared/streets.js';
import { walkNeighbours } from '../src/shared/routing.js';
import { check, describe, note, report } from './harness.js';

const city = buildCity(9001);
const river = city.river;
describe(`the water — seed ${city.seed}`);

note(`${river.bridges.length} bridges, ${river.poly.length}-point channel`);

check('the river reaches both edges of the map, so it really divides it',
  river.poly[0].x < 0 || river.poly[0].y < 0
  || river.poly[0].x > CITY.width || river.poly[0].y > CITY.height,
  `starts at ${river.poly[0].x.toFixed(0)},${river.poly[0].y.toFixed(0)}`);

const banks = city.stops.map((s) => bankOf(river, s));
const left = banks.filter((b) => b === 1).length;
check('both banks have a real share of the city',
  Math.min(left, banks.length - left) >= banks.length * 0.2,
  `${left} / ${banks.length - left} stops`);

describe('walking into it');

/**
 * Walking is confined to the streets, so this has to be tested where a street
 * actually meets the water. `bridgeSites` lists every such place; a few were
 * chosen to carry bridges and the rest are quaysides — a road that runs into a
 * river and stops.
 */
const sites = bridgeSites(city.streets, river);
const quays = sites.filter((p) =>
  river.bridges.every((b) => Math.hypot(b.x - p.x, b.y - p.y) > 260));
note(`${sites.length} streets meet the water; ${river.bridges.length} of them carry a bridge`);
check('most streets that reach the river simply stop at it', quays.length >= 1,
  `${quays.length} quaysides`);

if (quays.length) {
  const q = quays[Math.floor(quays.length / 2)];
  /**
   * Walk along the STREET, straight at the water.
   *
   * An earlier version walked perpendicular to the RIVER, which is only the
   * same direction when the street happens to meet the water at a right
   * angle. Where it did not, the walker started in the middle of a block and
   * the test failed for reasons that had nothing to do with the river.
   */
  const h2 = city.streets.width / 2;
  const onVertical = city.streets.xs.some((x) => Math.abs(q.x - x) <= h2);
  const axis = onVertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const probe = { x: q.x + axis.x * 40, y: q.y + axis.y * 40 };
  const toward = bankOf(river, probe) === bankOf(river, q) ? -1 : 1;
  const dir = { x: axis.x * toward, y: axis.y * toward };
  const w = newBody(q.x - dir.x * 130, q.y - dir.y * 130);
  const startBank = bankOf(river, w);
  check('the test walker starts on a street', onStreet(city.streets, w),
    `${w.x.toFixed(0)},${w.y.toFixed(0)}`);

  const from = { x: w.x, y: w.y };
  const ground = { streets: city.streets, river, transit: null };
  for (let i = 0; i < 30 * 60; i++) stepBody(w, { wx: dir.x, wy: dir.y, sprint: false, jump: false }, 1 / 30, ground);
  check('you cannot walk across the river where there is no bridge',
    bankOf(river, w) === startBank,
    `walked ${Math.hypot(w.x - from.x, w.y - from.y).toFixed(0)}m up the road and stopped at the water`);
}

describe('crossing at a bridge');

let bridged = 0;
for (const b of river.bridges) {
  const near = nearestOnRiver(river, { x: b.x + 1, y: b.y });
  const len = Math.hypot(b.x - near.x, b.y - near.y) || 1;
  const dir = { x: -(b.y - near.y) / len, y: (b.x - near.x) / len };
  const w = newBody(b.x - dir.x * 90, b.y - dir.y * 90);
  const startBank = bankOf(river, w);
  const ground = { streets: city.streets, river, transit: null };
  for (let i = 0; i < 30 * 120; i++) {
    stepBody(w, { wx: dir.x, wy: dir.y, sprint: false, jump: false }, 1 / 30, ground);
    if (bankOf(river, w) !== startBank) break;
  }
  if (bankOf(river, w) !== startBank) bridged++;
}
check('every bridge actually gets you to the other side',
  bridged === river.bridges.length, `${bridged}/${river.bridges.length}`);
check('and every bridge is on a street, not in the middle of a block',
  river.bridges.every((b) => onStreet(city.streets, b)), `${river.bridges.length} bridges`);

describe('the planner knows about it');

const nb = walkNeighbours(city);
let bogus = 0;
for (let i = 0; i < city.stops.length; i++) {
  for (const w of nb[i]) {
    if (illegalCrossing(river, city.stops[i], city.stops[w.to], CITY.bridgeRadius)) bogus++;
  }
}
check('no walking transfer in the planner crosses open water', bogus === 0, `${bogus} bogus edges`);

/**
 * The good moment the river buys: two stops close enough to stroll between and
 * no way to do it. It does not happen in every city — the water has to run
 * past a pair of stations for it to — and it should not be forced, but if it
 * stops happening at all the riverside has quietly been emptied.
 */
let citiesWithCut = 0, blocked = 0;
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
