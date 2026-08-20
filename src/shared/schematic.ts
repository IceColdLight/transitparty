/**
 * The map view's coordinates — and the lie in them.
 *
 * A transit diagram is not a map. Beck's insight was that a passenger needs
 * the ORDER of the stations and the shape of the interchanges, and that
 * geography actively gets in the way of both: the central stations are packed
 * into a smudge you cannot read, and the outer ones waste two thirds of the
 * sheet. Every real diagram since has enlarged the middle and compressed the
 * edges, and every real passenger has at some point walked between two
 * stations that looked a long way apart.
 *
 * That is the mechanic here, not a stylistic flourish. The player plans on the
 * schematic and executes in the geographic world, and the two disagree —
 * "two stops" on the map can be a four-hundred-metre walk on the ground, and
 * a hop that looks trivial can be on the wrong side of the river.
 *
 * The distortion is a radial power curve about the city centre, which is the
 * cheapest honest version of what Beck did by hand. `tests/schematic.test.ts`
 * checks the map actually lies — a map that told the truth would quietly turn
 * the game back into one view.
 */
import { CITY } from './constants.js';
import type { City } from './types.js';

type Pt = { x: number; y: number };

/** Below 1 expands the middle and squashes the outskirts. */
const EXPONENT = 0.62;

export function warp(p: Pt): Pt {
  const cx = CITY.width / 2, cy = CITY.height / 2;
  const R = Math.hypot(cx, cy);
  const dx = p.x - cx, dy = p.y - cy;
  const r = Math.hypot(dx, dy);
  if (r < 1e-6) return { x: cx, y: cy };
  const rr = R * Math.pow(r / R, EXPONENT);
  return { x: cx + (dx / r) * rr, y: cy + (dy / r) * rr };
}

export function schematicStops(city: City): Pt[] {
  return city.stops.map(warp);
}
