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
import { CITY, FLEET, MODES, RACE, type ModeId } from './constants.js';
import { type Rng, pick, range, rng } from './rng.js';
import { type River, bankOf, illegalCrossing } from './river.js';
import { type Net, bestRoute, walkNeighbours, walkTime } from './routing.js';
import type { Block, City, Line, Stop } from './types.js';

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

function polyLength(poly: Pt[]): number {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += dist(poly[i - 1], poly[i]);
  return L;
}

/** Point at a given distance along a polyline. */
function alongPoly(poly: Pt[], d: number): Pt {
  if (d <= 0) return poly[0];
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const seg = dist(poly[i - 1], poly[i]);
    if (acc + seg >= d) {
      const u = seg < 1e-9 ? 0 : (d - acc) / seg;
      return {
        x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * u,
        y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * u,
      };
    }
    acc += seg;
  }
  return poly[poly.length - 1];
}

/**
 * Stops along a corridor at roughly `spacing` metres. The jitter matters more
 * than it looks: evenly spaced stops read as a diagram, and the whole point of
 * the world view is that it is not one.
 */
function placeAlong(r: Rng, poly: Pt[], spacing: number): Pt[] {
  const L = polyLength(poly);
  const n = Math.max(2, Math.round(L / spacing));
  const step = L / n;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const j = i === 0 || i === n ? 0 : range(r, -0.24, 0.24) * step;
    out.push(alongPoly(poly, i * step + j));
  }
  return out;
}

function makeBlocks(r: Rng): Block[] {
  const out: Block[] = [];
  const rec = (x: number, y: number, w: number, h: number, d: number) => {
    if (w <= 30 || h <= 30) return;
    if (d >= 7 || (w < 200 && h < 200)) {
      out.push({ x, y, w, h, park: r() < 0.10 });
      return;
    }
    const vert = w > h ? r() < 0.85 : r() < 0.15;
    const f = range(r, 0.36, 0.64);
    const street = range(r, 14, 26);
    if (vert) {
      const cut = w * f;
      rec(x, y, cut - street / 2, h, d + 1);
      rec(x + cut + street / 2, y, w - cut - street / 2, h, d + 1);
    } else {
      const cut = h * f;
      rec(x, y, w, cut - street / 2, d + 1);
      rec(x, y + cut + street / 2, w, h - cut - street / 2, d + 1);
    }
  };
  rec(0, 0, CITY.width, CITY.height, 0);
  return out;
}

/**
 * The river, and the handful of bridges on it. Bridges are spaced along the
 * water rather than placed where they would be convenient — a crossing you
 * have to go out of your way for is the entire point.
 */
function makeRiver(r: Rng): River {
  const vertical = r() < 0.5;
  const a: Pt = vertical
    ? { x: range(r, CITY.width * 0.3, CITY.width * 0.7), y: -80 }
    : { x: -80, y: range(r, CITY.height * 0.3, CITY.height * 0.7) };
  const b: Pt = vertical
    ? { x: range(r, CITY.width * 0.3, CITY.width * 0.7), y: CITY.height + 80 }
    : { x: CITY.width + 80, y: range(r, CITY.height * 0.3, CITY.height * 0.7) };

  const poly: Pt[] = [];
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const h1 = range(r, -1, 1), h2 = range(r, -0.7, 0.7);
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const off = 300 * (h1 * Math.sin(Math.PI * t) + h2 * Math.sin(2 * Math.PI * t));
    poly.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
  }

  const total = polyLength(poly);
  const bridges: Pt[] = [];
  for (let i = 0; i < CITY.bridges; i++) {
    const t = (i + 1) / (CITY.bridges + 1) + range(r, -0.09, 0.09);
    const p = alongPoly(poly, total * t);
    // A bridge outside the map is not a bridge. Pull it back along the water
    // until it is somewhere a player can actually stand.
    if (p.x > 40 && p.x < CITY.width - 40 && p.y > 40 && p.y < CITY.height - 40) bridges.push(p);
  }
  if (bridges.length === 0) bridges.push(alongPoly(poly, total * 0.5));
  return { poly, bridges };
}

/** Everything except the race: the network itself. */
export function generateNet(seed: number): {
  stops: Stop[]; lines: Line[]; blocks: Block[]; river: River; hub: number;
} {
  const r = rng(seed);
  const river = makeRiver(r);

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

  /** Merge-on-place. This one line is the entire interchange system. */
  const addStop = (p: Pt): number => {
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
        && !illegalCrossing(river, p, { x: p.x, y: p.y - 70 }, CITY.bridgeRadius)) return p;
    }
    return null;
  };

  const centre = clampPt({
    x: CITY.width / 2 + range(r, -140, 140),
    y: CITY.height / 2 + range(r, -110, 110),
  });
  const mainBank = bankOf(river, centre);
  const hubPt = onBank(mainBank) ?? centre;
  const hub = addStop(hubPt);
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
    const pts = placeAlong(r, poly, spec.spacing * range(r, 0.88, 1.12));
    if (via) {
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (dist(pts[i], via) < dist(pts[best], via)) best = i;
      pts[best] = via;
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

    const legs: number[] = [];
    let span = 0;
    for (let i = 0; i + 1 < ids.length; i++) {
      const d = dist(stops[ids[i]], stops[ids[i + 1]]);
      span += d;
      legs.push(Math.max(4, d / spec.speed));
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
      stops: ids, legs, oneWay, cycle,
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
    for (let k = 0; k < 20; k++) {
      const a = onBank(1), b = onBank(-1);
      if (!a || !b) continue;
      const left = corridor(r, a, bridge, bend * 0.5);
      const right = corridor(r, bridge, b, bend * 0.5);
      const poly = left.concat(right.slice(1));
      if (crosses(poly)) continue;
      if (addLine(mode, poly, bridge)) return true;
    }
    return false;
  };

  const bridgeFor = (i: number) => river.bridges[i % river.bridges.length];

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
      const poly = safeCorridor(span[0], span[1], bend);
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

  return { stops, lines, blocks: makeBlocks(r), river, hub };
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
  const nb = walkNeighbours(net);
  const diag = Math.hypot(CITY.width, CITY.height);
  const served = net.stops.filter((s) => s.lines.length >= 1).map((s) => s.id);
  if (served.length < 8) return null;
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
    if (bankOf(river, net.stops[a]) === bankOf(river, net.stops[b])) continue;
    if (dist(net.stops[a], net.stops[b]) < diag * 0.42) continue;

    const route = bestRoute(net, a, b, nb);
    if (!route) continue;
    if (route.transfers < RACE.minTransfers) continue;
    if (route.time < RACE.parMin || route.time > RACE.parMax) continue;
    const walk = walkTime(net, a, b);
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

    if (!best || score > best.score) {
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
  const nb = walkNeighbours(net);
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
      time: route.time, transfers: route.transfers, walk: walkTime(net, a, b),
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
  for (let attempt = 0; attempt < 24; attempt++) {
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
