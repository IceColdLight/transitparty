/**
 * The city generator.
 *
 * A city is a pure function of one integer. Nothing about the network is ever
 * sent over the wire — the server broadcasts a seed and every client builds
 * the identical network, down to the timetable offsets. That is also why the
 * generator may not touch Date, Math.random or anything else outside its Rng.
 *
 * It is built in layers, in the order a city actually grows:
 *
 *   river    first, because everything else has to respect it
 *   bridges  three, and they are the only way across on foot
 *   hub      one central interchange on the main bank, the Hauptbahnhof
 *   train    two lines, both crossing the river. Four stations each, and you
 *            wait over two minutes — the only quick way across the whole map
 *   metro    four lines. One crosses; the rest are a bank's backbone
 *   tram     five, denser and slower. One crosses
 *   bus      seven winding lines that fill in whatever is left. None cross
 *
 * Two rules do most of the work and neither of them is a lookup table:
 *
 * Interchanges are NOT planned. `CITY.mergeRadius` says two stops closer than
 * 78m are the same station, so a bus laid across a tram is simply absorbed
 * into it. Every transfer in the game is a consequence of geography. An
 * earlier version wired interchanges explicitly and produced a network that
 * looked designed and played like a diagram — every change at a tidy junction,
 * none of them costing you a walk.
 *
 * And only four lines cross the water. That is the chokepoint the first
 * cities lacked; see river.ts for the measurements that forced it.
 */
import {
  BODIES, CITY, FLEET, LANES, LEVELS, MODES, RACE, RAIL, STATION, TEMPO, type ModeId,
} from './constants.js';
import { type Rng, pick, range, rng } from './rng.js';
import { type River, bankOf, illegalCrossing } from './river.js';
import { type Net, bestRoute, pedestrian, walkNeighbours, walkTime } from './routing.js';
import {
  type Block, type Streets, bridgeSites, makeBlocks, makeStreets, nearestJunction,
  onStreet, snapToStreet, streetRoute,
} from './streets.js';
import { alignmentAt, type Station } from './stations.js';
import type { City, Line, Stop } from './types.js';

type Pt = { x: number; y: number };

const HEADS = [
  'Nord', 'Süd', 'Ost', 'West', 'Alt', 'Neu', 'Ober', 'Unter', 'Klein', 'Groß',
  'Hoch', 'Markt', 'Dom', 'Hafen', 'Rosen', 'Linden', 'Berg', 'Stein', 'Feld',
  'Mühl', 'Kaiser', 'Königs', 'Sonnen', 'Wald', 'Eichen', 'Brücken', 'Kirch',
  'Rat', 'Schloss', 'Anger', 'Weiden', 'Birken', 'Fisch', 'Salz', 'Gold',
];
const TAILS = [
  'platz', 'markt', 'tor', 'brücke', 'kai', 'allee', 'straße', 'park', 'garten',
  'hof', 'ring', 'feld', 'berg', 'au', 'damm', 'wall', 'halle', 'bad', 'kreuz',
  'weg', 'ufer', 'steig', 'stadt', 'heim',
];

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);


function clampPt(p: Pt): Pt {
  const m = CITY.margin * 0.5;
  return {
    x: Math.min(CITY.width - m, Math.max(m, p.x)),
    y: Math.min(CITY.height - m, Math.max(m, p.y)),
  };
}

/**
 * A smooth route between two points that is not a straight line. Two sine
 * harmonics, so a corridor wanders the way a real alignment does — following
 * a valley, dodging the old town — without ever doubling back on itself.
 *
 * `bend` is the single knob that separates the modes visually: a train is
 * nearly straight because it was built through everything, a bus sags all over
 * the place because it was built around everything.
 */
function corridor(r: Rng, a: Pt, b: Pt, bend: number): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const h1 = range(r, -1, 1), h2 = range(r, -0.55, 0.55);
  const out: Pt[] = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const off = bend * (h1 * Math.sin(Math.PI * t) + h2 * Math.sin(2 * Math.PI * t));
    out.push(clampPt({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off }));
  }
  return out;
}

/** Every point at which a corridor meets a street, in order along it. */
function crossingsAlong(s: Streets, poly: Pt[]): { t: number; p: Pt }[] {
  const out: { t: number; p: Pt }[] = [];
  let base = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const hit = (u: number) => {
      if (!(u > 0 && u < 1)) return;
      out.push({ t: base + len * u, p: { x: a.x + dx * u, y: a.y + dy * u } });
    };
    if (Math.abs(dx) > 1e-6) for (const x of s.xs) hit((x - a.x) / dx);
    if (Math.abs(dy) > 1e-6) for (const y of s.ys) hit((y - a.y) / dy);
    base += len;
  }
  return out.sort((p, q) => p.t - q.t);
}

/**
 * Rail stops go where the corridor already CROSSES a street.
 *
 * Sampling the corridor at even intervals and then snapping each sample to
 * the nearest street was the obvious way and it is what made every station
 * fight its own rails. The snap keeps one coordinate and moves the other, so
 * a corridor running diagonally has each stop pulled sideways by up to half a
 * block — and alternately, whichever axis happened to be nearer, so the line
 * came out as a zigzag. Two fifths of rail stops turned by more than twenty
 * degrees and one in sixteen by more than ninety: a metro that doubled back
 * on itself between stations. The hall is square to the line and the train
 * arrives along it, so at a kink like that neither can be right.
 *
 * Choosing FROM the crossings buys the same thing the snap was after — a
 * station you can walk to — without moving anything off the alignment. What
 * is left of the turn at a stop is the corridor's own curvature, which is a
 * railway going round a bend rather than a mistake.
 */
function placeAtCrossings(r: Rng, s: Streets, poly: Pt[], spacing: number): Pt[] {
  const xs = crossingsAlong(s, poly);
  if (xs.length < 3) return [];
  /**
   * The spacing is a TARGET divided into the corridor, not a fixed stride.
   * Taken literally it leaves a remainder — and on a short corridor the
   * remainder is the difference between three stops and two, which is the
   * difference between a line and nothing. More than half of all rejected
   * corridors were failing here before the length was divided out.
   */
  const span = xs[xs.length - 1].t;
  const step = span / Math.max(2, Math.round(span / spacing));
  const out: Pt[] = [xs[0].p];
  let last = xs[0].t;
  for (;;) {
    const want = last + step * range(r, 0.86, 1.14);
    let best = -1;
    for (let j = 0; j < xs.length; j++) {
      if (xs[j].t < last + step * 0.5) continue;
      if (best < 0 || Math.abs(xs[j].t - want) < Math.abs(xs[best].t - want)) best = j;
    }
    if (best < 0) break;
    out.push(xs[best].p);
    last = xs[best].t;
  }
  return out;
}

/**
 * The river. Bridges are chosen separately, from the points at which STREETS
 * run into the water — a bridge has to be on a road, or it is a crossing you
 * would have to climb a building to reach. They are then spread along the
 * water rather than placed where they would be convenient, because a crossing
 * you have to go out of your way for is the entire point.
 */
function makeRiver(r: Rng, s: Streets): River {
  const vertical = r() < 0.5;
  const across = vertical ? s.xs : s.ys;
  const along = vertical ? s.ys : s.xs;
  const span = vertical ? CITY.height : CITY.width;
  const width = vertical ? CITY.width : CITY.height;

  /**
   * Where the water will fit: the middle of a gap between two streets wide
   * enough to take the channel and still leave a kerb on both sides.
   */
  const room = 2 * CITY.channel + s.width + 16;
  const gaps = (lines: number[]) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i + 1] - lines[i] >= room) out.push((lines[i] + lines[i + 1]) / 2);
    }
    return out;
  };
  const lanes = gaps(across).filter((v) => v > width * 0.24 && v < width * 0.76);
  const turns = gaps(along).filter((u) => u > span * 0.25 && u < span * 0.75);

  const pts: Pt[] = [];
  const put = (u: number, v: number) => pts.push(vertical ? { x: v, y: u } : { x: u, y: v });

  if (lanes.length < 2 || turns.length < 1) {
    // No room to meander. Straight down the middle of the widest gap there is.
    const all = gaps(across);
    const v = all.length ? all[Math.floor(all.length / 2)] : width / 2;
    put(-80, v);
    put(span + 80, v);
    return { poly: round(pts), bridges: [] };
  }

  /**
   * A staircase down the gaps, never along a street.
   *
   * The river used to be a smooth diagonal drawn without reference to
   * anything, which meant it ran straight through the grid: a dozen streets
   * ended in the middle of the water, the pavements carried on across it, and
   * no road anywhere ran ALONG the bank. A city on a river has an embankment
   * on both sides — that is the most useful road in it — so the water goes
   * between two streets and those two streets become the quays.
   *
   * The legs across are what give it a shape worth navigating: they run down
   * the gaps too, so they cut the perpendicular streets rather than lying on
   * one.
   */
  let k = Math.floor(range(r, 0, lanes.length));
  put(-80, lanes[k]);
  const bends = Math.min(turns.length, 1 + Math.floor(range(r, 0, 2.2)));
  const picked: number[] = [];
  for (let i = 0; i < bends; i++) {
    const u = turns[Math.floor(range(r, 0, turns.length))];
    if (picked.some((p) => Math.abs(p - u) < span * 0.15)) continue;
    picked.push(u);
  }
  picked.sort((p, q) => p - q);
  for (const u of picked) {
    const step = r() < 0.5 ? -1 : 1;
    const next = Math.max(0, Math.min(lanes.length - 1, k + step * (1 + Math.floor(range(r, 0, 2)))));
    if (next === k) continue;
    put(u, lanes[k]);
    put(u, lanes[next]);
    k = next;
  }
  put(span + 80, lanes[k]);
  return { poly: round(pts), bridges: [] };
}

/**
 * Square corners, rounded off and resampled.
 *
 * Two reasons, and the second is the one that bites. A river does not turn a
 * right angle; and the channel is drawn by offsetting this line sideways, so
 * at a square corner the two offsets do not meet and the bank comes out with a
 * notch cut in it. An arc a corner's width across solves both.
 */
function round(pts: Pt[]): Pt[] {
  const R = 70, ARC = 6;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const la = dist(a, b), lc = dist(b, c);
    const ra = Math.min(R, la * 0.45), rc = Math.min(R, lc * 0.45);
    const rad = Math.min(ra, rc);
    const p0 = { x: b.x + (a.x - b.x) / la * rad, y: b.y + (a.y - b.y) / la * rad };
    const p1 = { x: b.x + (c.x - b.x) / lc * rad, y: b.y + (c.y - b.y) / lc * rad };
    out.push(p0);
    for (let k = 1; k < ARC; k++) {
      const t = k / ARC;
      // Quadratic through the corner: near enough an arc at this scale.
      out.push({
        x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * b.x + t * t * p1.x,
        y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * b.y + t * t * p1.y,
      });
    }
    out.push(p1);
  }
  out.push(pts[pts.length - 1]);

  // Resample: the bank is drawn from per-point normals, and a 900m straight
  // with a point at each end has nowhere to put one.
  const fine: Pt[] = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const d = dist(out[i - 1], out[i]);
    const n = Math.max(1, Math.round(d / 30));
    for (let k = 1; k <= n; k++) {
      fine.push({
        x: out[i - 1].x + (out[i].x - out[i - 1].x) * (k / n),
        y: out[i - 1].y + (out[i].y - out[i - 1].y) * (k / n),
      });
    }
  }
  return fine;
}

/** Spread the bridges out along the water, choosing from the street crossings. */
function chooseBridges(sites: Pt[], want: number): Pt[] {
  if (sites.length <= want) return sites.slice();
  const out: Pt[] = [];
  for (let i = 0; i < want; i++) {
    out.push(sites[Math.round(((i + 1) / (want + 1)) * (sites.length - 1))]);
  }
  return out;
}

/**
 * Stops along a street route. Unlike `placeAlong` this ALWAYS keeps the
 * corners, which is what makes a line's stop list its true geometry: every
 * consecutive pair is then a straight run down one street, so a vehicle
 * driving from one to the next stays on the road and never cuts a block.
 */
function placeOnPath(r: Rng, path: Pt[], spacing: number): Pt[] {
  const out: Pt[] = [path[0]];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const len = dist(a, b);
    const n = Math.max(1, Math.round(len / spacing));
    for (let k = 1; k < n; k++) {
      const t = (k + range(r, -0.18, 0.18)) / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    out.push(b);
  }
  return out;
}

/** Everything except the race: the network itself. */
export function generateNet(seed: number): {
  stops: Stop[]; lines: Line[]; streets: Streets; blocks: Block[]; river: River;
  stations: Station[]; hub: number;
} {
  const r = rng(seed);
  const streets = makeStreets(r);
  const river = makeRiver(r, streets);
  // Bridges go where streets already meet the water, then get spread out.
  river.bridges = chooseBridges(bridgeSites(streets, river), CITY.bridges);

  const stops: Stop[] = [];
  const usedNames = new Set<string>();
  const newName = (): string => {
    for (let k = 0; k < 60; k++) {
      const n = pick(r, HEADS) + pick(r, TAILS);
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    let i = 2;
    const n = pick(r, HEADS) + pick(r, TAILS);
    while (usedNames.has(`${n} ${i}`)) i++;
    usedNames.add(`${n} ${i}`);
    return `${n} ${i}`;
  };

  /**
   * Merge-on-place, and snap-to-street on the way in.
   *
   * The merge is the entire interchange system: two stops closer than 78m ARE
   * one station, so a bus laid across a tram is absorbed into it.
   *
   * The snap is what keeps every station reachable. Buses and trams are on the
   * road already, but a metro is not — it is under the city and its corridor
   * runs wherever it likes. Its ENTRANCES still have to be somewhere a person
   * can stand, which means on a street.
   */
  const addStop = (raw: Pt): number => {
    const p = onStreet(streets, raw) ? raw : snapToStreet(streets, raw);
    for (const s of stops) if (Math.hypot(s.x - p.x, s.y - p.y) <= CITY.mergeRadius) return s.id;
    const id = stops.length;
    stops.push({ id, name: newName(), x: p.x, y: p.y, lines: [] });
    return id;
  };

  /** A point on a given bank, well clear of the water. */
  const onBank = (bank: 1 | -1, tries = 90): Pt | null => {
    for (let k = 0; k < tries; k++) {
      const p = {
        x: range(r, CITY.margin, CITY.width - CITY.margin),
        y: range(r, CITY.margin, CITY.height - CITY.margin),
      };
      if (bankOf(river, p) !== bank) continue;
      // Clear enough of the water that a corridor's approach does not paddle
      // along it — but only just. An earlier version demanded 130m in every
      // direction and quietly emptied the whole riverside: no stop in any
      // city was ever near the far bank, so the water only ever acted on the
      // network's shape and never on a walk. The good moment it was costing
      // is standing at a quay looking at a platform seventy metres away on
      // the wrong side of it.
      let nearBridge = false;
      for (const b of river.bridges) if (dist(b, p) < 120) nearBridge = true;
      if (nearBridge) continue;
      if (!illegalCrossing(river, p, { x: p.x + 70, y: p.y }, CITY.bridgeRadius)
        && !illegalCrossing(river, p, { x: p.x - 70, y: p.y }, CITY.bridgeRadius)
        && !illegalCrossing(river, p, { x: p.x, y: p.y + 70 }, CITY.bridgeRadius)
        && !illegalCrossing(river, p, { x: p.x, y: p.y - 70 }, CITY.bridgeRadius)) {
        // Anchors are junctions, so a route between two of them is a route a
        // bus could drive. Metros ignore this and it costs them nothing.
        const j = nearestJunction(streets, p);
        return bankOf(river, j) === bank ? j : p;
      }
    }
    return null;
  };

  const centre = clampPt({
    x: CITY.width / 2 + range(r, -140, 140),
    y: CITY.height / 2 + range(r, -110, 110),
  });
  const mainBank = bankOf(river, centre);
  const hubPt = onBank(mainBank) ?? centre;
  let hub = addStop(hubPt);
  usedNames.delete(stops[hub].name);
  stops[hub].name = 'Hauptbahnhof';
  usedNames.add('Hauptbahnhof');

  /** A pool of destinations per bank, so lines have somewhere to go. */
  const anchors: Record<string, Pt[]> = { '1': [], '-1': [] };
  for (const bank of [1, -1] as const) {
    for (let i = 0; i < 14; i++) {
      const p = onBank(bank);
      if (p) anchors[String(bank)].push(p);
    }
  }
  anchors[String(mainBank)].push(hubPt);

  /**
   * The two ends of a line inside one bank. `target` is the length wanted:
   * without it you get the longest span the bank offers, which is right for a
   * metro and wrong for a bus. Unconstrained, buses came out fourteen stops
   * and three kilometres long, which made them a slow metro that went
   * everywhere — and a mode that goes everywhere is a mode with no trade in it.
   */
  const spanOn = (bank: 1 | -1, target?: number): [Pt, Pt] | null => {
    const pool = anchors[String(bank)];
    if (pool.length < 2) return null;
    const a = pick(r, pool);
    let b: Pt | null = null, bs = Infinity;
    for (const q of pool) {
      const d = dist(a, q);
      if (d < 400) continue;
      const s = target === undefined ? -d : Math.abs(d - target);
      if (s < bs) { bs = s; b = q; }
    }
    return b ? [a, b] : null;
  };

  const crosses = (poly: Pt[]) => {
    for (let i = 1; i < poly.length; i++) {
      if (illegalCrossing(river, poly[i - 1], poly[i], CITY.bridgeRadius)) return true;
    }
    return false;
  };

  /** A corridor that respects the water, bending less each time it fails. */
  const safeCorridor = (a: Pt, b: Pt, bend: number): Pt[] | null => {
    for (let k = 0; k < 7; k++) {
      const poly = corridor(r, a, b, bend * (1 - k / 7));
      if (!crosses(poly)) return poly;
    }
    return null;
  };

  const lines: Line[] = [];
  const counters: Record<ModeId, number> = { train: 0, metro: 0, tram: 0, bus: 0 };

  /**
   * `via` forces a stop onto an exact point — used to nail the trunk lines to
   * the hub and every crossing line to its bridge. Without it the corridor's
   * bend can carry a line 100m past the main station, which is not a near
   * miss, it is a city with no centre. On a bridge it matters more still: the
   * bridge station is where you are forced to change banks, so it had better
   * be a station.
   */
  const addLine = (mode: ModeId, poly: Pt[], via?: Pt): Line | null => {
    const spec = MODES[mode];
    // A road mode's polyline IS its route, corners and all, and every corner
    // has to become a stop or the vehicle will cut it. A rail mode's polyline
    // is a smooth corridor that gets sampled — it is under the city, so what
    // it drives through is nobody's business.
    const onRoad = mode === 'bus' || mode === 'tram';
    const spacing = spec.spacing * range(r, 0.88, 1.12);
    const pts = onRoad
      ? placeOnPath(r, poly, spacing)
      : placeAtCrossings(r, streets, poly, spacing);
    if (pts.length < 3) return null;
    let viaAt = -1;
    if (via) {
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (dist(pts[i], via) < dist(pts[best], via)) best = i;
      pts[best] = via;
      viaAt = best;
    }

    /**
     * A railway may not turn sharply AT a station.
     *
     * The hall is a box square to the line with a train standing inside it; at
     * a bend the platform follows one leg and the train the other, and the
     * rails come up through the wall in between. It is not a drawing problem —
     * the two requirements contradict each other — so the alignment is fixed
     * instead. Two fifths of rail stops used to turn by more than twenty
     * degrees and one in sixteen by more than ninety, which is a metro that
     * doubles back on itself between stations.
     *
     * A kink is usually ONE stop out of line, so the first answer is to drop
     * that stop and let the line run straight past it, which is what a railway
     * does. Only when the offender is the bridge, or there is nothing left to
     * drop, is the whole corridor thrown away.
     *
     * It happens HERE, before any stop exists, and that is not incidental:
     * pruning after the stops were created left them behind with no line
     * calling at them, which is the orphan leak `addLine` already rewinds for.
     * What it needs is where each point will END UP — snapped to its street
     * and merged with any neighbour — because those two moves are what bend
     * the line in the first place.
     */
    if (!onRoad) {
      const settled = pts.map((raw) => {
        const p = onStreet(streets, raw) ? raw : snapToStreet(streets, raw);
        for (const st of stops) if (dist(st, p) <= CITY.mergeRadius) return { x: st.x, y: st.y };
        return p;
      });
      const lim = (RAIL.maxTurn * Math.PI) / 180;
      for (;;) {
        let worst = -1, worstT = lim;
        for (let i = 1; i + 1 < settled.length; i++) {
          const a = settled[i - 1], b = settled[i], c = settled[i + 1];
          const t = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
          const turn = Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
          if (turn > worstT) { worst = i; worstT = turn; }
        }
        if (worst < 0) break;
        if (settled.length <= 3) return null;
        /**
         * The bridge and the hub are the two stops a line exists to serve, so
         * they are never the one dropped. When the kink is AT one of them the
         * approach is straightened instead, by dropping whichever neighbour
         * leaves the smaller turn — and only if neither does is the corridor
         * given up on. Rejecting outright left the Hauptbahnhof with no line
         * calling at it in about one city in sixty.
         */
        let cut = worst;
        if (worst === viaAt) {
          const turnWithout = (drop: number) => {
            const t = settled.filter((_, k) => k !== drop);
            const i = drop < viaAt ? viaAt - 1 : viaAt;
            if (i < 1 || i + 1 >= t.length) return Infinity;
            const a = t[i - 1], b = t[i], c = t[i + 1];
            const d = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
            return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
          };
          const before = turnWithout(worst - 1), after = turnWithout(worst + 1);
          if (Math.min(before, after) > lim) return null;
          cut = before <= after ? worst - 1 : worst + 1;
        }
        settled.splice(cut, 1);
        pts.splice(cut, 1);
        if (viaAt > cut) viaAt--;
      }
    }

    /**
     * Placing stops creates them, and this line might still be rejected below.
     * Stop ids are indices, and nothing references the new ones until the line
     * is committed, so a rejected line rewinds the array. Without this a
     * rejected corridor leaves stations behind that no line calls at — which
     * was already a latent leak on the "too short" path.
     */
    const mark = stops.length;
    const rewind = (): null => {
      for (let i = mark; i < stops.length; i++) usedNames.delete(stops[i].name);
      stops.length = mark;
      return null;
    };

    const ids: number[] = [];
    for (const p of pts) {
      const id = addStop(p);
      // A line never calls at the same station twice: it runs out and back, so
      // a repeat would make "the next stop" ambiguous while you are aboard.
      if (ids.includes(id)) continue;
      ids.push(id);
    }
    if (ids.length < 3) return rewind();

    /**
     * A road line's stop list IS its geometry: a vehicle drives straight from
     * each stop to the next, so every consecutive pair has to be along one
     * street or the bus takes a short cut through a building.
     *
     * Placing the stops on the route guarantees that; MERGING can undo it. A
     * corner stop that lands within 78m of an existing station is absorbed
     * into it, and if that station is round the corner on the cross street the
     * turn quietly disappears and the leg becomes a diagonal. It showed up as
     * buses sitting in the middle of blocks.
     *
     * The tolerance is half a carriageway: on a street, or not on one.
     */
    if (onRoad) {
      /**
       * How far off square a leg may be, and it is NOT half the street.
       *
       * It used to be, and widening the road to fit three lanes each way
       * quietly widened this with it: a leg could wander seventeen metres off
       * the axis, which put it outside the road once the lane offset was added
       * on top. The tolerance is what is left of the half-width after the
       * outermost lane and the vehicle itself have taken their share.
       */
      const slack = streets.width / 2
        - (LANES.base + (LANES.count - 1) * LANES.gap) * LANES.maxMitre
        - MODES.tram.width / 2;
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = stops[ids[i]], b = stops[ids[i + 1]];
        if (Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > Math.max(2, slack)) return rewind();
      }
    }

    /**
     * A railway may not turn sharply AT a station.
     *
     * The hall is a box square to the line and the train stands inside it; at
     * a bend the platform follows one leg and the train the other, and the
     * rails come up through the wall in between. It is not a drawing problem,
     * the two requirements contradict each other — so the corridor is thrown
     * away and redrawn, exactly like a line that misses its speed band.
     *
     * The worst offenders were not gentle curves. They were crossing lines
     * whose two bank anchors both landed near the same bridge, so the line ran
     * out to the water and doubled straight back: turns of a hundred and sixty
     * degrees at the station on the bridge.
     */
    /**
     * And the same argument about the water. `crosses()` vets the CORRIDOR,
     * but a line's real geometry is its stop list — and stops move after the
     * corridor is drawn: they snap onto the nearest street and then merge with
     * anything within 78m. Either can shuffle a stop to the far bank and leave
     * a leg swimming across open water. Nine legs in 528 were doing exactly
     * that, all of them past a corridor that had been checked and passed.
     *
     * Validate what will actually be drawn and ridden, not what it was drawn
     * from.
     */
    for (let i = 0; i + 1 < ids.length; i++) {
      if (illegalCrossing(river, stops[ids[i]], stops[ids[i + 1]], CITY.bridgeRadius)) return rewind();
    }

    const legs: number[] = [];
    let span = 0;
    for (let i = 0; i + 1 < ids.length; i++) {
      const d = dist(stops[ids[i]], stops[ids[i + 1]]);
      span += d;
      // A floor, so two stops dragged together by a merge do not produce a
      // leg measured in tenths of a second. It is a duration, so it scales.
      legs.push(Math.max(4 / TEMPO, d / spec.speed));
    }
    const oneWay = legs.reduce((a, b) => a + b, 0) + ids.length * spec.dwell;

    /**
     * What you actually travel at, end to end, dwells included — and the one
     * number that has to keep the modes in order. See MODES.effMin/effMax: a
     * line whose stops got dragged together by interchange merges can come out
     * slower than the mode below it, and the corridor is simply redrawn.
     */
    const effective = span / (oneWay - spec.dwell);
    if (effective < spec.effMin || effective > spec.effMax) return rewind();

    const cycle = oneWay * 2;
    // A whole number of vehicles, then the headway back-computed from it. If
    // you take the mode's headway literally you get a remainder, and a
    // remainder is one long gap every cycle that nobody can explain.
    const fleet = Math.max(1, Math.round(cycle / spec.headway));

    const id = lines.length;
    counters[mode]++;
    const line: Line = {
      id, mode,
      name: `${spec.prefix}${counters[mode]}`,
      color: spec.colors[(counters[mode] - 1) % spec.colors.length],
      stops: ids, legs, oneWay, cycle, lane: [], berth: [],
      dwell: spec.dwell,
      headway: cycle / fleet,
      fleet,
      offset: range(r, 0, cycle),
    };
    lines.push(line);
    for (const s of ids) if (!stops[s].lines.includes(id)) stops[s].lines.push(id);
    return line;
  };

  /** A line that gets over the water, built as two corridors meeting on a bridge. */
  const addCrossing = (mode: ModeId, bridge: Pt, bend: number) => {
    const onRoad = mode === 'bus' || mode === 'tram';
    for (let k = 0; k < 45; k++) {
      const a = onBank(1), b = onBank(-1);
      if (!a || !b) continue;
      /**
       * The two anchors have to be on opposite sides of the bridge, not merely
       * on opposite banks. Both landing near the same crossing gives a line
       * that runs out to the water and doubles straight back — a hairpin with
       * a station at its point, which is the sharpest turn in the city and the
       * one the platform can least afford.
       */
      const swing = Math.atan2(a.y - bridge.y, a.x - bridge.x)
        - Math.atan2(b.y - bridge.y, b.x - bridge.x);
      if (Math.abs(Math.atan2(Math.sin(swing), Math.cos(swing))) < 2.1) continue;
      let poly: Pt[] | null;
      if (onRoad) {
        // A tram crosses on the bridge deck, like everything else on wheels.
        const left = roadRoute(a, bridge, 1);
        const right = roadRoute(bridge, b, 1);
        poly = left && right ? left.concat(right.slice(1)) : null;
      } else {
        const left = corridor(r, a, bridge, bend * 0.5);
        const right = corridor(r, bridge, b, bend * 0.5);
        const joined = left.concat(right.slice(1));
        poly = crosses(joined) ? null : joined;
      }
      if (!poly) continue;
      if (addLine(mode, poly, bridge)) return true;
    }
    return false;
  };

  const bridgeFor = (i: number) => river.bridges[i % river.bridges.length];

  /** A road route between two anchors that stays on the grid and off the water. */
  const roadRoute = (a: Pt, b: Pt, wander: number): Pt[] | null => {
    for (let k = 0; k < 10; k++) {
      const path = streetRoute(streets, r, a, b, wander);
      if (path.length >= 2 && !crosses(path)) return path;
    }
    return null;
  };

  // ── the crossings. Four lines, and the whole far bank hangs off them ─────
  addCrossing('train', bridgeFor(0), 90);
  addCrossing('train', bridgeFor(2), 90);
  addCrossing('metro', bridgeFor(1), 150);
  addCrossing('tram', bridgeFor(1), 200);

  /** Lay the remaining lines of a mode, alternating banks so both get a network. */
  const fill = (mode: ModeId, count: number, bend: number, viaHub: number, target?: number) => {
    let placed = 0;
    for (let i = 0; placed < count && i < count * 14; i++) {
      const bank: 1 | -1 = i % 2 === 0 ? mainBank : (-mainBank as 1 | -1);
      const span = spanOn(bank, target);
      if (!span) continue;
      const onRoad = mode === 'bus' || mode === 'tram';
      const poly = onRoad
        ? roadRoute(span[0], span[1], mode === 'bus' ? 2 : 1)
        : safeCorridor(span[0], span[1], bend);
      if (!poly) continue;
      // The trunk lines are pinned to the main station; without it the hub is
      // a name on a map rather than the place everyone changes.
      const via = bank === mainBank && placed < viaHub ? hubPt : undefined;
      if (addLine(mode, poly, via)) placed++;
    }
  };

  fill('metro', FLEET.metro - 1, 140, 2);
  fill('tram', FLEET.tram - 1, 230, 1, 1700);
  fill('bus', FLEET.bus, 300, 0, 1100);

  /**
   * A stop nothing calls at is not a station.
   *
   * `addLine` rewinds the stops a rejected corridor created, which covers the
   * common case, but not the Hauptbahnhof: it is created up front so its name
   * can be reserved and so the trunk lines have something to be pinned to, and
   * if every line that was going to serve it gets thrown away it is left
   * standing on its own — a labelled interchange, on the map and on the
   * street, with no service. Rarely, and it is exactly the sort of thing that
   * is invisible until somebody walks to it.
   *
   * Ids are indices, so dropping one means remapping every line that follows
   * it. The name goes to the busiest interchange left, because that is what
   * the name means.
   */
  {
    const kept = stops.filter((s) => s.lines.length > 0);
    if (kept.length !== stops.length) {
      const remap = new Map<number, number>();
      kept.forEach((s, i) => { remap.set(s.id, i); s.id = i; });
      for (const l of lines) l.stops = l.stops.map((i) => remap.get(i)!);
      stops.length = 0;
      stops.push(...kept);
      const moved = remap.get(hub);
      if (moved === undefined) {
        hub = 0;
        for (const s of stops) if (s.lines.length > stops[hub].lines.length) hub = s.id;
        stops[hub].name = 'Hauptbahnhof';
      } else {
        hub = moved;
      }
    }
  }

  assignLanes(stops, lines);
  return {
    stops, lines, streets, blocks: makeBlocks(streets, r), river, hub,
    stations: buildStations(streets, stops, lines),
  };
}

/**
 * Give every line a lane and a stopping bay, and hand out the combinations so
 * that lines which actually share a street do not share one.
 *
 * Handing them out by line id looks fine and is not: a city has about a dozen
 * road lines and eight combinations, so a few pairs collide by arithmetic —
 * and because buses all travel at the same speed, a colliding pair does not
 * merely brush past, it drives inside its twin for half a kilometre and parks
 * inside it at the stop where you were trying to tell them apart.
 *
 * So it is a graph colouring instead. Lines that share a stop are neighbours,
 * the busiest lines are served first, and each takes the least contested
 * combination left. Cheap, and it puts the separation where the conflicts are.
 */
function assignLanes(stops: Stop[], lines: Line[]) {
  /**
   * Neighbours are lines that RUN NEAR EACH OTHER, not merely lines that share
   * a stop.
   *
   * Sharing a stop was the obvious relation and it missed most of the
   * conflicts: two bus routes can run the length of the same street and stop
   * at different points along it, never sharing a node, and those are exactly
   * the pairs that then drive inside one another for half a kilometre. What
   * matters is whether the two alignments come within a vehicle's width of
   * each other anywhere.
   */
  const near = 14;
  const segDist = (a1: Pt, a2: Pt, b1: Pt, b2: Pt) => {
    // Cheap and good enough: closest approach of sampled points on each leg.
    let best = Infinity;
    for (let i = 0; i <= 4; i++) {
      const p1 = { x: a1.x + (a2.x - a1.x) * (i / 4), y: a1.y + (a2.y - a1.y) * (i / 4) };
      for (let j = 0; j <= 4; j++) {
        const p2 = { x: b1.x + (b2.x - b1.x) * (j / 4), y: b1.y + (b2.y - b1.y) * (j / 4) };
        best = Math.min(best, Math.hypot(p1.x - p2.x, p1.y - p2.y));
      }
    }
    return best;
  };
  /**
   * Two kinds of neighbour, and they are not equally important.
   *
   * Lines that call at the SAME STOP must not share a lane: that is the moment
   * the player is choosing which vehicle to walk to, and two of them in the
   * same three metres makes the choice impossible. Lines that merely run down
   * the same street should also differ, but if something has to give, it gives
   * here — mid-street overlap is untidy, and a stop you cannot read is a
   * broken game.
   */
  const sharesStop = lines.map(() => new Set<number>());
  for (const s of stops) {
    for (const a of s.lines) for (const b of s.lines) if (a !== b) sharesStop[a].add(b);
  }

  const neighbours = lines.map(() => new Set<number>());
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      let touch = false;
      for (let i = 0; i + 1 < lines[a].stops.length && !touch; i++) {
        for (let j = 0; j + 1 < lines[b].stops.length && !touch; j++) {
          if (segDist(
            stops[lines[a].stops[i]], stops[lines[a].stops[i + 1]],
            stops[lines[b].stops[j]], stops[lines[b].stops[j + 1]],
          ) < near) touch = true;
        }
      }
      if (touch) { neighbours[a].add(b); neighbours[b].add(a); }
    }
  }
  // One slot per lane. The other half of the separation — which stand a line
  // uses at a given stop — is decided per stop, below, so it does not need a
  // slot of its own here.
  const slots = Array.from({ length: LANES.count }, (_, lane) => ({ lane }));

  const chosen = new Map<number, number>();
  // Busiest first: a line calling at six interchanges has the fewest options,
  // so it should get to choose before a line that barely meets anything.
  const order = lines.map((l) => l.id)
    .sort((a, b) => (sharesStop[b].size * 4 + neighbours[b].size)
      - (sharesStop[a].size * 4 + neighbours[a].size));
  const used = new Array(slots.length).fill(0);
  for (const id of order) {
    const hard = new Set<number>(), soft = new Set<number>();
    for (const n of sharesStop[id]) {
      const c = chosen.get(n);
      if (c !== undefined) hard.add(c);
    }
    for (const n of neighbours[id]) {
      const c = chosen.get(n);
      if (c !== undefined) soft.add(c);
    }
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < slots.length; i++) {
      // Sharing a stop outweighs sharing a street by two orders of magnitude;
      // ties go to whichever slot is least used overall.
      const score = (hard.has(i) ? 1000 : 0) + (soft.has(i) ? 10 : 0) + used[i];
      if (score < bestScore) { bestScore = score; best = i; }
    }
    chosen.set(id, best);
    used[best]++;
  }

  /**
   * Which stand each line uses at each of its stops. The INDEX is handed out
   * per stop, so every line calling there gets a different one; the direction
   * it is measured in is the line's own, below.
   */
  const stand = new Map<string, number>();
  for (const s of stops) {
    s.lines.forEach((id, k) => {
      stand.set(`${id}:${s.id}`, (k % LANES.berths) - (LANES.berths - 1) / 2);
    });
  }
  for (const line of lines) line.berth = line.stops.map(() => ({ x: 0, y: 0 }));

  for (const line of lines) {
    const slot = slots[chosen.get(line.id)!];
    /**
     * Rail keeps to its own alignment and shares a street with nobody, so it
     * needs only enough room to keep opposing trains apart — and whatever it
     * uses has to fit inside a station box with a platform beside it.
     */
    const rail = line.mode === 'metro' || line.mode === 'train';
    const reach = rail
      ? RAIL.gauge + slot.lane * RAIL.spread
      : LANES.base + slot.lane * LANES.gap;

    /**
     * A mitred offset at every stop: at an interior stop the bisector of the
     * two legs, scaled so the offset road keeps a constant distance from the
     * centre line through the corner, clamped because a hairpin's mitre runs
     * away to infinity. The bay runs along the road, the lane across it.
     */
    line.lane = line.stops.map((_, i) => {
      const here = stops[line.stops[i]];
      const before = i > 0 ? stops[line.stops[i - 1]] : null;
      const after = i + 1 < line.stops.length ? stops[line.stops[i + 1]] : null;
      const perp = (from: Pt, to: Pt) => {
        const dx = to.x - from.x, dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: -dy / len, y: dx / len };
      };
      const along = (n: Pt) => ({ x: n.y, y: -n.x });
      const a = before ? perp(before, here) : null;
      const b = after ? perp(here, after) : null;

      /**
       * The stand is measured ALONG THE LINE'S OWN PATH, not along the street.
       *
       * Along the street was the first attempt and it drove vehicles off the
       * road: where a route turns a corner at a stop, the street's axis is
       * across the line's direction, so the stand pushed the vehicle sideways
       * into the buildings. Along its own path it is simply "pulls up a bit
       * further down the kerb", which is what a stand is — and it still
       * separates two lines meeting at right angles, because their paths point
       * different ways.
       */
      /**
       * No stand where the line TURNS.
       *
       * A stand is measured along the bisector of the two legs, which is the
       * direction of the road only while the road is straight. At a corner the
       * bisector points diagonally across the junction, and a 27m stand along
       * it put a tram seven metres onto the pavement. Corner stops are a
       * minority, so they simply forgo the separation rather than drive into
       * the buildings to get it.
       */
      /**
       * And no stand on RAIL at all.
       *
       * A stand is a place further along the kerb, which is exactly what a
       * train cannot use: its station is a box centred on the stop with a
       * platform beside it, so a stand of any size parks the train outside its
       * own hall. At a four-line interchange the metro was standing
       * twenty-eight metres away, off the street entirely and over open
       * ground. Rail already has all the separation it needs — a tunnel of its
       * own, and a lane inside it.
       */
      const turning = !!a && !!b && (a.x * b.x + a.y * b.y) < Math.cos(0.35);
      const slotAlong = rail || turning
        ? 0
        : (stand.get(`${line.id}:${line.stops[i]}`) ?? 0);
      const bay = slotAlong * LANES.berth;

      const n = !a || !b
        ? (a ?? b)!
        : (() => {
          const mx = a.x + b.x, my = a.y + b.y;
          const len = Math.hypot(mx, my) || 1;
          return { x: mx / len, y: my / len };
        })();
      const cos = a && b ? n.x * a.x + n.y * a.y : 1;
      const out = Math.min(reach / Math.max(0.05, cos), reach * LANES.maxMitre);
      const t = along(n);
      line.berth[i] = { x: t.x * bay, y: t.y * bay };
      return { x: n.x * out, y: n.y * out };
    });
  }
}

/**
 * Dig out a platform box for every rail stop, and a staircase into it.
 *
 * The hall lies along the LINE's direction, because that is the way the
 * platform runs; the stairs come in along the STREET, because that is where
 * the entrance has to be for anyone to find it. The ramp ends at the middle of
 * the hall, so the last stretch of it is a staircase rising out of the
 * platform, which is what a staircase in a station is.
 */
function buildStations(streets: Streets, stops: Stop[], lines: Line[]): Station[] {
  const out: Station[] = [];
  for (const s of stops) {
    for (const mode of ['metro', 'train'] as const) {
      const here = lines.filter((l) => l.mode === mode && l.stops.includes(s.id));
      if (!here.length) continue;

      /**
       * Along the line THROUGH this stop — the bisector, which is the one axis
       * the platform and the train standing at it can both agree on. Averaged
       * over every line of the mode that calls here, as an AXIS rather than a
       * direction, because two lines meeting at a station are a station, not
       * two stations, and half of them run the other way.
       */
      let ax = 0, ay = 0;
      const axis = (l: Line) => {
        const k = l.stops.indexOf(s.id);
        return alignmentAt(
          k > 0 ? stops[l.stops[k - 1]] : null,
          s,
          k + 1 < l.stops.length ? stops[l.stops[k + 1]] : null,
        );
      };
      for (const l of here) { const a = axis(l); ax += Math.cos(2 * a); ay += Math.sin(2 * a); }
      const angle = Math.atan2(ay, ax) / 2;

      /**
       * Big enough to hold every train that stops here, wherever it stands.
       *
       * A fixed width centred on the stop brought the rails up through the
       * platform, because the track lies at the LINE's lane offset. Measuring
       * one line's body fixed that and left the next one out in the cold: two
       * metro lines meeting at a station are square to each other's platform
       * only if the box is sized from both. The corners of the actual bodies,
       * in the hall's own frame, answer all of it at once.
       */
      let reachAlong = BODIES[mode].l / 2, reachAcross = BODIES[mode].w / 2;
      const hc = Math.cos(-angle), hs = Math.sin(-angle);
      for (const l of here) {
        const k = l.stops.indexOf(s.id);
        if (k < 0) continue;
        const a = axis(l);
        const c = Math.cos(a), sn = Math.sin(a);
        for (const dir of [1, -1] as const) {
          const ox = l.lane[k].x * dir, oy = l.lane[k].y * dir;
          for (const u of [-1, 1]) for (const v of [-1, 1]) {
            const px = ox + c * u * BODIES[mode].l / 2 - sn * v * BODIES[mode].w / 2;
            const py = oy + sn * u * BODIES[mode].l / 2 + c * v * BODIES[mode].w / 2;
            reachAlong = Math.max(reachAlong, Math.abs(px * hc - py * hs));
            reachAcross = Math.max(reachAcross, Math.abs(px * hs + py * hc));
          }
        }
      }
      const trackHalf = reachAcross;
      const hw = trackHalf + STATION.platform;

      /**
       * The stairs go on the FOOTWAY, along the street, and the two modes take
       * opposite sides — a stop with both gets one flight down and one up, and
       * in the same place the floor under your feet has two candidates and
       * walking into the subway carries you onto the viaduct instead.
       */
      const h = streets.width / 2;
      const onVertical = streets.xs.some((x) => Math.abs(s.x - x) <= h);
      const along = onVertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const across = onVertical ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const side = mode === 'metro' ? 1 : -1;
      const foot = {
        x: s.x + across.x * STATION.entry * side,
        y: s.y + across.y * STATION.entry * side,
      };
      const run = STATION.shaftLength;
      // Mouth at the far end, descending (or rising) towards the stop.
      const shaftAngle = Math.atan2(along.y, along.x) + (side > 0 ? 0 : Math.PI);
      const bottom = foot;
      const mouth = {
        x: bottom.x - Math.cos(shaftAngle) * run,
        y: bottom.y - Math.sin(shaftAngle) * run,
      };

      out.push({
        stop: s.id,
        mode,
        /**
         * The PLATFORM height, which is the floor of the train and not the top
         * of the rail. Level with the deck is what a platform is for: you step
         * across rather than up.
         */
        level: LEVELS[mode] + BODIES[mode].deck,
        hall: {
          x: s.x, y: s.y, angle,
          hl: reachAlong + STATION.overhang / 2,
          hw,
        },
        trackHalf,
        deck: BODIES[mode].deck,
        shaft: {
          x: (mouth.x + bottom.x) / 2, y: (mouth.y + bottom.y) / 2,
          angle: shaftAngle, hl: run / 2, hw: STATION.shaftWidth / 2,
        },
        /**
         * The corridor from the foot of the stairs in to the PLATFORM — and it
         * stops there, at the platform edge, rather than carrying on to the
         * middle of the station. Run all the way to the stop it drove straight
         * through the track bed and out the far side, so the tunnel appeared
         * to cut across the rails.
         *
         * It is at platform level throughout and does NOT punch through the
         * road, which is what lets the stairs stand on the pavement instead of
         * in the middle of the carriageway.
         */
        passage: (() => {
          /**
           * The corridor runs from the foot of the stairs to a point ON A
           * PLATFORM, chosen directly rather than by backing off from the
           * middle of the station.
           *
           * Two earlier attempts both ended over the rails. Backing off a
           * fixed distance along the corridor fails when the stairs come in at
           * an angle, because most of that distance is spent travelling ALONG
           * the platform rather than away from the track. Solving for the
           * across-component fails when the stairs arrive on the station's
           * centre line, because then no distance along that line clears
           * anything. Naming the destination has neither problem.
           */
          const nx = Math.sin(-angle), ny = Math.cos(-angle);
          const off = (bottom.x - s.x) * nx + (bottom.y - s.y) * ny;
          const side = off >= 0 ? 1 : -1;
          const reach2 = trackHalf + STATION.platform * 0.5;
          const end = { x: s.x + nx * reach2 * side, y: s.y + ny * reach2 * side };
          return {
            x: (bottom.x + end.x) / 2, y: (bottom.y + end.y) / 2,
            angle: Math.atan2(end.y - bottom.y, end.x - bottom.x),
            hl: Math.max(2, Math.hypot(end.x - bottom.x, end.y - bottom.y) / 2 + 1),
            hw: STATION.passageWidth / 2,
          };
        })(),
      });
    }
  }
  return out;
}

/**
 * Pick the race. This is where most generated cities get thrown away, and it
 * should be: a network is easy, a JOURNEY across it is the thing with taste.
 *
 * Four properties, all of which a random pair of stops routinely fails:
 *   - it crosses the river. The crossing IS the race — three bridges, four
 *     lines over them, and picking the wrong one is a mistake you cannot walk
 *     off. A same-bank race is a nice stroll with no decision at the top of it
 *   - it needs a change. A one-seat ride is not a route-planning game
 *   - riding beats walking by a distance, or the race is a footrace
 *   - and it fits in a few minutes
 *
 * The origin is also required to have two lines, so the very first decision of
 * the round is a decision.
 */
export function chooseRace(
  net: Net, r: Rng,
): City['par'] & { origin: number; destination: number } | null {
  const graph = pedestrian(net);
  const nb = walkNeighbours(net, graph);
  const diag = Math.hypot(CITY.width, CITY.height);
  const served = net.stops.filter((s) => s.lines.length >= 1).map((s) => s.id);
  if (served.length < 8) return null;
  // Walking is a shortest path over the streets now, so it costs a graph
  // search rather than a subtraction. Origins repeat across candidates, so
  // each one is searched once.
  const walkFrom = new Map<number, number>();
  const walkOf = (a: number, b: number) => {
    const key = a * 100000 + b;
    let t = walkFrom.get(key);
    if (t === undefined) { t = walkTime(net, a, b, graph); walkFrom.set(key, t); }
    return t;
  };
  // Origins are drawn from interchanges only, so the round opens on a
  // decision. Sampling both ends from every stop and rejecting afterwards
  // threw away two thirds of the candidates for this alone.
  const starts = net.stops.filter((s) => s.lines.length >= 2).map((s) => s.id);
  if (starts.length < 3) return null;
  const river = net.river!;

  /**
   * The lines that get over the water. There are four of them and they are
   * the spine of every race, which is exactly why the DESTINATION must not be
   * on one: if the crossing line drops you at the door, the whole journey is
   * "ride to a bridge, ride across, done", and the optimal route needs one
   * change no matter how big the city is. Measured over 60 cities, that is
   * what kept happening. Barring the destination from the crossing lines
   * forces the shape you actually want — local line, crossing, local line —
   * and with three bridges and four crossings there is a real decision at the
   * top of it.
   */
  /**
   * The same network with every bus and tram taken out of it, used to ask how
   * well a player could do by only ever boarding rail. The walking graph is
   * unchanged — it depends on the streets, not on the lines — so this costs a
   * shallow copy and nothing else.
   */
  const isRail = (l: number) => net.lines[l].mode === 'metro' || net.lines[l].mode === 'train';
  const withOnly = (keep: (l: number) => boolean): Net => ({
    ...net,
    stops: net.stops.map((s) => ({ ...s, lines: s.lines.filter(keep) })),
  });
  const railOnly = withOnly(isRail);
  const roadOnly = withOnly((l) => !isRail(l));

  const crossing = new Set<number>();
  for (const line of net.lines) {
    let seen = 0;
    for (const s of line.stops) seen |= bankOf(river, net.stops[s]) === 1 ? 1 : 2;
    if (seen === 3) crossing.add(line.id);
  }

  type Cand = City['par'] & { origin: number; destination: number; score: number };
  let best: Cand | null = null;

  for (let k = 0; k < 400; k++) {
    const a = pick(r, starts), b = pick(r, served);
    if (a === b) continue;
    // Start and finish on the LOCAL network. Rail is a trunk you have to
    // reach and then leave, which is the entire job of a bus.
    if (net.stops[a].lines.some(isRail) || net.stops[b].lines.some(isRail)) continue;
    if (bankOf(river, net.stops[a]) === bankOf(river, net.stops[b])) continue;
    if (dist(net.stops[a], net.stops[b]) < diag * 0.42) continue;

    const route = bestRoute(net, a, b, nb);
    if (!route) continue;
    if (route.transfers < RACE.minTransfers) continue;
    if (route.time < RACE.parMin || route.time > RACE.parMax) continue;
    const walk = walkOf(a, b);
    if (!isFinite(walk)) continue;
    const ratio = walk / route.time;
    if (ratio < RACE.minWalkRatio) continue;

    // Take the BEST qualifying race rather than the first, because the
    // criteria are a floor and the difference between a race that scrapes
    // through them and one that sails through them is most of the fun. More
    // changes is more route to plan; a fatter walk ratio is a clearer reason
    // to ride at all; and par wants to sit mid-window, since a race at the
    // short end is over before anyone has made a decision.
    const mid = (RACE.parMin + RACE.parMax) / 2;
    // Both ends OFF the crossing lines is the shape that plays best — local
    // line, crossing, local line — but as a hard filter it threw away 50
    // cities in 60. It is worth a lot and it is not worth everything.
    const localEnds = (net.stops[a].lines.some((l) => crossing.has(l)) ? 0 : 0.4)
      + (net.stops[b].lines.some((l) => crossing.has(l)) ? 0 : 0.4);
    const score = Math.min(route.transfers, 3) * 1.0
      + Math.min(ratio, 4) * 0.5
      + localEnds
      - Math.abs(route.time - mid) / 130;

    /**
     * Neither half of the network may be enough on its own.
     *
     * Only worth asking about — it costs two more graph searches — if this
     * candidate would win anyway. The rail half is the one that was breaking
     * the game, but the check has to be symmetric or the fix just moves the
     * problem: a race you can win on buses alone teaches you to ignore the
     * metro, which is the same shallow map with the modes swapped.
     */
    if (best && score <= best.score) continue;
    const rail = bestRoute(railOnly, a, b, nb);
    if (rail && rail.time < route.time * RACE.minRailPenalty) continue;
    const road = bestRoute(roadOnly, a, b, nb);
    if (road && road.time < route.time * RACE.minRoadPenalty) continue;

    {
      best = {
        origin: a, destination: b,
        time: route.time, transfers: route.transfers, walk,
        strict: true, attempts: 0, score,
      };
    }
  }
  if (!best) return null;
  const { score: _score, ...out } = best;
  return out;
}

/** The longest journey this network offers, used only when nothing qualified. */
function fallbackRace(net: Net, r: Rng): City['par'] & { origin: number; destination: number } {
  const graph = pedestrian(net);
  const nb = walkNeighbours(net, graph);
  const served = net.stops.filter((s) => s.lines.length >= 1).map((s) => s.id);
  let best: (City['par'] & { origin: number; destination: number }) | null = null;
  for (let k = 0; k < 300; k++) {
    const a = pick(r, served), b = pick(r, served);
    if (a === b) continue;
    const route = bestRoute(net, a, b, nb);
    if (!route) continue;
    if (best && route.time <= best.time) continue;
    best = {
      origin: a, destination: b,
      time: route.time, transfers: route.transfers, walk: walkTime(net, a, b, graph),
      strict: false, attempts: 0,
    };
  }
  return best ?? {
    origin: served[0], destination: served[served.length - 1],
    time: 0, transfers: 0, walk: 0, strict: false, attempts: 0,
  };
}

/**
 * Build a whole playable city from one seed. Cities are cheap (a few ms) and
 * bad races are common, so this throws away as many as it needs to.
 */
export function buildCity(seed: number): City {
  let last: ReturnType<typeof generateNet> | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const s = (Math.imul(seed, 2654435761) + attempt * 40503) >>> 0;
    const net = generateNet(s);
    last = net;
    const race = chooseRace(net, rng(s ^ 0x9e3779b9));
    if (race) {
      const { origin, destination, ...par } = race;
      return { seed, ...net, origin, destination, par: { ...par, attempts: attempt + 1 } };
    }
  }
  // Never leave the server without a city — play the best thing on offer and
  // record that we had to. tests/city.test.ts watches how often this happens.
  const net = last!;
  const { origin, destination, ...par } = fallbackRace(net, rng(seed ^ 0x51ed270b));
  return { seed, ...net, origin, destination, par: { ...par, attempts: 24 } };
}
