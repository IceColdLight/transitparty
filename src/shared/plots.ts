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
import { inRect } from './stations.js';
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
 * Is this plot in the way of something at street level?
 *
 * ONLY the viaduct and the elevated stations. A metro is in a tunnel and a
 * building above it is exactly right — clearing those as well, a habit left
 * over from when rail ran on the road, left long strips of visible land nobody
 * could walk on.
 */
export function blockedBySurfaceRail(city: City, x: number, y: number, r: number): boolean {
  for (const s of viaductLegs(city)) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
    const px = s.ax + dx * u, py = s.ay + dy * u;
    if (Math.hypot(x - px, y - py) < VIADUCT_CLEARANCE + r) return true;
  }
  for (const st of city.stations) {
    if (st.level <= 0) continue;   // underground takes up no ground
    if (inRect(st.hall, x, y, r) || inRect(st.passage, x, y, r)) return true;
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
        if (blockedBySurfaceRail(city, px, py, Math.min(w, d) / 2)) continue;
        out.push({ x: px, y: py, w, d, h: 11 + n * 34 + hash2(gy, gx) * 12, tone: n });
      }
    }
  }
  return out;
}
