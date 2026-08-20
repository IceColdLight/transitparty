/**
 * End to end: put a perfect passenger in the city and see if the race works.
 *
 * `par` comes from a planner that charges an average half-headway for every
 * boarding. This suite does something harder and more honest — it takes the
 * planned route and actually rides it against the real timetable, waiting for
 * the vehicle that is really coming, which is what a player with the live
 * departure board in front of them is doing. If the plan cannot be followed,
 * or following it is slower than walking, there is no game here.
 */
import { RACE, TEMPO, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { bestRoute, walkNeighbours } from '../src/shared/routing.js';
import { allVehicles, departures, remainingStops, vehicleById } from '../src/shared/vehicles.js';
import type { City } from '../src/shared/types.js';
import { avg, check, describe, note, report } from './harness.js';

/** Ride the planner's route against the real timetable, starting at `t0`. */
function ride(city: City, t0: number): { time: number; waited: number; boards: number } | null {
  const route = bestRoute(city, city.origin, city.destination);
  if (!route) return null;
  let t = t0;
  let waited = 0;
  let boards = 0;
  let at = city.origin;

  for (const leg of route.legs) {
    if (leg.kind === 'walk') { t += leg.time; at = leg.to; continue; }
    if (leg.from === leg.to) continue;  // a board with no ride after it
    if (at !== leg.from) return null;

    const line = city.lines[leg.line];
    let run = -1, boardedAt = -1;
    for (let dt = 0; dt <= 900 / TEMPO && run < 0; dt += 0.5) {
      for (let k = 0; k < line.fleet; k++) {
        const v = vehicleById(city, `${line.id}.${k}`, t + dt)!;
        // The doors have to be open AND it has to be going your way. Boarding
        // something heading for the terminus behind you is the single most
        // common way to lose one of these races.
        if (v.atStop === leg.from && remainingStops(city, v).includes(leg.to)) {
          run = k; boardedAt = t + dt; break;
        }
      }
    }
    if (run < 0) return null;
    waited += boardedAt - t;
    boards++;

    let arrived = -1;
    for (let dt = 0.5; dt <= 900 / TEMPO; dt += 0.5) {
      const v = vehicleById(city, `${line.id}.${run}`, boardedAt + dt)!;
      if (v.atStop === leg.to) { arrived = boardedAt + dt; break; }
    }
    if (arrived < 0) return null;
    t = arrived;
    at = leg.to;
  }
  return at === city.destination ? { time: t - t0, waited, boards } : null;
}

const N = 40;
const cities = Array.from({ length: N }, (_, i) => buildCity(i + 1));

describe(`riding the plan for real — ${N} cities`);

const runs = cities.map((c) => ride(c, 0));
const ok = runs.filter((r) => r !== null).length;
check('the planned route can actually be ridden, in every city',
  ok === N, `${ok}/${N} completed`);

const times = runs.filter(Boolean).map((r) => r!.time);
const waits = runs.filter(Boolean).map((r) => r!.waited);
const boards = runs.filter(Boolean).map((r) => r!.boards);
note(`journey: avg ${avg(times).toFixed(0)}s, range ${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)}s`);
note(`of which waiting: avg ${avg(waits).toFixed(0)}s over ${avg(boards).toFixed(1)} boardings`);

check('a perfect run always fits inside the round timer',
  Math.max(...times) < RACE.roundSeconds,
  `worst ${Math.max(...times).toFixed(0)}s of ${RACE.roundSeconds}s`);

const walks = cities.map((c) => c.par.walk);
const beat = times.map((t, i) => walks[i] / t);
check('riding beats walking every single time',
  Math.min(...beat) > 1.5,
  `worst x${Math.min(...beat).toFixed(2)}, avg x${avg(beat).toFixed(2)}`);

/**
 * Par is a bound, not a target: it assumes you turn up not knowing when
 * anything leaves. The game hands you live departures, so a player who reads
 * them should be beating it more often than not. If this drops toward zero,
 * the information the whole game is played on has stopped being worth having.
 */
const pars = cities.map((c) => c.par.time);
const beatsPar = times.filter((t, i) => t < pars[i]).length;
note(`vs par: ${beatsPar}/${N} runs beat the planner's estimate ` +
  `(avg ${(avg(times) / avg(pars) * 100).toFixed(0)}% of par)`);
check('live departures are worth reading — a real run often beats par',
  beatsPar >= N * 0.3, `${beatsPar}/${N}`);
check('and par is not wildly wrong in either direction',
  avg(times) / avg(pars) > 0.6 && avg(times) / avg(pars) < 1.4,
  `${(avg(times) / avg(pars)).toFixed(2)}x`);

describe('the start of a round');

const firstWait = cities.map((c) => {
  const rows = departures(c, c.origin, 0, 600 / TEMPO);
  return rows.length ? rows[0].in : 999;
});
note(`first departure at the origin: avg ${avg(firstWait).toFixed(0)}s, worst ${Math.max(...firstWait).toFixed(0)}s`);
check('nobody starts a round staring at an empty platform',
  Math.max(...firstWait) < 100 / TEMPO,
  `worst ${Math.max(...firstWait).toFixed(0)}s, budget ${(100 / TEMPO).toFixed(0)}s`);

describe('boarding');

/**
 * The board radius is measured from the platform, so a vehicle with its doors
 * open has to be exactly on its stop — otherwise a tram could be "at" a stop
 * and out of reach, which is unexplainable from inside the game.
 */
let offPlatform = 0, samples = 0;
for (const c of cities.slice(0, 8)) {
  for (let t = 0; t < 300; t += 3) {
    for (const v of allVehicles(c, t)) {
      if (v.atStop < 0) continue;
      samples++;
      const s = c.stops[v.atStop];
      if (Math.hypot(v.x - s.x, v.y - s.y) > 0.001) offPlatform++;
    }
  }
}
check('a vehicle with its doors open is exactly on its platform',
  offPlatform === 0, `${offPlatform} of ${samples} samples off`);

/** Starting later must not change the answer's shape — no lucky t=0. */
const late = cities.slice(0, 12).map((c, i) => ride(c, (137.5 + i * 41) / TEMPO));
check('the race works from any point in the timetable',
  late.every((r) => r !== null), `${late.filter(Boolean).length}/12`);
note(`late starts: avg ${avg(late.filter(Boolean).map((r) => r!.time)).toFixed(0)}s`);

describe('walking is a real option, and a bad one');

const nb = cities.map((c) => walkNeighbours(c));
let strandedBanks = 0;
for (let i = 0; i < cities.length; i++) {
  // Reachable on foot alone from the origin, through the walk graph only.
  const c = cities[i];
  const seen = new Set([c.origin]);
  const queue = [c.origin];
  while (queue.length) {
    const s = queue.pop()!;
    for (const w of nb[i][s]) if (!seen.has(w.to)) { seen.add(w.to); queue.push(w.to); }
  }
  if (!seen.has(c.destination)) strandedBanks++;
}
note(`in ${strandedBanks}/${N} cities you cannot reach the destination by ` +
  `short walks at all — the network is the only way`);
check('walking the whole way is never the plan',
  cities.every((c) => c.par.walk / c.par.time >= WALK.speed / WALK.speed * RACE.minWalkRatio),
  `floor x${RACE.minWalkRatio}`);

report();
