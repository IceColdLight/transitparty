/**
 * What stands on each block.
 *
 * This lives in shared rather than in the renderer because it is a property of
 * the CITY, not of the picture: a plot with nothing on it is land the player
 * can see and cannot walk on, which reads as an invisible wall, and that is a
 * thing worth being able to test rather than notice.
 *
 * Walking stays confined to the streets — the pedestrian graph the route
 * planner shares is built from them — so the answer to a bare plot is never to
 * open it up. It is to make sure there is something there, and to fence the
 * few places where there cannot be.
 */
import { CITY } from './constants.js';
import { nearestOnRiver } from './river.js';
import { rectsOverlap, type Rect } from './stations.js';
import type { City } from './types.js';

export type Footprint = { x: number; y: number; w: number; d: number; h: number; tone: number };

/** Stable pseudo-randomness for a point, so buildings vary and never shimmer. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(Math.round(x), 73856093) ^ Math.imul(Math.round(y), 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** How far a building has to keep clear of the viaduct it would otherwise hit. */
export const VIADUCT_CLEARANCE = 15;

/** The legs of every elevated line — the only rail that occupies the surface. */
export function viaductLegs(city: City) {
  const segs: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const line of city.lines) {
    if (line.mode !== 'train') continue;
    for (let i = 0; i + 1 < line.stops.length; i++) {
      const a = city.stops[line.stops[i]], b = city.stops[line.stops[i + 1]];
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  return segs;
}

/**
 * The strip of ground a viaduct leg needs, as a rectangle.
 *
 * The ends are pushed out by the clearance as well, so that where two legs
 * meet at an angle the outside of the bend is covered — square ends leave a
 * wedge at every corner, and a wedge at a corner is a building with a railway
 * through it.
 */
export function viaductStrips(city: City): Rect[] {
  const out: Rect[] = [];
  for (const s of viaductLegs(city)) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    out.push({
      x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2,
      angle: Math.atan2(dy, dx),
      hl: len / 2 + VIADUCT_CLEARANCE, hw: VIADUCT_CLEARANCE,
    });
  }
  return out;
}

/**
 * Is this plot in the way of something at street level?
 *
 * ONLY the viaduct and the elevated stations. A metro is in a tunnel and a
 * building above it is exactly right — clearing those as well, a habit left
 * over from when rail ran on the road, left long strips of visible land nobody
 * could walk on.
 */
export function blockedBySurfaceRail(city: City, plot: Rect): boolean {
  for (const strip of viaductStrips(city)) if (rectsOverlap(plot, strip)) return true;
  for (const st of city.stations) {
    if (st.level <= 0) continue;   // underground takes up no ground
    if (rectsOverlap(plot, st.hall) || rectsOverlap(plot, st.passage)) return true;
    // A flight of stairs UP stands on the pavement; one going down does not.
    if (rectsOverlap(plot, st.shaft)) return true;
  }
  return false;
}

/**
 * Is any of this plot in the water?
 *
 * Blocks are cut by the street grid and know nothing about the river, so a
 * block that straddles it gets built on like any other — twenty-nine buildings
 * per city were standing in the channel, which among other things is why the
 * water was invisible from the street: the river was paved over by the ground
 * and then built on top of.
 *
 * Nine samples rather than an exact rectangle-to-polyline distance. The
 * channel is a hundred metres wide and a plot is seventy, so the corners and
 * the edge midpoints leave nothing worth finding.
 */
export function inTheWater(city: City, r: Rect): boolean {
  for (const u of [-1, 0, 1]) {
    for (const v of [-1, 0, 1]) {
      const p = { x: r.x + u * r.hl, y: r.y + v * r.hw };
      if (nearestOnRiver(city.river, p).dist < CITY.channel) return true;
    }
  }
  return false;
}

/** Every building on every block, as flat rectangles with a height. */
export function footprintsOf(city: City): Footprint[] {
  const out: Footprint[] = [];
  for (const b of city.blocks) {
    if (b.park) continue;
    const cols = Math.max(1, Math.min(4, Math.round(b.w / 78)));
    const rows = Math.max(1, Math.min(4, Math.round(b.h / 78)));
    const cw = b.w / cols, ch = b.h / rows;
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const gx = b.x + cx * cw, gy = b.y + cy * ch;
        const n = hash2(gx, gy);
        const inset = 1 + n * 2.5;
        const w = cw - inset * 2, d = ch - inset * 2;
        if (w < 6 || d < 6) continue;
        const px = gx + inset + w / 2, py = gy + inset + d / 2;
        // The whole footprint, not a circle inside it: a viaduct clearing the
        // middle of a plot by a metre still goes through both its corners.
        const plot: Rect = { x: px, y: py, angle: 0, hl: w / 2, hw: d / 2 };
        if (blockedBySurfaceRail(city, plot) || inTheWater(city, plot)) continue;
        out.push({ x: px, y: py, w, d, h: 11 + n * 34 + hash2(gy, gx) * 12, tone: n });
      }
    }
  }
  return out;
}
