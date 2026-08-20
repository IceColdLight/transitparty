/**
 * Three levels to navigate: a tunnel, the road, and a viaduct.
 *
 * The metro runs eight metres under the street and the train nine metres over
 * it, and the only way to either is a staircase you have to find. That is the
 * point — it makes a transfer from the metro to a bus a climb rather than a
 * step sideways, and it gives the player a second kind of wayfinding on top of
 * reading the map.
 *
 * The failures this guards against are the quiet ones. A vehicle drawn at the
 * wrong height is obvious; a vehicle whose PHYSICS is at the wrong height is a
 * metro you can board from the pavement, or a platform you can stand on
 * through eight metres of soil.
 */
import { BODIES, LEVELS, PLAYER, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { type Ground, newBody, stepBody } from '../src/shared/movement.js';
import { allVehicles } from '../src/shared/vehicles.js';
import { inRect } from '../src/shared/stations.js';
import { onStreet } from '../src/shared/streets.js';
import { avg, check, describe, near, note, report } from './harness.js';

const STEP = 1 / 60;
const still = { wx: 0, wy: 0, sprint: false, jump: false };
const city = buildCity(4242);
const ground = (t: number): Ground => ({
  streets: city.streets, river: city.river,
  transit: { city, vehicles: allVehicles(city, t), time: t },
});

describe(`levels — seed ${city.seed}`);

const metros = city.stations.filter((s) => s.mode === 'metro');
const trains = city.stations.filter((s) => s.mode === 'train');
note(`${metros.length} underground stations, ${trains.length} elevated, ` +
  `of ${city.stops.length} stops`);
check('every rail stop has a station box dug for it',
  metros.length > 0 && trains.length > 0, `${metros.length} / ${trains.length}`);

let wrongLevel = 0, sampled = 0;
for (let t = 0; t < 200; t += 5) {
  for (const v of allVehicles(city, t)) {
    sampled++;
    if (v.level !== LEVELS[city.lines[v.line].mode]) wrongLevel++;
  }
}
check('every vehicle runs at its own mode\'s level',
  wrongLevel === 0, `${wrongLevel} of ${sampled} samples at the wrong height`);
check('the metro is under the road and the train is over it',
  LEVELS.metro < -4 && LEVELS.train > 4 && LEVELS.bus === 0 && LEVELS.tram === 0,
  `metro ${LEVELS.metro}m, train ${LEVELS.train}m`);

describe('platforms');

/** A platform is level with the floor of the thing that calls at it. */
for (const mode of ['metro', 'train'] as const) {
  const st = city.stations.find((s) => s.mode === mode)!;
  near(`a ${mode} platform is flush with its deck`,
    st.level, LEVELS[mode] + BODIES[mode].deck, 0.001);
}

describe('you have to use the stairs');

const st = metros[0];
const mouth = {
  x: st.shaft.x - Math.cos(st.shaft.angle) * st.shaft.hl,
  y: st.shaft.y - Math.sin(st.shaft.angle) * st.shaft.hl,
};
check('the mouth of the stairs is out on the street where it can be found',
  onStreet(city.streets, mouth), `${mouth.x.toFixed(0)},${mouth.y.toFixed(0)}`);

/**
 * Standing on the road directly over a platform, your feet are on the road.
 * If this ever picks the platform instead, the city has one level again and
 * players fall through the street.
 */
{
  const over = newBody(st.hall.x, st.hall.y);
  check('the hall really is beneath a walkable point', inRect(st.hall, over.x, over.y));
  stepBody(over, still, STEP, ground(0));
  check('standing above a station leaves you on the road, not on its platform',
    Math.abs(over.h) < 0.01, `h=${over.h.toFixed(2)}`);
}

/** And walking in at the mouth takes you down. */
{
  const walker = newBody(mouth.x, mouth.y);
  const dir = { x: Math.cos(st.shaft.angle), y: Math.sin(st.shaft.angle) };
  let lowest = 0;
  // Just far enough to reach the bottom. Walking on for another forty metres
  // takes you off the end of the platform and out of the station entirely,
  // which is a fine thing for a player to do and a poor way to write a test.
  for (let i = 0; i < 60 * 3.5; i++) {
    stepBody(walker, { wx: dir.x, wy: dir.y, sprint: false, jump: false }, STEP, ground(i * STEP));
    lowest = Math.min(lowest, walker.h);
  }
  note(`walked in and reached ${lowest.toFixed(1)}m, platform is at ${st.level.toFixed(1)}m`);
  check('walking into the stairwell takes you down to the platform',
    lowest <= st.level + 0.3, `got to ${lowest.toFixed(1)}m`);

  // …and back up again, or the metro is a trap.
  let highest = walker.h;
  for (let i = 0; i < 60 * 8; i++) {
    stepBody(walker, { wx: -dir.x, wy: -dir.y, sprint: false, jump: false }, STEP, ground(i * STEP));
    highest = Math.max(highest, walker.h);
  }
  check('and you can climb back out again',
    highest > -0.3, `got back up to ${highest.toFixed(1)}m`);
}

describe('what the stairs cost');

/**
 * The descent is meant to be seconds, not a chore. Too deep and every rail
 * journey grows a tax nobody enjoys paying; too shallow and it is not
 * navigation, it is a kerb.
 */
const climb = Math.hypot(st.shaft.hl * 2, st.level) / WALK.speed;
note(`${Math.abs(st.level).toFixed(1)}m down a ${(st.shaft.hl * 2).toFixed(0)}m ramp: ` +
  `about ${climb.toFixed(1)}s each way`);
check('a descent is a few seconds, not an expedition',
  climb > 1.5 && climb < 8, `${climb.toFixed(1)}s`);
check('the stairs are not so steep you would need a jump',
  Math.abs(st.level) / (st.shaft.hl * 2) < 0.75,
  `gradient ${(Math.abs(st.level) / (st.shaft.hl * 2)).toFixed(2)}`);

describe('boarding from the platform');

let boarded: string | null = null;
for (let t = 0; t < 400 && !boarded; t += 0.5) {
  const v = allVehicles(city, t).find((x) => x.atStop === st.stop
    && city.lines[x.line].mode === 'metro');
  if (!v) continue;
  const b = newBody(v.x, v.y);
  b.h = st.level;
  stepBody(b, still, STEP, ground(t));
  if (b.riding === v.id) boarded = v.id;
}
check('a metro can be boarded from its platform', !!boarded, boarded ?? 'never managed it');

/** But not from the street above it. */
{
  let fromAbove = 0, tried = 0;
  for (let t = 0; t < 200; t += 1) {
    const v = allVehicles(city, t).find((x) => x.atStop === st.stop
      && city.lines[x.line].mode === 'metro');
    if (!v) continue;
    tried++;
    const b = newBody(v.x, v.y);
    stepBody(b, still, STEP, ground(t));
    if (b.riding) fromAbove++;
  }
  check('and never from the pavement eight metres above it',
    fromAbove === 0, `${fromAbove} of ${tried} attempts from street level`);
}

describe('the planner knows about the climb');

const stairs = city.stations.length;
note(`${stairs} staircases in this city; the route planner charges every rail ` +
  `boarding for one`);
check('there is a station for every rail stop and no more',
  stairs === city.stops.filter((s) => s.lines.some((l) =>
    city.lines[l].mode === 'metro')).length
    + city.stops.filter((s) => s.lines.some((l) => city.lines[l].mode === 'train')).length,
  `${stairs} stations`);

void avg; void PLAYER;
report();
