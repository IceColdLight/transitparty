/**
 * A route planner over the network graph.
 *
 * This is not the player's tool — the player plans by looking at the map. It
 * exists so the GENERATOR can ask "is this city worth racing across?" before
 * anyone is dropped into it, and so the tests can hold that question to an
 * answer. A random network is very easy to build and very easy to build badly:
 * unreachable, or a single ride end to end, or close enough to walk.
 *
 * Waiting is modelled as headway/2, the honest average for a passenger who
 * turns up without consulting a timetable. The real game gives you live
 * departures, so a good player beats this estimate — that is the point. `par`
 * is a sanity bound, not a target.
 */
import { CITY, WALK } from './constants.js';
import { type River, illegalCrossing } from './river.js';
import type { Line, Stop } from './types.js';

/**
 * `river` is optional only so a test can ask what the network would be like
 * without it. In the game it is always present, and leaving it out quietly
 * turns the city back into the mesh that river.ts exists to prevent.
 */
export type Net = { stops: Stop[]; lines: Line[]; river?: River };

export type Leg =
  | { kind: 'walk'; from: number; to: number; time: number }
  | { kind: 'ride'; line: number; from: number; to: number; stops: number; time: number };

export type Route = {
  /** seconds, including estimated waiting */
  time: number;
  /** boards after the first one */
  transfers: number;
  legs: Leg[];
};

/** Straight-line walking time between two stops, in seconds. */
export function walkTime(net: Net, a: number, b: number): number {
  const p = net.stops[a], q = net.stops[b];
  return Math.hypot(p.x - q.x, p.y - q.y) / WALK.speed;
}

/** Stops reachable on foot from each stop, with the walk already costed. */
export function walkNeighbours(net: Net): { to: number; time: number }[][] {
  const out: { to: number; time: number }[][] = net.stops.map(() => []);
  for (let i = 0; i < net.stops.length; i++) {
    for (let j = i + 1; j < net.stops.length; j++) {
      const d = Math.hypot(net.stops[i].x - net.stops[j].x, net.stops[i].y - net.stops[j].y);
      if (d > WALK.transferMax) continue;
      // Two stops can be 90m apart and still be an hour's walk from each
      // other if the water is between them. The planner has to know that or
      // it will confidently route you into a riverbank.
      if (net.river && illegalCrossing(net.river, net.stops[i], net.stops[j], CITY.bridgeRadius)) continue;
      const t = d / WALK.speed;
      out[i].push({ to: j, time: t });
      out[j].push({ to: i, time: t });
    }
  }
  return out;
}

/** A binary min-heap. Small enough to be worth not pulling in a dependency. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.v[0];
    const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Nodes are (stop, what you are on): slot 0 is "standing here on foot", slot
 * k+1 is "aboard the k'th line that calls here". Splitting the node by line is
 * what makes a transfer cost something — staying aboard is free, getting off
 * and onto another line pays a fresh wait.
 */
export function bestRoute(net: Net, from: number, to: number, walkNb?: ReturnType<typeof walkNeighbours>): Route | null {
  if (from === to) return { time: 0, transfers: 0, legs: [] };
  const nb = walkNb ?? walkNeighbours(net);
  const n = net.stops.length;

  const base: number[] = new Array(n);
  let total = 0;
  for (let s = 0; s < n; s++) { base[s] = total; total += 1 + net.stops[s].lines.length; }

  const foot = (s: number) => base[s];
  const aboard = (s: number, lineId: number) => {
    const k = net.stops[s].lines.indexOf(lineId);
    return k < 0 ? -1 : base[s] + 1 + k;
  };

  const INF = Infinity;
  const dist = new Float64Array(total).fill(INF);
  const boards = new Int32Array(total).fill(0);
  const prev = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);

  const start = foot(from);
  dist[start] = 0;
  const heap = new Heap();
  heap.push(0, start);

  const relax = (u: number, v: number, w: number, board: boolean) => {
    const d = dist[u] + w;
    const b = boards[u] + (board ? 1 : 0);
    // Ties on time are broken toward fewer boards: a route that waits the same
    // and changes less is the one a person would actually call better.
    if (d < dist[v] - 1e-9 || (Math.abs(d - dist[v]) < 1e-9 && b < boards[v])) {
      dist[v] = d; boards[v] = b; prev[v] = u;
      heap.push(d, v);
    }
  };

  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;

    // Which stop and which slot is this?
    let s = 0;
    // base is sorted, so binary search it
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (base[mid] <= u) { s = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const slot = u - base[s];

    if (slot === 0) {
      if (s === to) break;
      for (const w of nb[s]) relax(u, foot(w.to), w.time, false);
      for (const lineId of net.stops[s].lines) {
        relax(u, aboard(s, lineId), net.lines[lineId].headway / 2, true);
      }
    } else {
      const lineId = net.stops[s].lines[slot - 1];
      const line = net.lines[lineId];
      relax(u, foot(s), 0, false);
      const i = line.stops.indexOf(s);
      if (i > 0) {
        const p = line.stops[i - 1];
        relax(u, aboard(p, lineId), line.legs[i - 1] + line.dwell, false);
      }
      if (i >= 0 && i < line.stops.length - 1) {
        const q = line.stops[i + 1];
        relax(u, aboard(q, lineId), line.legs[i] + line.dwell, false);
      }
    }
  }

  const goal = foot(to);
  if (dist[goal] === INF) return null;

  // Walk the predecessors back and collapse consecutive rides on one line
  // into a single leg, which is how a person describes the journey.
  const chain: number[] = [];
  for (let u = goal; u !== -1; u = prev[u]) chain.push(u);
  chain.reverse();

  const stopOf = (node: number) => {
    let lo = 0, hi = n - 1, s = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (base[mid] <= node) { s = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return s;
  };
  const slotOf = (node: number) => node - base[stopOf(node)];

  const legs: Leg[] = [];
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const sa = stopOf(a), sb = stopOf(b);
    const ka = slotOf(a), kb = slotOf(b);
    if (ka === 0 && kb === 0) {
      legs.push({ kind: 'walk', from: sa, to: sb, time: dist[b] - dist[a] });
    } else if (ka > 0 && kb > 0) {
      const lineId = net.stops[sa].lines[ka - 1];
      const last = legs[legs.length - 1];
      if (last && last.kind === 'ride' && last.line === lineId && last.to === sa) {
        last.to = sb; last.stops++; last.time += dist[b] - dist[a];
      } else {
        legs.push({ kind: 'ride', line: lineId, from: sa, to: sb, stops: 1, time: dist[b] - dist[a] });
      }
    }
    // board (foot -> aboard) and alight (aboard -> foot) fold into the ride's cost
    else if (ka === 0 && kb > 0) {
      const lineId = net.stops[sb].lines[kb - 1];
      legs.push({ kind: 'ride', line: lineId, from: sb, to: sb, stops: 0, time: dist[b] - dist[a] });
    }
  }

  return { time: dist[goal], transfers: Math.max(0, boards[goal] - 1), legs };
}
