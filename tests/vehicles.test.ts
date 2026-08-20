/**
 * The timetable.
 *
 * Vehicles are never simulated — they are evaluated from the clock — which
 * makes them exactly reproducible and therefore worth testing hard. The
 * failures this catches are the invisible sort: a fleet that bunches so half
 * the map is unreachable for two minutes at a stretch, a door that is never
 * open long enough to board, a run that skips a stop entirely.
 */
import { MODES, TEMPO } from '../src/shared/constants.js';
import { onStreet } from '../src/shared/streets.js';
import { buildCity } from '../src/shared/city.js';
import {
  allVehicles, departures, overVehicle, remainingStops, vehicleById,
} from '../src/shared/vehicles.js';
import { avg, check, describe, near, note, report } from './harness.js';

const city = buildCity(31337);
describe(`one city's fleet — seed ${city.seed}`);

const fleet = allVehicles(city, 0);
note(`${city.lines.length} lines, ${fleet.length} vehicles on the road`);
check('every line has at least one vehicle',
  city.lines.every((l) => l.fleet >= 1),
  `min ${Math.min(...city.lines.map((l) => l.fleet))}`);

check('the real headway is the cycle divided by a whole fleet',
  city.lines.every((l) => Math.abs(l.headway * l.fleet - l.cycle) < 1e-6),
  'exact on every line');

/**
 * The headway a mode advertises and the headway it runs are not the same
 * number — the fleet is an integer. What matters is that the rounding never
 * turns a metro into a train.
 */
const drift = city.lines.map((l) => l.headway / MODES[l.mode].headway);
check('rounding the fleet never doubles a line\'s headway',
  Math.max(...drift) < 1.6 && Math.min(...drift) > 0.6,
  `x${Math.min(...drift).toFixed(2)}–x${Math.max(...drift).toFixed(2)} of target`);

describe('a vehicle over one full cycle');

const line = city.lines.find((l) => l.mode === 'metro')!;
const step = 0.25;
const visited = new Set<number>();
let doorSeconds = 0;
let jumps = 0;
let prev = vehicleById(city, `${line.id}.0`, 0)!;
for (let t = step; t <= line.cycle; t += step) {
  const v = vehicleById(city, `${line.id}.0`, t)!;
  if (v.atStop >= 0) { visited.add(v.atStop); doorSeconds += step; }
  const moved = Math.hypot(v.x - prev.x, v.y - prev.y);
  // The fastest thing in the city is a train; nothing may teleport.
  if (moved > MODES.train.speed * step * 3) jumps++;
  prev = v;
}
check('a run calls at every stop on its line',
  visited.size === line.stops.length, `${visited.size}/${line.stops.length} on ${line.name}`);
check('and never teleports between two samples', jumps === 0, `${jumps} jumps`);

// Out and back means both termini get a double dwell — the turnaround.
const expectedDoors = line.stops.length * line.dwell * 2;
near('door time per cycle is one dwell per stop, each way', doorSeconds, expectedDoors, 1);

describe('boarding windows');

let shortest = Infinity;
for (const l of city.lines) {
  const s = l.stops[Math.floor(l.stops.length / 2)];
  let open = 0;
  for (let t = 0; t < l.cycle; t += 0.25) {
    const v = vehicleById(city, `${l.id}.0`, t)!;
    if (v.atStop === s) open += 0.25;
  }
  // An intermediate stop is called at twice per cycle, once each way.
  shortest = Math.min(shortest, open / 2);
}
/**
 * Dwell is the one duration that does NOT divide by TEMPO — it is a human
 * reaction window, not a simulation figure, and human reactions do not speed
 * up when the game does. So this threshold stays in absolute seconds however
 * fast the city runs, and it is the check that catches somebody "tidying up"
 * by scaling dwell along with everything else: at TEMPO 3 that would leave a
 * bus door open for 1.7 seconds.
 */
check('the doors are open long enough to run for them',
  shortest >= 3.5, `shortest window ${shortest.toFixed(1)}s, and it does not scale with TEMPO`);

describe('spacing — the reason the fleet is an integer');

const busy = city.stops.reduce((a, b) => (b.lines.length > a.lines.length ? b : a));
const gaps: number[] = [];
for (const lineId of busy.lines) {
  const l = city.lines[lineId];
  const times: number[] = [];
  for (let t = 0; t < l.cycle; t += 0.5) {
    const here = [];
    for (let run = 0; run < l.fleet; run++) {
      const v = vehicleById(city, `${l.id}.${run}`, t)!;
      if (v.atStop === busy.id) here.push(run);
    }
    if (here.length) times.push(t);
  }
  // Collapse each dwell into one arrival, then measure the gaps between them.
  const arrivals = times.filter((t, i) => i === 0 || t - times[i - 1] > 1);
  for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i] - arrivals[i - 1]);
}
note(`at ${busy.name} (${busy.lines.length} lines): ` +
  `gaps ${Math.min(...gaps).toFixed(0)}–${Math.max(...gaps).toFixed(0)}s, avg ${avg(gaps).toFixed(0)}s`);
check('no gap at a busy interchange is a punishing outlier',
  Math.max(...gaps) < 210 / TEMPO, `worst ${Math.max(...gaps).toFixed(0)}s, budget ${(210 / TEMPO).toFixed(0)}s`);

describe('traffic that does not drive through itself');

/**
 * Vehicle position is a pure function of the timetable and nothing avoids
 * anything else, so every line calling at a stop used to park in the same
 * three metres of road and every pair sharing a street drove through each
 * other. Top-down that was untidy; in first person it made a chokepoint
 * unreadable — you could not tell what was there, let alone pick the one you
 * wanted.
 *
 * LANES fixes it by displacing each line sideways, flipping the displacement
 * with the direction of travel so the city drives on one side. What is
 * measured here is the thing a player sees: how often one vehicle's centre is
 * inside another's bodywork.
 */
{
  let clashes = 0, headOn = 0, pairs = 0;
  for (const t2 of [0, 37, 74, 111, 148, 185, 222, 259]) {
    const fleet = allVehicles(city, t2);
    for (let i = 0; i < fleet.length; i++) {
      for (let j = i + 1; j < fleet.length; j++) {
        const a = fleet[i], b2 = fleet[j];
        if (Math.abs(a.x - b2.x) > 50 || Math.abs(a.y - b2.y) > 50) continue;
        pairs++;
        if (!overVehicle(city, a, b2.x, b2.y) && !overVehicle(city, b2, a.x, a.y)) continue;
        clashes++;
        // Nose to nose is the one that should be impossible: opposing traffic
        // is on opposite sides of the road by construction.
        const facing = Math.cos(a.angle - b2.angle);
        if (facing < -0.5) headOn++;
      }
    }
  }
  note(`${clashes} of ${pairs} nearby vehicle pairs interpenetrate, ${headOn} of them head-on`);
  check('opposing traffic never drives through itself',
    headOn === 0, `${headOn} head-on clashes`);
  check('and interpenetration is rare enough to read a street',
    clashes <= pairs * 0.02, `${(100 * clashes / Math.max(1, pairs)).toFixed(2)}% of nearby pairs`);
}

/**
 * A bus is on the road. Obvious, untested, and briefly untrue.
 *
 * Stands are offsets along the kerb, and applying one to a line's whole path
 * rather than only to where it stops dragged the route with it: a stand 27m up
 * a north-south street and the next one 27m along an east-west street put the
 * straight line between them across the middle of a block. Buses drove through
 * buildings, and — because a player standing off the street gets walked back
 * onto it — anybody riding one had their velocity wiped every tick.
 */
{
  const half = city.streets.width / 2;
  let worst = 0, checked = 0, strays = 0;
  for (let t2 = 0; t2 < 240; t2 += 2) {
    for (const v of allVehicles(city, t2)) {
      if (city.lines[v.line].mode !== 'bus' && city.lines[v.line].mode !== 'tram') continue;
      checked++;
      if (onStreet(city.streets, v)) continue;
      strays++;
      const dx = Math.min(...city.streets.xs.map((x) => Math.abs(v.x - x)));
      const dy = Math.min(...city.streets.ys.map((y) => Math.abs(v.y - y)));
      worst = Math.max(worst, Math.min(dx, dy) - half);
    }
  }
  note(`${strays} of ${checked} samples overhang the kerb, worst by ${worst.toFixed(1)}m`);
  // A wheel over the kerb at a corner is invisible. Being tens of metres out —
  // which is what the bug did — is a bus in the middle of a block.
  check('a bus or a tram never leaves the road it is driving on',
    worst < 4, `worst overshoot ${worst.toFixed(1)}m of a ${city.streets.width}m road`);
}

describe('the departure board');

const stop = city.stops.find((s) => s.lines.length >= 2)!;
const rows = departures(city, stop.id, 100, 900 / TEMPO);
check('the board lists something for every line calling here',
  new Set(rows.map((r) => r.line)).size === stop.lines.length,
  `${new Set(rows.map((r) => r.line)).size}/${stop.lines.length} lines at ${stop.name}`);
check('it is sorted soonest first',
  rows.every((r, i) => i === 0 || r.in >= rows[i - 1].in));

let honest = 0;
for (const r of rows) {
  const v = vehicleById(city, r.vehicle, 100 + r.in)!;
  if (v.atStop === stop.id) honest++;
}
check('and every departure it promises actually turns up',
  honest === rows.length, `${honest}/${rows.length}`);

describe('what a rider can see');

const v = vehicleById(city, `${line.id}.0`, 40)!;
const ahead = remainingStops(city, v);
check('the stops ahead are all on this line',
  ahead.every((s) => line.stops.includes(s)), `${ahead.length} ahead`);
check('and it never claims it is going somewhere it has just been',
  !ahead.includes(v.atStop), `at ${v.atStop >= 0 ? city.stops[v.atStop].name : 'speed'}`);

describe('purity');

check('the same clock gives the identical fleet, twice',
  JSON.stringify(allVehicles(city, 123.456)) === JSON.stringify(allVehicles(city, 123.456)));
// Millimetres, not bytes: one cycle of accumulated float error is about
// 5e-13 metres, and a test that calls that a failure is a test nobody trusts.
const before = vehicleById(city, `${line.id}.0`, 10)!;
const after = vehicleById(city, `${line.id}.0`, 10 + line.cycle)!;
check('and a cycle later a line is exactly where it started',
  Math.hypot(after.x - before.x, after.y - before.y) < 1e-6
  && after.atStop === before.atStop && after.dir === before.dir,
  `cycle ${line.cycle.toFixed(1)}s, drift ${Math.hypot(after.x - before.x, after.y - before.y).toExponential(1)}m`);

report();
