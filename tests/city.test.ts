/**
 * Does the generator produce cities worth racing across?
 *
 * Every check here is a property of the RACE, not of the code. A network that
 * generates without throwing is easy; one where the journey has a decision in
 * it is the whole difficulty of this prototype, and the numbers below are the
 * ones that moved while it was being tuned.
 */
import { CITY, RACE, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { bestRoute, walkNeighbours } from '../src/shared/routing.js';
import { bankOf } from '../src/shared/river.js';
import { avg, check, describe, note, pct, report } from './harness.js';

const N = 120;
const t0 = Date.now();
const cities = Array.from({ length: N }, (_, i) => buildCity(i + 1));
const elapsed = Date.now() - t0;

describe(`the generator — ${N} cities`);

note(`${elapsed}ms for ${N} cities (${(elapsed / N).toFixed(1)}ms each)`);
check('a city is cheap enough to build on demand', elapsed / N < 40,
  `${(elapsed / N).toFixed(1)}ms each, budget 40ms`);

const strict = cities.filter((c) => c.par.strict).length;
check('every city meets the race criteria without falling back',
  strict === N, `${strict}/${N} strict (${pct(strict, N)})`);
note(`attempts per city: avg ${avg(cities.map((c) => c.par.attempts)).toFixed(2)}, ` +
  `worst ${Math.max(...cities.map((c) => c.par.attempts))}`);

describe('the journey');

const transfers = cities.map((c) => c.par.transfers);
check(`the optimal route needs at least ${RACE.minTransfers} changes`,
  Math.min(...transfers) >= RACE.minTransfers,
  `min ${Math.min(...transfers)}, avg ${avg(transfers).toFixed(2)}, max ${Math.max(...transfers)}`);

const pars = cities.map((c) => c.par.time);
check('par lands inside the window on every seed',
  pars.every((p) => p >= RACE.parMin && p <= RACE.parMax),
  `${Math.min(...pars).toFixed(0)}–${Math.max(...pars).toFixed(0)}s, ` +
  `window ${RACE.parMin}–${RACE.parMax}, avg ${avg(pars).toFixed(0)}s`);

check('par fits inside the round timer with room to be bad at it',
  Math.max(...pars) < RACE.roundSeconds * 0.85,
  `worst par ${Math.max(...pars).toFixed(0)}s of ${RACE.roundSeconds}s`);

const ratios = cities.map((c) => c.par.walk / c.par.time);
check('riding always beats walking by the required margin',
  Math.min(...ratios) >= RACE.minWalkRatio,
  `min x${Math.min(...ratios).toFixed(2)}, avg x${avg(ratios).toFixed(2)}, floor x${RACE.minWalkRatio}`);

/**
 * The reason the city has a river at all. Every race crosses it, so the
 * crossing is a decision at the top of every route rather than a detail.
 */
const crossers = cities.filter((c) =>
  bankOf(c.river, c.stops[c.origin]) !== bankOf(c.river, c.stops[c.destination])).length;
check('every race crosses the water', crossers === N, `${crossers}/${N}`);

const startChoice = cities.filter((c) => c.stops[c.origin].lines.length >= 2).length;
check('the round opens on a decision — the origin has more than one line',
  startChoice === N, `${startChoice}/${N}`);

describe('the network');

const stopCounts = cities.map((c) => c.stops.length);
note(`stops: avg ${avg(stopCounts).toFixed(0)}, range ${Math.min(...stopCounts)}–${Math.max(...stopCounts)}`);
check('every city has a network worth reading', Math.min(...stopCounts) >= 40,
  `smallest ${Math.min(...stopCounts)} stops`);

const inter = cities.map((c) => c.stops.filter((s) => s.lines.length > 1).length);
check('interchanges emerge from geography, and there are plenty',
  Math.min(...inter) >= 8, `avg ${avg(inter).toFixed(1)}, min ${Math.min(...inter)}`);

let orphan = 0, repeats = 0, tooShort = 0, badLegs = 0;
for (const c of cities) {
  for (const s of c.stops) if (s.lines.length === 0) orphan++;
  for (const l of c.lines) {
    if (new Set(l.stops).size !== l.stops.length) repeats++;
    if (l.stops.length < 3) tooShort++;
    if (l.legs.length !== l.stops.length - 1) badLegs++;
    if (l.legs.some((x) => !(x > 0))) badLegs++;
  }
}
check('no stop exists that nothing calls at', orphan === 0, `${orphan} orphans`);
check('no line calls at the same station twice', repeats === 0, `${repeats} lines`);
check('no line is shorter than three stops', tooShort === 0, `${tooShort} lines`);
check('every line has one leg per gap, all positive', badLegs === 0, `${badLegs} bad`);

/**
 * Only a handful of lines get over the water. This is the chokepoint the
 * first cities lacked; if it drifts upward the network goes back to being a
 * mesh and the optimal route collapses to one change.
 */
const crossingCounts = cities.map((c) => c.lines.filter((l) => {
  let seen = 0;
  for (const s of l.stops) seen |= bankOf(c.river, c.stops[s]) === 1 ? 1 : 2;
  return seen === 3;
}).length);
check('only a few lines cross the river', Math.max(...crossingCounts) <= 7,
  `avg ${avg(crossingCounts).toFixed(1)}, worst ${Math.max(...crossingCounts)} of ~18 lines`);
check('but at least one does, or a bank is stranded',
  Math.min(...crossingCounts) >= 1, `min ${Math.min(...crossingCounts)}`);

check('every city has at least one bridge',
  cities.every((c) => c.river.bridges.length >= 1),
  `min ${Math.min(...cities.map((c) => c.river.bridges.length))} of ${CITY.bridges}`);

describe('reachability');

let unreachable = 0;
const walkOnly: number[] = [];
for (const c of cities) {
  const nb = walkNeighbours(c);
  const r = bestRoute(c, c.origin, c.destination, nb);
  if (!r) { unreachable++; continue; }
  // A route made only of walking is a race the network lost.
  if (r.legs.every((l) => l.kind === 'walk')) walkOnly.push(c.seed);
}
check('the destination is always reachable from the origin', unreachable === 0, `${unreachable} failed`);
check('and never best reached on foot alone', walkOnly.length === 0, `${walkOnly.length} cities`);

describe('determinism');

const a = buildCity(4242), b = buildCity(4242);
check('the same seed builds the identical city',
  JSON.stringify(a) === JSON.stringify(b), 'byte-identical');
check('and a different seed does not', JSON.stringify(buildCity(4243)) !== JSON.stringify(a));
note(`sample: ${a.stops[a.origin].name} → ${a.stops[a.destination].name}, ` +
  `par ${a.par.time.toFixed(0)}s, ${a.par.transfers} changes, ` +
  `walking it ${(a.par.walk / 60).toFixed(1)} min at ${WALK.speed} m/s`);

report();
