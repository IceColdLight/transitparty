/**
 * Levels: the metro runs in a tunnel, the train on a viaduct, and getting to
 * either means finding the stairs.
 *
 * Until now every mode ran on the street and a station was a sign on a pole.
 * That made rail a thing you walked up to, which is not what a metro is — and
 * it left the game with only one plane to navigate. A station you have to go
 * DOWN into is a second kind of wayfinding: you surface somewhere and have to
 * work out where you are, and a transfer from the metro to a bus is a climb
 * rather than a step sideways.
 *
 * The geometry is deliberately two rectangles per station and nothing else:
 *
 *   hall   the platform box, centred on the stop, lying along the line's own
 *          direction at that point, floored at the line's level
 *   shaft  a ramp from a doorway on the street down (or up) into the middle of
 *          the hall. It is the staircase, and it is the only way through
 *
 * The rule that makes two levels work at all is that a point can have MORE
 * THAN ONE floor — the road above and the platform below — and you stand on
 * whichever is nearest beneath your feet. Inside a shaft the road is
 * suppressed, which is what turns a doorway into a hole you can descend.
 */
import { PLAYER } from './constants.js';
import type { City } from './types.js';
import type { Pt } from './river.js';

export type Station = {
  stop: number;
  mode: 'metro' | 'train';
  /** floor height of the platform: below the street for a metro, above for a train */
  level: number;
  hall: Rect;
  /**
   * Half the width of the track bed inside the hall, measured from its middle.
   * The tracks sit at the line's own lane offsets, NOT on the centre of the
   * station, so this has to be derived from them — assuming otherwise put the
   * rails up through the platform and parked the train on the pavement.
   */
  trackHalf: number;
  /** runs from its street end (height 0) to its far end (height `level`) */
  shaft: Rect;
  /** the corridor from the foot of the stairs to the platform, all at `level` */
  passage: Rect;
  /** the drop from the platform to the track bed — the vehicle's floor height */
  deck: number;
};

/**
 * Which way the line runs THROUGH a stop: the bisector of the leg arriving and
 * the leg leaving.
 *
 * Not either leg on its own, and that matters. The hall used to take the leg
 * arriving while the vehicle standing in it took the leg leaving, so at any
 * bend the platform and the train pointed different ways — by the whole turn,
 * not half of it — and one in eight trains stood with its nose outside its own
 * station. The bisector is the one axis both can agree on, and it splits
 * whatever bend is left evenly between the two directions of travel.
 */
export function alignmentAt(prev: Pt | null, here: Pt, next: Pt | null): number {
  const unit = (a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const into = prev ? unit(prev, here) : null;
  const outOf = next ? unit(here, next) : null;
  if (!into) return Math.atan2(outOf!.y, outOf!.x);
  if (!outOf) return Math.atan2(into.y, into.x);
  const mx = into.x + outOf.x, my = into.y + outOf.y;
  // A perfect reversal has no bisector; fall back to the leg being left on.
  if (Math.hypot(mx, my) < 1e-6) return Math.atan2(outOf.y, outOf.x);
  return Math.atan2(my, mx);
}

/** An oriented rectangle: centre, heading, and half-extents along and across. */
export type Rect = { x: number; y: number; angle: number; hl: number; hw: number };

export function inRect(r: Rect, x: number, y: number, grow = 0): boolean {
  const dx = x - r.x, dy = y - r.y;
  const c = Math.cos(-r.angle), s = Math.sin(-r.angle);
  return Math.abs(dx * c - dy * s) <= r.hl + grow && Math.abs(dx * s + dy * c) <= r.hw + grow;
}

/**
 * Do two oriented rectangles overlap? Four separating axes and no more, which
 * is all a pair of rectangles can offer.
 *
 * This exists because everything in the city that has to keep out of the way
 * of everything else is a rectangle — a building, a station hall, a corridor,
 * the strip of land a viaduct needs — and the alternative, testing a CIRCLE
 * around each one, is wrong in the direction that shows: it under-covers the
 * corners, which is exactly where a viaduct ends up inside a building.
 */
export function rectsOverlap(a: Rect, b: Rect, grow = 0): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const th of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ra = Math.abs(Math.cos(a.angle - th)) * a.hl + Math.abs(Math.sin(a.angle - th)) * a.hw;
    const rb = Math.abs(Math.cos(b.angle - th)) * b.hl + Math.abs(Math.sin(b.angle - th)) * b.hw;
    if (Math.abs(dx * Math.cos(th) + dy * Math.sin(th)) > ra + rb + grow) return false;
  }
  return true;
}

/** How far across a rectangle a point lies, from its centre line. */
export function acrossRect(r: Rect, x: number, y: number): number {
  const dx = x - r.x, dy = y - r.y;
  const c = Math.cos(-r.angle), s = Math.sin(-r.angle);
  return Math.abs(dx * s + dy * c);
}

/** How far along a rectangle a point lies, 0 at one end and 1 at the other. */
function alongRect(r: Rect, x: number, y: number): number {
  const dx = x - r.x, dy = y - r.y;
  const c = Math.cos(-r.angle), s = Math.sin(-r.angle);
  const lx = dx * c - dy * s;
  return Math.max(0, Math.min(1, (lx + r.hl) / (2 * r.hl)));
}

export type Footing = {
  /** every floor at this point, in no particular order */
  floors: number[];
  /** true inside a stairwell, where the road overhead is a hole */
  inShaft: boolean;
};

/**
 * Every floor under (or over) a given point.
 *
 * The street is added by the caller, which knows about roads; this only knows
 * about what has been dug out of them.
 */
export function footingAt(city: City, x: number, y: number): Footing {
  const floors: number[] = [];
  let inShaft = false;
  for (const st of city.stations) {
    if (inRect(st.shaft, x, y)) {
      // The ramp: street height at one end, platform height at the other.
      const h = st.level * alongRect(st.shaft, x, y);
      floors.push(h);
      /**
       * Only a stairwell going DOWN is a hole in the pavement. A staircase
       * rising to a viaduct is a thing standing ON the pavement, and the
       * pavement is still there underneath it — suppressing the street under
       * an ascending flight deleted the road beneath every elevated station.
       */
      if (h < -0.1) inShaft = true;
    } else if (inRect(st.hall, x, y)) {
      /**
       * The platform, or the track bed between the platforms — which is a
       * deck's depth lower, because that is what makes the platform level with
       * the train floor. Without the distinction you walk out over the rails
       * on thin air, which on an elevated station is nine metres of it.
       */
      floors.push(acrossRect(st.hall, x, y) <= st.trackHalf ? st.level - st.deck : st.level);
    } else if (inRect(st.passage, x, y)) {
      floors.push(st.level);
    }
  }
  return { floors, inShaft };
}

/**
 * Does this step walk through the side of a stairwell?
 *
 * A shaft is a slot with walls, not an open trench: you go in at the top and
 * come out at the bottom. Without this you can walk off the side of the stairs
 * halfway down and reappear on the road above, and anybody on the pavement can
 * wander into the hole sideways.
 */
export function crossesShaftWall(city: City, ax: number, ay: number, bx: number, by: number): boolean {
  for (const st of city.stations) {
    const inA = inRect(st.shaft, ax, ay), inB = inRect(st.shaft, bx, by);
    if (inA === inB) continue;
    // An end is a doorway; a side is a wall.
    const t = alongRect(st.shaft, inA ? bx : ax, inA ? by : ay);
    if (t <= 0.02 || t >= 0.98) continue;
    return true;
  }
  return false;
}

/**
 * The floor you are standing on: the highest one that is not above your feet.
 * `reach` is the step you are allowed to take up onto it.
 */
export function pickFloor(floors: number[], feet: number, reach: number): number | null {
  let best: number | null = null;
  for (const f of floors) {
    if (f > feet + reach) continue;
    if (best === null || f > best) best = f;
  }
  return best;
}

/** Is there headroom to stand here, or is this the underside of a platform? */
export const HEADROOM = PLAYER.eye + 0.6;
