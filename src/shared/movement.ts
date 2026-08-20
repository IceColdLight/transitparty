/**
 * The player as a body in three dimensions. Shared, because the client
 * predicts it and the server decides it, and the two have to agree about
 * where the pavement is, how high a bus is, and how far you fly when you jump
 * off one.
 *
 * The load-bearing idea is that **riding is not a state you enter, it is a
 * surface you are standing on.** There is no board key. A vehicle is a moving
 * platform; if your feet are on its deck you go where it goes, and if they
 * are not, you do not. Everything the game asks of you at a stop — pick that
 * one, get on before the doors shut, get off before it carries you past — is
 * the same question as "am I standing on it", asked at speed.
 */
import { BODIES, CITY, PLAYER, STAMINA, WALK } from './constants.js';
import { type River, illegalCrossing } from './river.js';
import { type Streets, onStreet, snapToStreet } from './streets.js';
import {
  deckUnder, doorsOpen, inDoorway, overVehicle, toLocal, toWorld, vehicleById, vehicleVelocity,
} from './vehicles.js';
import type { City, Vehicle } from './types.js';

export type Body = {
  /** city plane */
  x: number;
  y: number;
  /** height of the feet above the street */
  h: number;
  /**
   * Horizontal velocity RELATIVE TO WHATEVER YOU ARE STANDING ON. On the
   * street that is the world; on a tram doing thirty metres a second it is
   * the tram. Converting between the two at the moment your feet leave or
   * land is what makes jumping off one carry you, and it is the only fiddly
   * part of this file.
   */
  vx: number;
  vy: number;
  vh: number;
  stamina: number;
  sprinting: boolean;
  grounded: boolean;
  /** id of the vehicle under your feet, or null for solid ground */
  riding: string | null;
};

export type MoveInput = { wx: number; wy: number; sprint: boolean; jump: boolean };

/** Everything the step needs to know about the world it is stepping through. */
export type Ground = {
  streets: Streets;
  river: River;
  /** null only in tests that care about the speed model and nothing else */
  transit: { city: City; vehicles: Vehicle[]; time: number } | null;
};

export const newBody = (x: number, y: number): Body => ({
  x, y, h: 0, vx: 0, vy: 0, vh: 0,
  stamina: 1, sprinting: false, grounded: true, riding: null,
});

/**
 * Everything about being inside a vehicle, in one place.
 *
 * A vehicle is a room. Walls hold you in, doorways are the only way through
 * them on foot, and the doors are open exactly while it is standing at a stop.
 * On a bus or a tram the walls are waist high, so a jump clears them and you
 * can bail out anywhere; on a metro or a train they go to the roof and you
 * are going to the next station whether you like it or not.
 */
function cabin(city: City, v: Vehicle) {
  const b = BODIES[city.lines[v.line].mode];
  return {
    b,
    mode: city.lines[v.line].mode,
    halfL: b.l / 2 - PLAYER.radius,
    halfW: b.w / 2 - PLAYER.radius,
    /** waist-high sides can be jumped; full-height ones cannot */
    vaultable: b.wall < 1.4,
    open: doorsOpen(v),
  };
}

/** Can somebody at this height and position pass through the side of the body? */
function throughSide(
  city: City, v: Vehicle, lx: number, aboveDeck: number,
): boolean {
  const c = cabin(city, v);
  if (c.vaultable && aboveDeck >= c.b.wall - 0.02) return true;
  return c.open && inDoorway(c.mode, lx);
}

export function stepBody(p: Body, input: MoveInput, dt: number, g: Ground): void {
  const moving = input.wx !== 0 || input.wy !== 0;

  // ── stamina. The latch: starting a sprint needs a floor, continuing needs
  //    only something. See STAMINA.
  p.sprinting = moving && input.sprint && p.grounded
    && (p.sprinting ? p.stamina > 0 : p.stamina >= STAMINA.floor);
  if (p.sprinting) p.stamina = Math.max(0, p.stamina - dt / STAMINA.burst);
  else p.stamina = Math.min(1, p.stamina + dt / STAMINA.recover);
  const speed = p.sprinting ? WALK.speed * WALK.sprint : WALK.speed;

  const t = g.transit;
  const t2City = t?.city;
  const velOf = (id: string) => (t ? vehicleVelocity(t.city, id, t.time, dt) : { x: 0, y: 0 });

  // ── carried. The deck moves under you, so you move with it. This is done
  //    as an exact translation rather than by adding the vehicle's velocity,
  //    because a vehicle's speed changes in steps — it arrives and simply
  //    stops — and anything integrated would slide off at every dwell.
  if (p.riding && t) {
    const was = vehicleById(t.city, p.riding, t.time - dt);
    const now = vehicleById(t.city, p.riding, t.time);
    if (was && now) {
      // Rotation as well as translation. Moving a passenger by the vehicle's
      // change in POSITION alone works fine down a straight street and throws
      // them off at the first corner: the deck turns under them, their offset
      // from its centre does not, and they end up outside the floor plan and
      // fall into the road. A bus route is nothing but corners.
      let spin = now.angle - was.angle;
      while (spin > Math.PI) spin -= Math.PI * 2;
      while (spin < -Math.PI) spin += Math.PI * 2;
      const rx = p.x - was.x, ry = p.y - was.y;
      const cs = Math.cos(spin), sn = Math.sin(spin);
      p.x = now.x + rx * cs - ry * sn;
      p.y = now.y + rx * sn + ry * cs;
      // Your own momentum turns with you, or walking forward on a turning
      // tram quietly becomes walking sideways.
      const vx = p.vx * cs - p.vy * sn;
      p.vy = p.vx * sn + p.vy * cs;
      p.vx = vx;
    } else p.riding = null;
  }

  // ── horizontal ──────────────────────────────────────────────────────────
  const tx = input.wx * speed, ty = input.wy * speed;
  if (p.grounded) {
    const k = Math.min(1, WALK.accel * dt);
    p.vx += (tx - p.vx) * k;
    p.vy += (ty - p.vy) * k;
  } else {
    /**
     * In the air you steer a little and keep most of what you brought.
     *
     * `input.wx`, not `tx`: tx is already multiplied by your walking speed, so
     * feeding it through here scaled the air acceleration by the speed as well
     * and produced about 72 m/s² of mid-air control — full authority, which
     * quietly cancelled the momentum the jump is for. It never showed up in a
     * test because the tests jumped without holding a direction.
     */
    p.vx += input.wx * PLAYER.airAccel * dt;
    p.vy += input.wy * PLAYER.airAccel * dt;
    const drag = Math.max(0, 1 - PLAYER.airDrag * dt);
    p.vx *= drag;
    p.vy *= drag;
  }

  /**
   * Shut in under a roof? Then the jump key does nothing.
   *
   * Not just politeness about headroom: jumping clears `riding`, and inside a
   * sealed metro that would drop a player through the floor and into the
   * middle of a solid block at sixty metres a second, which has no sensible
   * answer. On an open-topped bus or tram jumping is exactly how you get out,
   * so it stays.
   */
  const shutIn = (() => {
    if (!p.riding || !t) return false;
    const v = vehicleById(t.city, p.riding, t.time);
    return !!v && !cabin(t.city, v).vaultable;
  })();

  // ── jumping. Leaving a deck turns your relative speed into a real one,
  //    which is the whole trick behind stepping off a moving tram.
  if (input.jump && p.grounded && !shutIn) {
    p.vh = PLAYER.jump;
    p.grounded = false;
    if (p.riding) {
      const v = velOf(p.riding);
      p.vx += v.x; p.vy += v.y;
      p.riding = null;
    }
  }

  const from = { x: p.x, y: p.y };
  let nx = p.x + p.vx * dt;
  let ny = p.y + p.vy * dt;

  if (p.riding && t) {
    /**
     * Inside the cabin. Rather than refusing the move, the position is
     * CLAMPED to the walls in the vehicle's own frame, so walking into the
     * side slides you along it towards a doorway instead of stopping you
     * dead — which is what you are trying to do anyway when your stop is
     * coming up.
     */
    const v = vehicleById(t.city, p.riding, t.time);
    if (v) {
      const c = cabin(t.city, v);
      const L = toLocal(v, nx, ny);
      const aboveDeck = p.h - c.b.deck;
      let { lx, ly } = L;
      if (Math.abs(lx) > c.halfL && !(c.vaultable && aboveDeck >= c.b.wall - 0.02)) {
        lx = Math.sign(lx) * c.halfL;
        p.vx = 0;
      }
      if (Math.abs(ly) > c.halfW && !throughSide(t.city, v, lx, aboveDeck)) {
        ly = Math.sign(ly) * c.halfW;
        p.vy = 0;
      }
      if (lx !== L.lx || ly !== L.ly) {
        const w = toWorld(v, lx, ly);
        nx = w.x; ny = w.y;
      }
    }
  } else {
    /**
     * Bodywork is solid from outside too.
     *
     * Without this the doors are decoration: a vehicle is not an obstacle to
     * anyone standing in the road, so you walk straight through the side of a
     * parked tram, end up in the middle of the floor plan, and are quietly
     * lifted onto the deck. Every rule about doorways applies to getting in as
     * well as getting out, and it takes making the sides real to enforce it.
     *
     * A move only counts as blocked if it takes you from outside a body to
     * inside one. Anything that is already inside — because a bus drove onto
     * it — has to be able to walk back out.
     */
    const insideBody = (v: Vehicle, x: number, y: number) => {
      if (Math.abs(v.x - x) > 26 || Math.abs(v.y - y) > 26) return false;
      return overVehicle(t2City!, v, x, y);
    };
    const barred = (x: number, y: number) => {
      if (!t) return false;
      for (const v of t.vehicles) {
        if (!insideBody(v, x, y)) continue;
        if (insideBody(v, from.x, from.y)) continue;   // already in it; let them out
        const c = cabin(t.city, v);
        if (c.vaultable && p.h - c.b.deck >= c.b.wall - 0.02) continue;   // over the side
        if (c.open && inDoorway(c.mode, toLocal(v, x, y).lx)) continue;   // through the door
        return true;
      }
      return false;
    };

    // On foot: streets only, never across open water, and not through a bus.
    const clear = (x: number, y: number) =>
      onStreet(g.streets, { x, y })
      && !illegalCrossing(g.river, from, { x, y }, CITY.bridgeRadius)
      && !barred(x, y);
    if (!onStreet(g.streets, from)) {
      // Off the grid somehow. Walk back on rather than being stuck forever,
      // which is the one failure a player can neither diagnose nor escape.
      const back = snapToStreet(g.streets, from);
      const d = Math.hypot(back.x - from.x, back.y - from.y) || 1;
      nx = from.x + ((back.x - from.x) / d) * WALK.speed * dt;
      ny = from.y + ((back.y - from.y) / d) * WALK.speed * dt;
      p.vx = 0; p.vy = 0;
    } else if (!clear(nx, ny)) {
      // Axis-separated, so a diagonal into a corner slides you round it
      // rather than sticking you to it.
      if (clear(nx, p.y)) { ny = p.y; p.vy = 0; }
      else if (clear(p.x, ny)) { nx = p.x; p.vx = 0; }
      else { nx = p.x; ny = p.y; p.vx = 0; p.vy = 0; }
    }
  }

  p.x = Math.min(CITY.width, Math.max(0, nx));
  p.y = Math.min(CITY.height, Math.max(0, ny));

  // ── vertical, and what you land on ──────────────────────────────────────
  const wasAt = p.h;
  p.vh -= PLAYER.gravity * dt;
  p.h += p.vh * dt;

  /**
   * Look for a floor anywhere between where the feet started this tick and
   * where they ended it, not just where they ended.
   *
   * Coming down onto a deck, the tick that matters takes the feet from just
   * above it to just below — and testing only the final height means the deck
   * is rejected for being higher than your feet on the very tick you should
   * have landed on it. You fall straight through the bus. It survived the
   * tests because they all boarded from the ground, where the step-up
   * allowance hid it.
   */
  const reach = p.grounded ? PLAYER.step : 0;
  let deck = t
    ? deckUnder(t.city, t.vehicles, p.x, p.y, Math.max(wasAt, p.h), reach, p.riding)
    : null;

  /**
   * You cannot arrive on a deck through the side of the bodywork.
   *
   * Without this, walking past a stationary tram lifts you straight through
   * its wall and onto the floor, because gaining a deck is decided by the
   * floor plan and the floor plan does not know about walls. Getting IN has
   * to obey the same rules as getting out: through an open doorway, or over
   * the side if the side is low enough to clear.
   */
  if (deck && t && deck.vehicle.id !== p.riding) {
    const c = cabin(t.city, deck.vehicle);
    const L = toLocal(deck.vehicle, p.x, p.y);
    const inside = Math.abs(L.ly) <= c.halfW && Math.abs(L.lx) <= c.halfL;
    const overTheTop = c.vaultable && Math.max(wasAt, p.h) - c.b.deck >= c.b.wall - 0.02;
    const throughDoor = c.open && inDoorway(c.mode, L.lx);
    if (!inside && !overTheTop && !throughDoor) deck = null;
  }

  const floor = deck ? deck.height : 0;
  const landing = deck ? deck.vehicle.id : null;

  if (p.h <= floor + 1e-6 && p.vh <= 0) {
    p.h = floor;
    p.vh = 0;
    p.grounded = true;
    if (landing !== p.riding) {
      // Changed surface. Rebase the velocity: what was relative to the old
      // support has to become relative to the new one.
      if (p.riding) { const v = velOf(p.riding); p.vx += v.x; p.vy += v.y; }
      if (landing) { const v = velOf(landing); p.vx -= v.x; p.vy -= v.y; }
      p.riding = landing;
    }
  } else {
    if (p.grounded && p.riding) {
      // Walked off the edge of a moving deck without jumping.
      const v = velOf(p.riding);
      p.vx += v.x; p.vy += v.y;
      p.riding = null;
    }
    p.grounded = false;
    if (landing === null) p.riding = null;
  }
}
