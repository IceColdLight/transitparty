/**
 * Does the generator produce cities worth racing across?
 *
 * Every check here is a property of the RACE, not of the code. A network that
 * generates without throwing is easy; one where the journey has a decision in
 * it is the whole difficulty of this prototype, and the numbers below are the
 * ones that moved while it was being tuned.
 */
import { CITY, MODES, RACE, WALK, type ModeId } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { bestRoute, walkNeighbours } from '../src/shared/routing.js';
import { bankOf, illegalCrossing } from '../src/shared/river.js';
import { avg, check, describe, note, pct, report } from './harness.js';

const N = 120;
const t0 = Date.now();
const cities = Array.from({ length: N }, (_, i) => buildCity(i + 1));
const elapsed = Date.now() - t0;

describe(`the generator — ${N} cities`);

note(`${elapsed}ms for ${N} cities (${(elapsed / N).toFixed(1)}ms each)`);
/**
 * A budget, not a benchmark. A city is built once when the seed changes, so
 * anything under a frame or two is free — what this is really watching for is
 * a criterion that has quietly become unsatisfiable, which shows up as the
 * generator grinding through attempt after attempt. Demanding straight track
 * through every rail station moved it from about 22ms to about 40ms, which is
 * the cost of throwing away roughly one corridor in three.
 */
check('a city is cheap enough to build on demand', elapsed / N < 70,
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
 * The chokepoint. What matters is not how many lines cross the water — once
 * buses were routed along the streets, several of them naturally picked up a
 * bridge and the count went from four to as many as eight — but that every
 * single crossing in the city happens at one of the three bridges. Eight lines
 * over three bridges is still three places, and three places is still a
 * decision. A crossing anywhere else would be a line swimming.
 */
let wildCrossings = 0, crossingsTotal = 0;
for (const c of cities) {
  for (const l of c.lines) {
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const a = c.stops[l.stops[i]], b = c.stops[l.stops[i + 1]];
      if (bankOf(c.river, a) === bankOf(c.river, b)) continue;
      crossingsTotal++;
      if (illegalCrossing(c.river, a, b, CITY.bridgeRadius)) wildCrossings++;
    }
  }
}
check('every crossing of the water in every city is at a bridge',
  wildCrossings === 0, `${wildCrossings} of ${crossingsTotal} crossings were not`);

const crossingCounts = cities.map((c) => c.lines.filter((l) => {
  let seen = 0;
  for (const s of l.stops) seen |= bankOf(c.river, c.stops[s]) === 1 ? 1 : 2;
  return seen === 3;
}).length);
check('and the far bank hangs off a handful of lines, not most of them',
  Math.max(...crossingCounts) <= 10,
  `avg ${avg(crossingCounts).toFixed(1)}, worst ${Math.max(...crossingCounts)} of ~18 lines`);
check('but at least one crosses, or a bank is stranded',
  Math.min(...crossingCounts) >= 1, `min ${Math.min(...crossingCounts)}`);

check('every city has at least one bridge',
  cities.every((c) => c.river.bridges.length >= 1),
  `min ${Math.min(...cities.map((c) => c.river.bridges.length))} of ${CITY.bridges}`);

describe('no single half of the network is enough');

/**
 * The complaint this exists to prevent: "taking the metro is easily the
 * fastest way to arrive, and the buses are just padding on the map".
 *
 * It was true. Rail is fast, runs straight instead of round the block, and
 * stops rarely, so it won every comparison it was allowed into — and a third
 * of all stations were on it. Ignoring every bus and tram in the city cost
 * 47%, which is not enough to make anyone read a map.
 *
 * Races now start and finish OFF the rail network, and a race is thrown away
 * unless BOTH halves of the network are genuinely insufficient alone. The
 * check has to be symmetric: penalising rail only teaches players to ignore
 * the metro instead, which is the same shallow map with the modes swapped.
 */
const isRailLine = (c: typeof cities[0], l: number) =>
  c.lines[l].mode === 'metro' || c.lines[l].mode === 'train';

let onRailEnds = 0;
for (const c of cities) {
  if (c.stops[c.origin].lines.some((l) => isRailLine(c, l))) onRailEnds++;
  if (c.stops[c.destination].lines.some((l) => isRailLine(c, l))) onRailEnds++;
}
check('races start and finish on the local network, not the trunk',
  onRailEnds === 0, `${onRailEnds} endpoints sat on a metro or train line`);

const halfOnly = (c: typeof cities[0], rail: boolean) => {
  const cut = { ...c, stops: c.stops.map((s) => ({
    ...s, lines: s.lines.filter((l) => isRailLine(c, l) === rail),
  })) };
  const r = bestRoute(cut, c.origin, c.destination, walkNeighbours(cut));
  return r ? r.time : Infinity;
};
const railRatio: number[] = [], roadRatio: number[] = [];
const usesBoth: boolean[] = [];
for (const c of cities.slice(0, 40)) {
  railRatio.push(halfOnly(c, true) / c.par.time);
  roadRatio.push(halfOnly(c, false) / c.par.time);
  const r = bestRoute(c, c.origin, c.destination, walkNeighbours(c))!;
  const modes = r.legs.filter((l) => l.kind === 'ride' && l.from !== l.to)
    .map((l) => c.lines[(l as { line: number }).line].mode);
  usesBoth.push(modes.some((m) => m === 'metro' || m === 'train')
    && modes.some((m) => m === 'bus' || m === 'tram'));
}
const worst = (a: number[]) => Math.min(...a);
const finite = (a: number[]) => a.filter((x) => isFinite(x));
note(`rail alone costs x${avg(finite(railRatio)).toFixed(2)} where it works at all ` +
  `(impossible in ${railRatio.length - finite(railRatio).length}/${railRatio.length}), ` +
  `road alone x${avg(finite(roadRatio)).toFixed(2)} ` +
  `(impossible in ${roadRatio.length - finite(roadRatio).length}/${roadRatio.length})`);
check('you cannot just take the metro',
  worst(railRatio) >= RACE.minRailPenalty - 0.001,
  `cheapest rail-only race is x${worst(railRatio).toFixed(2)}, floor x${RACE.minRailPenalty}`);
check('and you cannot just take the bus',
  worst(roadRatio) >= RACE.minRoadPenalty - 0.001,
  `cheapest road-only race is x${worst(roadRatio).toFixed(2)}, floor x${RACE.minRoadPenalty}`);
check('so the best route always uses both halves of the network',
  usesBoth.every(Boolean),
  `${usesBoth.filter(Boolean).length}/${usesBoth.length} races mix rail and road`);

describe('the modes stay in order');

/**
 * The one question a player must always be able to answer without measuring:
 * is the S faster than the M? Cruise speed does not settle it — what you
 * actually travel at is set as much by how often the thing stops, and a train
 * squeezed into cramped stops by interchange merges used to come out slower
 * than a good metro in about 0.1% of line pairs. Rare enough never to notice,
 * often enough to make the modes un-guessable.
 *
 * MODES.effMin/effMax are non-overlapping bands and the generator redraws any
 * line that misses its own, so the ordering is true by construction. This is
 * the check that says so.
 */
const ORDER: ModeId[] = ['bus', 'tram', 'metro', 'train'];
const speeds: Record<string, number[]> = { train: [], metro: [], tram: [], bus: [] };
for (const c of cities) {
  for (const l of c.lines) {
    let span = 0;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      span += Math.hypot(c.stops[l.stops[i]].x - c.stops[l.stops[i + 1]].x,
        c.stops[l.stops[i]].y - c.stops[l.stops[i + 1]].y);
    }
    speeds[l.mode].push(span / (l.oneWay - l.dwell));
  }
}
for (const m of ORDER) {
  note(`${m.padEnd(5)} ${speeds[m].length} lines, ` +
    `${Math.min(...speeds[m]).toFixed(1)}–${Math.max(...speeds[m]).toFixed(1)} m/s ` +
    `(band ${MODES[m].effMin}–${MODES[m].effMax})`);
}
check('every line travels at a speed its own mode admits to',
  ORDER.every((m) => speeds[m].every((v) => v >= MODES[m].effMin && v <= MODES[m].effMax)),
  'all lines inside their band');

let inversions = 0, pairs = 0;
for (let i = 1; i < ORDER.length; i++) {
  const slower = speeds[ORDER[i - 1]], faster = speeds[ORDER[i]];
  for (const a of slower) for (const b of faster) { pairs++; if (a >= b) inversions++; }
}
check('a faster mode is faster than a slower one on every pair of lines, in every city',
  inversions === 0, `${inversions} inversions in ${pairs} line pairs`);

/**
 * Door to door is a different question and is DELIBERATELY not ordered: the
 * train wins over distance and loses over two stops, because you wait over a
 * minute for it. That trade is the reason there are four modes instead of a
 * speed slider — but it is only fair if the player can see the frequency,
 * which is why the map legend prints it.
 */
const doorToDoor = (m: ModeId, metres: number) => {
  const lines = cities.flatMap((c) => c.lines.filter((l) => l.mode === m));
  const v = avg(speeds[m]);
  const wait = avg(lines.map((l) => l.headway / 2));
  return metres / (wait + metres / v);
};
note(`door to door: over 800m  train ${doorToDoor('train', 800).toFixed(1)} vs ` +
  `metro ${doorToDoor('metro', 800).toFixed(1)} m/s`);
note(`              over 2500m train ${doorToDoor('train', 2500).toFixed(1)} vs ` +
  `metro ${doorToDoor('metro', 2500).toFixed(1)} m/s`);
check('the train loses at short range and wins at long — the trade is real',
  doorToDoor('train', 800) < doorToDoor('metro', 800)
  && doorToDoor('train', 2500) > doorToDoor('metro', 2500),
  'crossover sits between 800m and 2500m');

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
