/**
 * The river, and why it is not scenery.
 *
 * The first cities were a mesh. Eighteen lines across a compact city, all
 * crossing each other, plus a 260m walking transfer, and the network came out
 * small-world: over 25 generated cities and 100 candidate races, the optimal
 * route needed two changes exactly ONCE. Everything was one change from
 * everything, so the map was not worth reading — any plausible-looking route
 * was within a few seconds of the best one, and the race collapsed into a
 * footrace to the nearest stop.
 *
 * A city needs a chokepoint. This one gets water: a river cuts it in two, you
 * cannot walk across it except at a bridge, and only a few LINES cross at all.
 * That single constraint is what puts structure back in — getting to the far
 * bank means committing to one of a handful of crossings, and choosing the
 * wrong one is a route you cannot rescue by walking.
 */
export type Pt = { x: number; y: number };
export type River = {
  /** the water, as a polyline right across the map */
  poly: Pt[];
  /** the only places anything gets across */
  bridges: Pt[];
};

/**
 * Is this point in the water?
 *
 * `illegalCrossing` stops you walking ACROSS the river, which is not the same
 * thing as stopping you walking INTO it: the street grid runs on regardless of
 * where the water is, so before this you could stroll off the quay and stand
 * halfway to the far bank on nothing at all. The channel is a hole in the
 * ground now, and this is the rule that matches.
 */
export function inChannel(river: River, p: Pt, channel: number, bridgeRadius: number): boolean {
  if (nearestOnRiver(river, p).dist > channel) return false;
  return !river.bridges.some((b) => Math.hypot(b.x - p.x, b.y - p.y) < bridgeRadius);
}

/**
 * Which way the water runs nearest this point.
 *
 * Everything that has to draw something ACROSS the river — a bridge rung on
 * the map, a camera looking over it — needs this, and the trick they all used
 * instead was to sample a point a metre to one side and read the offset back.
 * That works only while the river runs diagonally. It runs along the street
 * grid now, so the offset came back as zero and every bridge on the map was
 * drawn pointing the same way.
 */
export function directionAt(river: River, p: Pt): Pt {
  let best = 1, bd = Infinity;
  for (let i = 1; i < river.poly.length; i++) {
    const a = river.poly[i - 1], b = river.poly[i];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bd) { bd = d; best = i; }
  }
  const a = river.poly[best - 1], b = river.poly[best];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** Where two segments cross, or null. */
export function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/**
 * Does going from `a` to `b` cross the water somewhere there is no bridge?
 * Returns the offending point, or null if the move is legal. A crossing within
 * `bridgeRadius` of a bridge is what a bridge IS.
 */
export function illegalCrossing(river: River, a: Pt, b: Pt, bridgeRadius: number): Pt | null {
  for (let i = 1; i < river.poly.length; i++) {
    const hit = segIntersect(a, b, river.poly[i - 1], river.poly[i]);
    if (!hit) continue;
    let bridged = false;
    for (const br of river.bridges) {
      if (Math.hypot(br.x - hit.x, br.y - hit.y) <= bridgeRadius) { bridged = true; break; }
    }
    if (!bridged) return hit;
  }
  return null;
}

/** Which bank a point is on: +1 or -1. Arbitrary but consistent. */
export function bankOf(river: River, p: Pt): 1 | -1 {
  let bestD = Infinity, side: 1 | -1 = 1;
  for (let i = 1; i < river.poly.length; i++) {
    const a = river.poly[i - 1], b = river.poly[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD) {
      bestD = d;
      side = (dx * (p.y - a.y) - dy * (p.x - a.x)) >= 0 ? 1 : -1;
    }
  }
  return side;
}

/** The point on the river nearest `p`, for placing bridges and drawing. */
export function nearestOnRiver(river: River, p: Pt): { x: number; y: number; dist: number } {
  let best = { x: river.poly[0].x, y: river.poly[0].y, dist: Infinity };
  for (let i = 1; i < river.poly.length; i++) {
    const a = river.poly[i - 1], b = river.poly[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < best.dist) best = { x: px, y: py, dist: d };
  }
  return best;
}
