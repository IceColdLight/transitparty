/**
 * The street grid — and it is load-bearing three times over.
 *
 * 1. It is the only thing you can WALK on. Everything else is a building.
 * 2. Buses and trams are laid along it, because a bus that cuts diagonally
 *    across a block is a bus that is not on a road.
 * 3. Metros and trains ignore it completely, because they are under it and
 *    over it. Their STATIONS still sit on a street — a station you cannot
 *    reach on foot is not a station.
 *
 * The grid is rectilinear and irregular: streets run north-south and east-west
 * at uneven spacings, the way a city that grew has them. That irregularity is
 * the only reason it does not read as graph paper, and it costs nothing.
 *
 * Walking distance is therefore NOT the distance between two points. It is a
 * shortest path over this graph, around blocks and via bridges, and the route
 * planner has to use the same one the player's legs do — otherwise `par` is
 * quoting a journey nobody can make.
 */
import { CITY, PLATFORM } from './constants.js';
import { type Rng, range } from './rng.js';
import { type River, illegalCrossing } from './river.js';

export type Pt = { x: number; y: number };

export type Streets = {
  /** centre lines of the north-south streets, ascending */
  xs: number[];
  /** centre lines of the east-west streets, ascending */
  ys: number[];
  /** carriageway width; you may walk within half of this of a centre line */
  width: number;
};

/** A city block. Buildings are solid; parks are solid too, just prettier. */
export type Block = { x: number; y: number; w: number; h: number; park: boolean };

export function makeStreets(r: Rng): Streets {
  const line = (extent: number) => {
    const out: number[] = [40];
    // Irregular spacing. A fixed pitch reads as graph paper immediately, and
    // the variation is also what gives some blocks a long frontage worth
    // running a tram down.
    while (out[out.length - 1] < extent - 200) out.push(out[out.length - 1] + range(r, 145, 290));
    out.push(extent - 40);
    return out;
  };
  return { xs: line(CITY.width), ys: line(CITY.height), width: 26 };
}

/** Can you stand here? Only if you are on a street. */
export function onStreet(s: Streets, p: Pt): boolean {
  const h = s.width / 2;
  for (const x of s.xs) if (Math.abs(p.x - x) <= h) return true;
  for (const y of s.ys) if (Math.abs(p.y - y) <= h) return true;
  return false;
}

/** The nearest point you could legally stand, for putting a station somewhere real. */
export function snapToStreet(s: Streets, p: Pt): Pt {
  let bx = s.xs[0], by = s.ys[0];
  for (const x of s.xs) if (Math.abs(x - p.x) < Math.abs(bx - p.x)) bx = x;
  for (const y of s.ys) if (Math.abs(y - p.y) < Math.abs(by - p.y)) by = y;
  return Math.abs(bx - p.x) <= Math.abs(by - p.y) ? { x: bx, y: p.y } : { x: p.x, y: by };
}

/** Nearest crossroads — where a bus route is allowed to turn. */
export function nearestJunction(s: Streets, p: Pt): Pt {
  let bx = s.xs[0], by = s.ys[0];
  for (const x of s.xs) if (Math.abs(x - p.x) < Math.abs(bx - p.x)) bx = x;
  for (const y of s.ys) if (Math.abs(y - p.y) < Math.abs(by - p.y)) by = y;
  return { x: bx, y: by };
}

/**
 * A route from `a` to `b` that only ever travels along streets: a staircase of
 * axis-aligned runs, turning at junctions. The returned points are the CORNERS,
 * and every consecutive pair is a straight run down one street — which is what
 * lets a line put a stop at every turn and then treat its own stop list as its
 * true geometry.
 *
 * `wander` adds intermediate junctions, so a bus does not simply take the two
 * legs of an L the way a delivery driver would.
 */
export function streetRoute(s: Streets, r: Rng, a: Pt, b: Pt, wander: number): Pt[] {
  const start = nearestJunction(s, a);
  const end = nearestJunction(s, b);

  const vias: Pt[] = [];
  for (let i = 0; i < wander; i++) {
    const t = (i + 1) / (wander + 1);
    // Offset the midpoint sideways so the route bulges rather than staircasing
    // straight down the diagonal.
    const mx = start.x + (end.x - start.x) * t;
    const my = start.y + (end.y - start.y) * t;
    const spread = Math.hypot(end.x - start.x, end.y - start.y) * 0.22;
    vias.push(nearestJunction(s, {
      x: mx + range(r, -spread, spread),
      y: my + range(r, -spread, spread),
    }));
  }

  const nodes = [start, ...vias, end];
  const out: Pt[] = [start];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const p = out[out.length - 1], q = nodes[i + 1];
    if (Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1) continue;
    // Turn once, in a random order, so routes are not all the same shape.
    if (r() < 0.5) {
      if (Math.abs(q.x - p.x) > 1) out.push({ x: q.x, y: p.y });
    } else {
      if (Math.abs(q.y - p.y) > 1) out.push({ x: p.x, y: q.y });
    }
    out.push(q);
  }
  // Drop any zero-length run left by a via that landed on the path already.
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 1);
}

/** The blocks between the streets — everything you cannot walk on. */
export function makeBlocks(s: Streets, r: Rng): Block[] {
  const out: Block[] = [];
  const h = s.width / 2;
  for (let i = 0; i + 1 < s.xs.length; i++) {
    for (let j = 0; j + 1 < s.ys.length; j++) {
      const x = s.xs[i] + h, y = s.ys[j] + h;
      const w = s.xs[i + 1] - s.xs[i] - s.width;
      const hh = s.ys[j + 1] - s.ys[j] - s.width;
      if (w < 20 || hh < 20) continue;
      out.push({ x, y, w, h: hh, park: r() < 0.09 });
    }
  }
  return out;
}

/**
 * Where the river can be crossed: the points at which a street runs into it.
 * Bridges belong on streets — a bridge in the middle of a block is a bridge
 * you have to climb a building to reach.
 */
export function bridgeSites(s: Streets, river: River): Pt[] {
  const sites: { p: Pt; t: number }[] = [];
  const push = (p: Pt, t: number) => {
    if (p.x < 60 || p.x > CITY.width - 60 || p.y < 60 || p.y > CITY.height - 60) return;
    sites.push({ p, t });
  };
  for (let i = 1; i < river.poly.length; i++) {
    const a = river.poly[i - 1], b = river.poly[i];
    for (const x of s.xs) {
      if ((a.x - x) * (b.x - x) > 0) continue;
      const u = Math.abs(b.x - a.x) < 1e-9 ? 0 : (x - a.x) / (b.x - a.x);
      push({ x, y: a.y + (b.y - a.y) * u }, i + u);
    }
    for (const y of s.ys) {
      if ((a.y - y) * (b.y - y) > 0) continue;
      const u = Math.abs(b.y - a.y) < 1e-9 ? 0 : (y - a.y) / (b.y - a.y);
      push({ x: a.x + (b.x - a.x) * u, y }, i + u);
    }
  }
  sites.sort((p, q) => p.t - q.t);
  return sites.map((s2) => s2.p);
}

/**
 * The pedestrian graph.
 *
 * Nodes are every junction plus every station. For each street, everything
 * sitting on it is sorted along its length and joined to its neighbours, so a
 * station in the middle of a block frontage is connected to the two junctions
 * either side of it and to any other station between them. Edges that would
 * cross open water are simply not created.
 */
export type WalkGraph = {
  pos: Pt[];
  adj: { to: number; w: number }[][];
  /** node index for each stop id */
  stopNode: number[];
};

export function buildWalkGraph(s: Streets, river: River, stops: Pt[]): WalkGraph {
  const pos: Pt[] = [];
  for (const x of s.xs) for (const y of s.ys) pos.push({ x, y });
  const stopNode = stops.map((p) => { pos.push({ x: p.x, y: p.y }); return pos.length - 1; });

  const adj: { to: number; w: number }[][] = pos.map(() => []);
  const link = (i: number, j: number) => {
    if (illegalCrossing(river, pos[i], pos[j], CITY.bridgeRadius)) return;
    const w = Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
    adj[i].push({ to: j, w });
    adj[j].push({ to: i, w });
  };

  const eps = 1.0;
  for (const x of s.xs) {
    const on = pos.map((p, i) => ({ p, i })).filter((n) => Math.abs(n.p.x - x) <= eps);
    on.sort((a, b) => a.p.y - b.p.y);
    for (let k = 1; k < on.length; k++) link(on[k - 1].i, on[k].i);
  }
  for (const y of s.ys) {
    const on = pos.map((p, i) => ({ p, i })).filter((n) => Math.abs(n.p.y - y) <= eps);
    on.sort((a, b) => a.p.x - b.p.x);
    for (let k = 1; k < on.length; k++) link(on[k - 1].i, on[k].i);
  }
  return { pos, adj, stopNode };
}

/** Shortest walking distance from one node to everywhere, in metres. */
export function walkDistances(g: WalkGraph, from: number, limit = Infinity): Float64Array {
  const dist = new Float64Array(g.pos.length).fill(Infinity);
  dist[from] = 0;
  // A tiny binary heap; the graph is a few hundred nodes and this runs a lot.
  const keys: number[] = [0], vals: number[] = [from];
  const swap = (a: number, b: number) => {
    [keys[a], keys[b]] = [keys[b], keys[a]];
    [vals[a], vals[b]] = [vals[b], vals[a]];
  };
  const push = (k: number, v: number) => {
    keys.push(k); vals.push(v);
    let i = keys.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= keys[i]) break; swap(p, i); i = p; }
  };
  const pop = () => {
    const top = vals[0];
    const lk = keys.pop()!, lv = vals.pop()!;
    if (keys.length) {
      keys[0] = lk; vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, rr = l + 1;
        let m = i;
        if (l < keys.length && keys[l] < keys[m]) m = l;
        if (rr < keys.length && keys[rr] < keys[m]) m = rr;
        if (m === i) break;
        swap(m, i); i = m;
      }
    }
    return top;
  };

  const done = new Uint8Array(g.pos.length);
  while (keys.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (dist[u] > limit) break;
    for (const e of g.adj[u]) {
      const d = dist[u] + e.w;
      if (d < dist[e.to]) { dist[e.to] = d; push(d, e.to); }
    }
  }
  return dist;
}

/**
 * Where you wait for a vehicle: beside the road, not in it. Which side is
 * arbitrary but must be stable, so it comes from the stop's own id.
 */
export function platformAt(s: Streets, p: Pt, id: number): Pt {
  const h = s.width / 2;
  const onVertical = s.xs.some((x) => Math.abs(p.x - x) <= h);
  const onHorizontal = s.ys.some((y) => Math.abs(p.y - y) <= h);
  const bits = Math.imul(id, 2654435761) >>> 0;
  const side = bits % 2 === 0 ? 1 : -1;
  const other = (bits >> 1) % 2 === 0 ? 1 : -1;

  /**
   * At a CROSSROADS the platform has to come off both centre lines, not one.
   *
   * Stepping five metres sideways off a north-south street leaves you standing
   * squarely in the middle of the east-west one, and everything driving down
   * it goes straight over you. Interchanges are crossroads and origins are
   * interchanges, so this hit the start of a round: players spawned in traffic
   * and were carried off before the clock started.
   */
  if (onVertical && onHorizontal) {
    return { x: p.x + side * PLATFORM.offset, y: p.y + other * PLATFORM.offset };
  }
  return onVertical
    ? { x: p.x + side * PLATFORM.offset, y: p.y }
    : { x: p.x, y: p.y + side * PLATFORM.offset };
}
