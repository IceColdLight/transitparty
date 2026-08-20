/**
 * Sprinting, and the tank behind it.
 *
 * Sprinting exists for one moment: the doors are open, you are forty metres
 * away, and walking will not do it. Everything below is a property of that
 * moment or of the thing that stops it becoming a permanent gear — because a
 * sprint you can hold forever is just a higher walk speed, and a higher walk
 * speed is a direct attack on the one thing the whole game rests on, that the
 * network beats your legs.
 */
import { MODES, STAMINA, SUSTAINED_WALK, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { newBody, stepBody } from '../src/shared/movement.js';
import type { River } from '../src/shared/river.js';
import type { Streets } from '../src/shared/streets.js';
import { check, describe, near, note, report } from './harness.js';

/** An empty plain, to measure the speed model without a building in the way. */
const OPEN: Streets = { xs: [0], ys: [0], width: 1e7 };
const NO_RIVER: River = { poly: [{ x: -1e6, y: -1e6 }, { x: -1e6, y: 1e6 }], bridges: [] };
const OPEN_GROUND = { streets: OPEN, river: NO_RIVER, transit: null };
const STEP = 1 / 60;

/** Walk east for `seconds`, deciding each tick whether to hold the sprint key. */
function run(seconds: number, wantSprint: (t: number, stamina: number) => boolean) {
  const w = newBody(0, 0);
  let sprintTicks = 0, bursts = 0, wasSprinting = false, lowest = 1;
  const burstLengths: number[] = [];
  let current = 0;
  for (let t = 0; t < seconds; t += STEP) {
    stepBody(w, { wx: 1, wy: 0, sprint: wantSprint(t, w.stamina), jump: false }, STEP, OPEN_GROUND);
    lowest = Math.min(lowest, w.stamina);
    if (w.sprinting) {
      sprintTicks++;
      current += STEP;
      if (!wasSprinting) bursts++;
    } else if (wasSprinting) { burstLengths.push(current); current = 0; }
    wasSprinting = w.sprinting;
  }
  if (current > 0) burstLengths.push(current);
  return { w, distance: w.x, duty: (sprintTicks * STEP) / seconds, bursts, burstLengths, lowest };
}

describe('the dash');

const walkOnly = run(6, () => false);
const sprintOnly = run(6, () => true);
note(`in 6s: walking ${walkOnly.distance.toFixed(0)}m, running ${sprintOnly.distance.toFixed(0)}m`);
check('sprinting is meaningfully faster than walking',
  sprintOnly.distance / walkOnly.distance > 1.25,
  `x${(sprintOnly.distance / walkOnly.distance).toFixed(2)} over 6s`);

/**
 * The number it was sized against: a bus stands for four seconds, so from
 * forty metres out the dash has to land and the walk has to miss.
 */
const dashWalk = 40 / WALK.speed;
const dashRun = 40 / (WALK.speed * WALK.sprint);
note(`40m to a closing door: walking ${dashWalk.toFixed(1)}s, running ${dashRun.toFixed(1)}s`);
check('a full tank buys the dash the doors are worth',
  dashRun < MODES.bus.dwell && dashWalk > MODES.bus.dwell,
  `bus doors are open ${MODES.bus.dwell}s`);

const fromFull = run(20, () => true);
const reach = WALK.speed * WALK.sprint * STAMINA.burst;
note(`one tank runs for ${STAMINA.burst}s and covers ${reach.toFixed(0)}m`);
check('and one tank is about one platform, not one leg of the journey',
  reach > 35 && reach < 70, `${reach.toFixed(0)}m`);
// Hold it for twenty seconds and you are not empty at the end — you are in
// the cycle, spending a bit and earning it back. What matters is that you hit
// the bottom, and that you spent nowhere near the whole twenty seconds running.
check('the tank does run out', fromFull.lowest === 0 && fromFull.duty < 0.35,
  `bottomed out, sprinted ${(fromFull.duty * 100).toFixed(0)}% of 20s`);

describe('the tank');

const rested = run(0.1, () => false);
check('you start a round with a full one', rested.w.stamina > 0.99);

const emptied = run(STAMINA.burst, () => true);
check('holding it from full drains the tank in exactly its stated seconds',
  emptied.w.stamina < 0.005, `${(emptied.w.stamina * 100).toFixed(1)}% left after ${STAMINA.burst}s`);
check('and the sprint cuts out on its own when it hits the bottom',
  !emptied.w.sprinting, 'still running: no');

// Now stop and let it come back.
const recovering = newBody(0, 0);
recovering.stamina = 0;
let toFull = 0;
for (; toFull < 40; toFull += STEP) {
  stepBody(recovering, { wx: 1, wy: 0, sprint: false, jump: false }, STEP, OPEN_GROUND);
  if (recovering.stamina >= 1) break;
}
near('refilling takes as long as it says', toFull, STAMINA.recover, 0.2);
check('recovery is much slower than the spend',
  STAMINA.recover / STAMINA.burst > 2.5,
  `${(STAMINA.recover / STAMINA.burst).toFixed(1)}x as long to earn as to spend`);

describe('the latch');

/**
 * The floor stops tapping being a strategy. Without it, the moment stamina
 * rose above zero you could sprint for one frame, over and over: a permanent
 * boost delivered as a stutter, faster than sprinting properly and impossible
 * for anyone watching to read.
 */
const held = run(60, () => true);
const tapped = run(60, (t) => Math.floor(t * 30) % 2 === 0);
note(`over 60s: holding it covers ${held.distance.toFixed(0)}m in ${held.bursts} bursts, ` +
  `tapping covers ${tapped.distance.toFixed(0)}m in ${tapped.bursts}`);
check('tapping the key never beats holding it',
  tapped.distance <= held.distance + 1,
  `${tapped.distance.toFixed(0)}m vs ${held.distance.toFixed(0)}m`);

const shortest = Math.min(...held.burstLengths);
check('and every sprint is a run, not a twitch',
  shortest > 0.4, `shortest burst ${shortest.toFixed(2)}s`);
note(`tapping gets the same ground in ${tapped.bursts} stutters instead of ` +
  `${held.bursts} runs — no faster, and visibly worse`);

describe('what the planner is told');

/**
 * routing.ts costs long walks at SUSTAINED_WALK rather than the base speed,
 * because a player sprints whenever the tank allows. If this drifts, every
 * generated race is vetted against a walking speed nobody travels at and
 * `par` becomes a comfortable lie.
 */
note(`base ${WALK.speed.toFixed(1)} m/s, sprint ${(WALK.speed * WALK.sprint).toFixed(1)}, ` +
  `sustained ${SUSTAINED_WALK.toFixed(2)}`);
near('a long walk really does average the speed the planner assumes',
  held.distance / 60, SUSTAINED_WALK, 0.35);
check('and sprinting is worth having without being worth everything',
  SUSTAINED_WALK / WALK.speed > 1.08 && SUSTAINED_WALK / WALK.speed < 1.3,
  `x${(SUSTAINED_WALK / WALK.speed).toFixed(3)} over a long walk`);

describe('it does not let you cheat the city');

const city = buildCity(4242);
const origin = city.stops[city.origin];
const runner = newBody(origin.x, origin.y);
for (let i = 0; i < 60 * 40; i++) {
  const t = i / 60;
  stepBody(runner, { wx: Math.cos(t * 0.7), wy: Math.sin(t * 0.7), sprint: true, jump: false },
    STEP, { streets: city.streets, river: city.river, transit: null });
}
const { onStreet } = await import('../src/shared/streets.js');
check('you cannot sprint into a building', onStreet(city.streets, runner),
  `ended at ${runner.x.toFixed(0)},${runner.y.toFixed(0)}`);

report();
