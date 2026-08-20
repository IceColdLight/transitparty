/**
 * Things that must not be inside other things.
 *
 * Almost nothing here would ever throw. A viaduct through an office block, a
 * pavement laid over a subway entrance, a platform with its own train parked
 * half outside it — the city builds, the race is winnable, and the picture is
 * simply wrong. This file exists because "look at it" does not scale to sixty
 * seeds and because every one of these was, at some point, shipped.
 */
import { BODIES, RAIL } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { footprintsOf, viaductStrips } from '../src/shared/plots.js';
import { alignmentAt, rectsOverlap, type Rect } from '../src/shared/stations.js';
import { onStreet } from '../src/shared/streets.js';
import { check, describe, note, report } from './harness.js';

const SEEDS = 24;
const cities = Array.from({ length: SEEDS }, (_, i) => buildCity(3000 + i));

describe(`overlaps — ${SEEDS} cities`);

/**
 * The clearance test used to be a CIRCLE inscribed in each plot, which is
 * wrong in the direction that shows: it under-covers the corners, and a
 * corner is exactly where a viaduct comes through a wall.
 */
{
  let hits = 0, plots = 0;
  for (const city of cities) {
    const strips = viaductStrips(city);
    for (const f of footprintsOf(city)) {
      plots++;
      const r: Rect = { x: f.x, y: f.y, angle: 0, hl: f.w / 2, hw: f.d / 2 };
      if (strips.some((s) => rectsOverlap(r, s))) { hits++; continue; }
      for (const st of city.stations) {
        if (st.level <= 0) continue;
        if (rectsOverlap(r, st.hall) || rectsOverlap(r, st.passage) || rectsOverlap(r, st.shaft)) {
          hits++; break;
        }
      }
    }
  }
  note(`${plots} buildings across ${SEEDS} cities`);
  check('no building stands where the railway does', hits === 0, `${hits} of ${plots}`);
}

/**
 * The one the stations were rebuilt for. A hall is a box square to the line
 * with a train standing in it; if the line bends at the stop, the platform
 * follows one leg and the train the other, and neither can be right.
 */
{
  let outside = 0, stations = 0, tried = 0, worstTurn = 0;
  for (const city of cities) {
    for (const st of city.stations) {
      stations++;
      const s = city.stops[st.stop];
      const b = BODIES[st.mode];
      // Every line of this mode that calls here, in both directions — the
      // station has to hold all of them, not just the one it was named for.
      for (const line of city.lines.filter((l) => l.mode === st.mode && l.stops.includes(st.stop)))
      for (const dir of [1, -1] as const) {
        const i = line.stops.indexOf(st.stop);
        const at = { x: s.x + line.lane[i].x * dir, y: s.y + line.lane[i].y * dir };
        const angle = alignmentAt(
          i > 0 ? city.stops[line.stops[i - 1]] : null,
          s,
          i + 1 < line.stops.length ? city.stops[line.stops[i + 1]] : null,
        );
        const body: Rect = { x: at.x, y: at.y, angle, hl: b.l / 2, hw: b.w / 2 };
        // Every corner of the vehicle inside the hall, not merely touching it.
        const c = Math.cos(angle), sn = Math.sin(angle);
        let out = false;
        for (const u of [-1, 1]) for (const v of [-1, 1]) {
          const px = body.x + c * u * body.hl - sn * v * body.hw;
          const py = body.y + sn * u * body.hl + c * v * body.hw;
          const dx = px - st.hall.x, dy = py - st.hall.y;
          const hc = Math.cos(-st.hall.angle), hs = Math.sin(-st.hall.angle);
          if (Math.abs(dx * hc - dy * hs) > st.hall.hl + 0.5
            || Math.abs(dx * hs + dy * hc) > st.hall.hw + 0.5) out = true;
        }
        tried++;
        if (out) outside++;
      }
    }
  }
  note(`${stations} rail stations, every line that calls, both directions`);
  check('a train standing at its station is inside it', outside === 0,
    `${outside} of ${tried} stood outside their own hall`);
  void worstTurn;
}

/** And the constraint that makes the above possible in the first place. */
{
  let worst = 0, offStreet = 0, rail = 0;
  for (const city of cities) {
    for (const line of city.lines) {
      if (line.mode !== 'metro' && line.mode !== 'train') continue;
      for (let i = 0; i < line.stops.length; i++) {
        rail++;
        if (!onStreet(city.streets, city.stops[line.stops[i]])) offStreet++;
        if (i === 0 || i + 1 >= line.stops.length) continue;
        const a = city.stops[line.stops[i - 1]];
        const b = city.stops[line.stops[i]];
        const c = city.stops[line.stops[i + 1]];
        const t = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
        worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) * 180 / Math.PI);
      }
    }
  }
  note(`worst turn at a rail stop: ${worst.toFixed(1)}° of ${RAIL.maxTurn}° allowed`);
  check('a railway never bends sharply at a station', worst <= RAIL.maxTurn + 0.01,
    `${worst.toFixed(1)}°`);
  check('and every rail stop is on a street, or nobody can reach it',
    offStreet === 0, `${offStreet} of ${rail}`);
}

/** Two stations in one place is one station drawn twice. */
{
  let clashes = 0, pairs = 0;
  for (const city of cities) {
    for (let i = 0; i < city.stations.length; i++) {
      for (let j = i + 1; j < city.stations.length; j++) {
        const a = city.stations[i], b = city.stations[j];
        if (a.level * b.level < 0) continue;      // one is under the road, one over it
        pairs++;
        if (rectsOverlap(a.hall, b.hall)) clashes++;
      }
    }
  }
  check('no two halls on the same level share ground', clashes === 0, `${clashes} of ${pairs}`);
}

report();
