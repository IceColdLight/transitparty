/**
 * Riding, which is not a state you enter.
 *
 * There is no board key. A vehicle is a moving platform: if your feet are on
 * its deck you go where it goes, and if they are not, you do not. Every
 * question the game asks at a stop — pick that one, get on before the doors
 * shut, get off before it carries you past — is the same question as "am I
 * standing on it", asked at speed.
 *
 * The fiddly part, and most of what is checked here, is that horizontal
 * velocity is stored RELATIVE to whatever you are standing on. Converting it
 * at the moment your feet leave or land is what makes stepping off a tram
 * throw you down the street instead of dropping you where you stood.
 */
import { BODIES, PLAYER, WALK } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { type Ground, newBody, stepBody } from '../src/shared/movement.js';
import { allVehicles, overVehicle, toWorld, vehicleById } from '../src/shared/vehicles.js';
import type { City, Vehicle } from '../src/shared/types.js';
import { check, describe, near, note, report } from './harness.js';

const STEP = 1 / 60;
const still = { wx: 0, wy: 0, sprint: false, jump: false };

const groundAt = (city: City, time: number): Ground => ({
  streets: city.streets, river: city.river,
  transit: { city, vehicles: allVehicles(city, time), time },
});

/**
 * A vehicle standing at a stop with nothing else on top of it.
 *
 * The "nothing else" matters: vehicles do not collide with each other, so
 * where a rail alignment crosses a bus route two of them can occupy the same
 * patch of road, and `deckUnder` hands you the higher deck. The game shrugs
 * that off; a test that assumes it boarded the bus it picked does not.
 */
function findDwelling(city: City, mode?: string): { v: Vehicle; time: number } | null {
  for (let time = 0; time < 400; time += 0.5) {
    const fleet = allVehicles(city, time);
    for (const v of fleet) {
      if (v.atStop < 0) continue;
      if (mode && city.lines[v.line].mode !== mode) continue;
      if (fleet.some((o) => o.id !== v.id && overVehicle(city, o, v.x, v.y))) continue;
      return { v, time };
    }
  }
  return null;
}

const city = buildCity(20260820);
describe(`standing on things — seed ${city.seed}`);

const found = findDwelling(city, 'bus') ?? findDwelling(city);
check('the city has something with its doors open to stand on', found !== null);
if (!found) report();

let time = found.time;
const deckHeight = BODIES[city.lines[found.v.line].mode].deck;
note(`${city.lines[found.v.line].name} (${city.lines[found.v.line].mode}) at ` +
  `${city.stops[found.v.atStop].name}, deck ${deckHeight}m`);

check('a vehicle deck is low enough to walk onto without jumping',
  deckHeight < PLAYER.step, `${deckHeight}m against a ${PLAYER.step}m step`);

// Stand in the road where the vehicle is and take one step.
const p = newBody(found.v.x, found.v.y);
stepBody(p, still, STEP, groundAt(city, time));
check('feet over a deck end up on the deck', p.riding === found.v.id, `${p.riding}`);
near('and at its height', p.h, deckHeight, 0.001);

describe('being carried');

/**
 * Run the clock forward and let the vehicle leave. Nothing pushes the player:
 * the deck moves and they move with it, translated by the exact distance the
 * timetable says the vehicle travelled.
 */
const startedAt = { x: p.x, y: p.y };
let departed = false;
for (let i = 0; i < 60 * 40; i++) {
  time += STEP;
  stepBody(p, still, STEP, groundAt(city, time));
  const v = vehicleById(city, p.riding ?? '', time);
  if (v && v.atStop < 0) departed = true;
  if (departed && i > 60 * 6) break;
}
const carried = Math.hypot(p.x - startedAt.x, p.y - startedAt.y);
check('it pulls away and takes you with it', departed && carried > 40,
  `${carried.toFixed(0)}m from where you got on`);
check('you are still aboard the one you got on', p.riding === found.v.id, `${p.riding}`);

const aboard = vehicleById(city, p.riding!, time)!;
check('and you are standing on it, not near it',
  overVehicle(city, aboard, p.x, p.y), 'inside its floor plan');
near('still on the deck', p.h, deckHeight, 0.02);

describe('stepping off a moving one');

/**
 * The point of the whole exercise. Stepping off something moving quickly
 * should throw you down the street; jumping on the spot should not. The
 * difference is exactly the vehicle's velocity, converted from relative to
 * absolute at the moment your feet leave the deck.
 *
 * Wait for the vehicle to be up to speed first — a leg near a stop can be
 * doing a fraction of the line's cruise, and measuring the throw there says
 * nothing about whether the conversion happened.
 */
const speedOf = (id: string, t: number) => {
  const a = vehicleById(city, id, t - STEP)!, b = vehicleById(city, id, t)!;
  return Math.hypot(b.x - a.x, b.y - a.y) / STEP;
};

for (let i = 0; i < 60 * 60 && speedOf(p.riding!, time) < WALK.speed * 1.6; i++) {
  time += STEP;
  stepBody(p, still, STEP, groundAt(city, time));
}
const speed = speedOf(p.riding!, time);

function jumpFrom(fromVehicle: boolean): number {
  const b = fromVehicle ? { ...p } : newBody(p.x, p.y);
  if (!fromVehicle) { b.riding = null; b.h = 0; b.grounded = true; }
  let t = time;
  const from = { x: b.x, y: b.y };
  stepBody(b, { ...still, jump: true }, STEP, groundAt(city, t));
  for (let i = 0; i < 60 * 4; i++) {
    t += STEP;
    stepBody(b, still, STEP, groundAt(city, t));
    if (b.grounded && i > 4) break;
  }
  return Math.hypot(b.x - from.x, b.y - from.y);
}

const airtime = 2 * PLAYER.jump / PLAYER.gravity;
const flung = jumpFrom(true);
const standing = jumpFrom(false);
note(`the ${city.lines[found.v.line].name} is doing ${speed.toFixed(0)} m/s; ` +
  `stepping off carried ${flung.toFixed(0)}m against ${standing.toFixed(0)}m from a standstill`);
check('you keep the vehicle\'s speed when your feet leave the deck',
  flung > standing + speed * airtime * 0.4,
  `${flung.toFixed(0)}m vs ${standing.toFixed(0)}m, the vehicle would carry you ` +
  `${(speed * airtime).toFixed(0)}m in that time`);
check('but it is not a catapult — the drag bleeds it off',
  flung < speed * airtime * 1.2 + standing,
  `${flung.toFixed(0)}m against ${(speed * airtime).toFixed(0)}m undamped`);

describe('and what you cannot do');

const rail = findDwelling(city, 'metro');
if (rail) {
  let t = rail.time;
  const r = newBody(rail.v.x, rail.v.y);
  stepBody(r, still, STEP, groundAt(city, t));
  check('you can stand on a metro at a station', r.riding === rail.v.id, `${r.riding}`);

  // Wait for it to leave, then try very hard to get out.
  let inTunnel = false;
  for (let i = 0; i < 60 * 60 && !inTunnel; i++) {
    t += STEP;
    stepBody(r, still, STEP, groundAt(city, t));
    const v = vehicleById(city, r.riding ?? '', t);
    if (v && v.atStop < 0) inTunnel = true;
  }
  const before = r.riding;
  // Every direction, and the jump key, for three seconds.
  for (let i = 0; i < 60 * 3; i++) {
    t += STEP;
    const a = i * 0.11;
    stepBody(r, { wx: Math.cos(a), wy: Math.sin(a), sprint: true, jump: true }, STEP, groundAt(city, t));
  }
  check('you cannot get out of a metro between stations',
    inTunnel && r.riding === before,
    inTunnel ? (r.riding === before ? `${before} kept hold of you` : 'ESCAPED') : 'never left a station');
}

describe('coming down onto a deck from above');

/**
 * Two bugs lived here, both invisible to every other check in this file
 * because they all board from the ground.
 *
 * Falling onto a vehicle used to drop you straight through it: the search for
 * a floor only looked at where the feet ENDED the tick, so on the one tick
 * that mattered the deck was rejected for being above them.
 *
 * And mid-air steering was scaled by walking speed as well as by the air
 * acceleration, giving about 72 m/s² of control — enough to cancel the
 * momentum a jump off a moving tram is entirely for.
 */
{
  const v = vehicleById(city, p.riding!, time)!;
  const faller = newBody(v.x, v.y);
  faller.h = 6;                     // dropped in from above
  faller.riding = null;
  faller.grounded = false;
  faller.vh = -12;
  let t = time;
  let landedOn: string | null = null;
  for (let i = 0; i < 60 * 4; i++) {
    t += STEP;
    // The vehicle has moved on by now; drop onto whatever is beneath.
    const under = allVehicles(city, t).find((x) => overVehicle(city, x, faller.x, faller.y));
    if (under) { faller.x = under.x; faller.y = under.y; }
    stepBody(faller, still, STEP, groundAt(city, t));
    if (faller.grounded) { landedOn = faller.riding; break; }
  }
  check('falling onto a vehicle lands you on it rather than through it',
    landedOn !== null, landedOn ? `landed on ${landedOn}` : 'fell through to the street');
}

{
  // Mid-air steering must dent the momentum, not erase it.
  const a = { ...p };
  const b = { ...p };
  let t = time;
  stepBody(a, { ...still, jump: true }, STEP, groundAt(city, t));
  stepBody(b, { ...still, jump: true }, STEP, groundAt(city, t));
  const dir = { x: -Math.cos(vehicleById(city, p.riding!, time)!.angle),
    y: -Math.sin(vehicleById(city, p.riding!, time)!.angle) };
  const fromA = { x: a.x, y: a.y }, fromB = { x: b.x, y: b.y };
  for (let i = 0; i < 60 * 2; i++) {
    t += STEP;
    stepBody(a, still, STEP, groundAt(city, t));
    // b fights the momentum with everything it has
    stepBody(b, { wx: dir.x, wy: dir.y, sprint: true, jump: false }, STEP, groundAt(city, t));
    if (a.grounded && b.grounded && i > 4) break;
  }
  const free = Math.hypot(a.x - fromA.x, a.y - fromA.y);
  const fought = Math.hypot(b.x - fromB.x, b.y - fromB.y);
  note(`carried ${free.toFixed(0)}m coasting, ${fought.toFixed(0)}m steering hard against it`);
  check('mid-air steering bends the jump without cancelling it',
    fought < free && fought > free * 0.3,
    `${fought.toFixed(0)}m against ${free.toFixed(0)}m`);
}

describe('doors');

/**
 * A vehicle is a room with doors, and on foot the doors are the only way
 * through the walls. That is what turns getting off at the right stop into
 * something you plan a few seconds ahead rather than a key you press.
 */
{
  const found2 = findDwelling(city, 'bus') ?? findDwelling(city)!;
  const v = found2.v;
  const mode = city.lines[v.line].mode;
  const spec = BODIES[mode];
  const t = found2.time;
  const g = groundAt(city, t);

  /** Put a body on the deck and try to walk out sideways from `lx`. */
  const escapeFrom = (lx: number) => {
    const at = toWorld(v, lx, 0);
    const p2 = newBody(at.x, at.y);
    stepBody(p2, still, STEP, g);
    if (!p2.riding) return 'never got on';
    const out = toWorld(v, lx, spec.w);
    const dx = out.x - p2.x, dy = out.y - p2.y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 60 * 3; i++) {
      stepBody(p2, { wx: dx / len, wy: dy / len, sprint: false, jump: false }, STEP, g);
      if (!p2.riding) return 'out';
    }
    return 'held';
  };

  const doorLx = spec.doors[0] * spec.l;
  // A point on the flank as far from any doorway as this body allows.
  let wallLx = 0, worst = 0;
  for (let x = -spec.l / 2; x <= spec.l / 2; x += 0.2) {
    const gap = Math.min(...spec.doors.map((d) => Math.abs(x - d * spec.l)));
    if (gap > worst) { worst = gap; wallLx = x; }
  }
  note(`${city.lines[v.line].name}: ${spec.doors.length} doors a side, ` +
    `${spec.doorWidth}m wide, walls ${spec.wall}m`);

  check('you can walk out of a doorway while it is standing at a stop',
    escapeFrom(doorLx) === 'out', escapeFrom(doorLx));
  check('and you cannot walk out through the side of the bodywork',
    escapeFrom(wallLx) === 'held', escapeFrom(wallLx));
}

/** And a sealed one keeps its doors shut between stations. */
{
  const rail = findDwelling(city, 'metro');
  if (rail) {
    const spec = BODIES.metro;
    let t = rail.time;
    const at = toWorld(rail.v, spec.doors[0] * spec.l, 0);
    const p2 = newBody(at.x, at.y);
    stepBody(p2, still, STEP, groundAt(city, t));
    const boarded = p2.riding;
    let moving = false;
    for (let i = 0; i < 60 * 60 && !moving; i++) {
      t += STEP;
      stepBody(p2, still, STEP, groundAt(city, t));
      const v2 = vehicleById(city, p2.riding ?? '', t);
      if (v2 && v2.atStop < 0) moving = true;
    }
    // Stand in the doorway and push, with the jump key down for good measure.
    for (let i = 0; i < 60 * 3; i++) {
      t += STEP;
      const v2 = vehicleById(city, p2.riding ?? '', t);
      if (!v2) break;
      const out = toWorld(v2, spec.doors[0] * spec.l, spec.w);
      const dx = out.x - p2.x, dy = out.y - p2.y;
      const len = Math.hypot(dx, dy) || 1;
      stepBody(p2, { wx: dx / len, wy: dy / len, sprint: true, jump: true }, STEP, groundAt(city, t));
    }
    check('a doorway you are standing in is still shut between stations',
      moving && p2.riding === boarded,
      moving ? `${boarded} kept hold of you` : 'never left a station');
  }
}

describe('landing');

/** Coming off a deck onto the street must not leave you sliding. */
const lander = { ...p };
let t2 = time;
stepBody(lander, { ...still, jump: true }, STEP, groundAt(city, t2));
for (let i = 0; i < 60 * 6; i++) {
  t2 += STEP;
  stepBody(lander, still, STEP, groundAt(city, t2));
}
check('you come to rest after landing rather than skating away',
  Math.hypot(lander.vx, lander.vy) < 1.5,
  `${Math.hypot(lander.vx, lander.vy).toFixed(2)} m/s left after 6s`);
check('and you end up on solid ground', lander.grounded, `h=${lander.h.toFixed(2)}`);

report();
