/**
 * Does the map lie?
 *
 * It is supposed to. The player plans on the schematic and walks in the real
 * city, and the gap between the two is a mechanic — "two stops" on the diagram
 * can be four hundred metres on your feet. A schematic that told the truth
 * would quietly collapse the game back into a single view, and nothing would
 * throw when it happened, so it is worth a suite.
 *
 * What it must NOT do is lie about the things a diagram is for: the order of
 * the stops along a line, which lines meet where, and roughly which way is
 * north. Those are the properties below.
 */
import { CITY } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { segIntersect } from '../src/shared/river.js';
import { warp } from '../src/shared/schematic.js';
import { avg, check, describe, note, report } from './harness.js';

const city = buildCity(777);
const W = city.stops.map(warp);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe(`the diagram — seed ${city.seed}`);

/** How much a given leg is stretched or squashed on the map. */
const scales: number[] = [];
for (const line of city.lines) {
  for (let i = 0; i + 1 < line.stops.length; i++) {
    const a = line.stops[i], b = line.stops[i + 1];
    const real = dist(city.stops[a], city.stops[b]);
    if (real < 1) continue;
    scales.push(dist(W[a], W[b]) / real);
  }
}
const spread = Math.max(...scales) / Math.min(...scales);
note(`leg scale on the map runs x${Math.min(...scales).toFixed(2)} to x${Math.max(...scales).toFixed(2)}`);
check('the map genuinely misleads about distance',
  spread > 1.6, `widest leg is stretched ${spread.toFixed(2)}x more than the tightest`);

/**
 * And it misleads in the direction every real diagram does: the crowded
 * centre is given room, the outskirts are squeezed.
 */
const cx = CITY.width / 2, cy = CITY.height / 2;
const central: number[] = [], outer: number[] = [];
for (const line of city.lines) {
  for (let i = 0; i + 1 < line.stops.length; i++) {
    const a = city.stops[line.stops[i]], b = city.stops[line.stops[i + 1]];
    const real = dist(a, b);
    if (real < 1) continue;
    const r = (Math.hypot(a.x - cx, a.y - cy) + Math.hypot(b.x - cx, b.y - cy)) / 2;
    const s = dist(W[line.stops[i]], W[line.stops[i + 1]]) / real;
    (r < Math.hypot(cx, cy) * 0.35 ? central : outer).push(s);
  }
}
check('the centre is enlarged relative to the edges',
  avg(central) > avg(outer) * 1.25,
  `centre x${avg(central).toFixed(2)} vs outskirts x${avg(outer).toFixed(2)}`);

describe('what a diagram may not get wrong');

/**
 * A diagram may distort distance as much as it likes; what it may not do is
 * tangle a line with itself. If the warp pulls a route across its own path,
 * the reader gets a junction that does not exist.
 *
 * This replaces an earlier check that asked whether the stop ORDER along a
 * line survived, measured by comparing straight-line distances between
 * consecutive triples. That property was never actually guaranteed — the warp
 * is radial, so for three stops that are not collinear it can and does change
 * which of them looks closer, and once buses were routed along a rectilinear
 * street grid their legs stopped being collinear. It failed on 2 triples in
 * 87 and it was the test that was wrong, not the map.
 */
const crossings = (pts: { x: number; y: number }[]) => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    for (let j = i + 2; j < pts.length; j++) {
      if (segIntersect(pts[i - 1], pts[i], pts[j - 1], pts[j])) n++;
    }
  }
  return n;
};
let introduced = 0, tangles = 0;
for (const line of city.lines) {
  const real = crossings(line.stops.map((s) => city.stops[s]));
  const drawn = crossings(line.stops.map((s) => W[s]));
  tangles += drawn;
  if (drawn > real) introduced++;
}
check('the diagram never makes a line cross itself that did not already',
  introduced === 0, `${introduced} lines tangled by the warp, ${tangles} crossings in total`);

let moved = 0;
for (let i = 0; i < city.stops.length; i++) {
  const s = city.stops[i];
  const realA = Math.atan2(s.y - cy, s.x - cx);
  const mapA = Math.atan2(W[i].y - cy, W[i].x - cx);
  let d = Math.abs(realA - mapA);
  if (d > Math.PI) d = Math.PI * 2 - d;
  if (d > 1e-6) moved++;
}
check('a stop never changes which way it lies from the centre',
  moved === 0, `${moved} stops rotated — the warp is purely radial`);

const merged = new Set(W.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size;
check('no two stations are squashed onto the same point',
  merged === city.stops.length, `${merged}/${city.stops.length} distinct`);

describe('the warp itself');

check('the centre of the city stays put',
  dist(warp({ x: cx, y: cy }), { x: cx, y: cy }) < 1e-6);
const far = warp({ x: 0, y: 0 });
check('and the far corner stays in its corner',
  far.x < cx && far.y < cy, `${far.x.toFixed(0)},${far.y.toFixed(0)}`);

let monotone = true;
for (let r = 10; r < 1400; r += 10) {
  const a = warp({ x: cx + r, y: cy });
  const b = warp({ x: cx + r + 10, y: cy });
  if (b.x <= a.x) monotone = false;
}
check('walking away from the centre always moves you outward on the map', monotone);

report();
