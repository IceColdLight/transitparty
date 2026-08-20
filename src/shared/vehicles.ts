/**
 * Where every vehicle in the city is, at any moment, computed from nothing but
 * the timetable and the clock.
 *
 * This is the load-bearing decision of the whole prototype. Vehicles are not
 * entities: they are not stepped, not stored, and never travel over the wire.
 * The server broadcasts a seed and a clock; both ends independently agree on
 * where all forty-odd of them are, exactly, forever. Three things fall out of
 * that for free:
 *
 *   - the state packet is a handful of players and nothing else
 *   - a client can draw vehicles at its own framerate with no interpolation
 *     and no jitter, because it is evaluating a function, not replaying samples
 *   - riding one is just holding its id
 *
 * A line runs out and back along the same stops. One cycle is: dwell at every
 * stop on the way out, dwell at every stop on the way back. Both termini
 * therefore get a double dwell, which is the turnaround, and which is why a
 * terminus is the one place you can reliably catch something you just missed.
 */
import { TEMPO } from './constants.js';
import type { City, Line, Vehicle } from './types.js';

/** Seconds into this vehicle's cycle. */
function phaseOf(line: Line, run: number, time: number): number {
  const spacing = line.cycle / line.fleet;
  let p = (time + line.offset + run * spacing) % line.cycle;
  if (p < 0) p += line.cycle;
  return p;
}

function locate(city: City, line: Line, run: number, time: number): Vehicle {
  const n = line.stops.length;
  const F = line.oneWay;
  let q = phaseOf(line, run, time);
  let dir: 1 | -1 = 1;
  if (q >= F) { q -= F; dir = -1; }

  const order = dir === 1 ? line.stops : line.stops.slice().reverse();
  const legs = dir === 1 ? line.legs : line.legs.slice().reverse();

  const at = (i: number) => city.stops[order[i]];
  const mk = (
    x: number, y: number, angle: number, atStop: number, nextStop: number,
    eta: number, doorTime: number,
  ): Vehicle => ({ id: `${line.id}.${run}`, line: line.id, run, x, y, angle, dir, atStop, nextStop, eta, doorTime });

  for (let i = 0; i < n; i++) {
    if (q < line.dwell) {
      // Standing with the doors open. At a terminus the next dwell is the
      // other direction's, so the window is twice as long — say so, because
      // "how long have I got to run" is the only question being asked here.
      const doorTime = line.dwell - q + (i === n - 1 ? line.dwell : 0);
      const nextIdx = i < n - 1 ? i + 1 : n - 2;
      const p = at(i), nx = at(nextIdx);
      const legTime = i < n - 1 ? legs[i] : legs[n - 2];
      return mk(p.x, p.y, Math.atan2(nx.y - p.y, nx.x - p.x), order[i], order[nextIdx],
        doorTime + legTime, doorTime);
    }
    q -= line.dwell;
    if (i < n - 1) {
      if (q < legs[i]) {
        const u = q / legs[i];
        const p = at(i), nx = at(i + 1);
        return mk(p.x + (nx.x - p.x) * u, p.y + (nx.y - p.y) * u,
          Math.atan2(nx.y - p.y, nx.x - p.x), -1, order[i + 1], legs[i] - q, 0);
      }
      q -= legs[i];
    }
  }

  const p = at(n - 1), pv = at(n - 2);
  return mk(p.x, p.y, Math.atan2(p.y - pv.y, p.x - pv.x), order[n - 1], order[n - 2], 0, 0);
}

export function vehiclesOnLine(city: City, lineId: number, time: number): Vehicle[] {
  const line = city.lines[lineId];
  const out: Vehicle[] = [];
  for (let run = 0; run < line.fleet; run++) out.push(locate(city, line, run, time));
  return out;
}

export function allVehicles(city: City, time: number): Vehicle[] {
  const out: Vehicle[] = [];
  for (const line of city.lines) {
    for (let run = 0; run < line.fleet; run++) out.push(locate(city, line, run, time));
  }
  return out;
}

export function vehicleById(city: City, id: string, time: number): Vehicle | null {
  const dot = id.indexOf('.');
  if (dot < 0) return null;
  const lineId = Number(id.slice(0, dot));
  const run = Number(id.slice(dot + 1));
  const line = city.lines[lineId];
  if (!line || !Number.isInteger(run) || run < 0 || run >= line.fleet) return null;
  return locate(city, line, run, time);
}

/**
 * The stops this vehicle will call at from here to its terminus, in order.
 * It reverses there and comes back, but a rider deciding where to get off is
 * thinking about this run, not the next one.
 */
export function remainingStops(city: City, v: Vehicle): number[] {
  const line = city.lines[v.line];
  const order = v.dir === 1 ? line.stops : line.stops.slice().reverse();
  const from = v.atStop >= 0 ? order.indexOf(v.atStop) : order.indexOf(v.nextStop);
  if (from < 0) return [];
  return order.slice(v.atStop >= 0 ? from + 1 : from);
}

/**
 * Next departures from a stop, soonest first — the departure board, and the
 * one piece of information the whole game is played on.
 */
export function departures(city: City, stopId: number, time: number, horizon = 600 / TEMPO): {
  line: number; vehicle: string; in: number; towards: number; boardable: boolean;
}[] {
  const out: { line: number; vehicle: string; in: number; towards: number; boardable: boolean }[] = [];
  for (const lineId of city.stops[stopId].lines) {
    const line = city.lines[lineId];
    for (let run = 0; run < line.fleet; run++) {
      // Sample forward for the moment this run next has its doors open here.
      // Cheaper and more honest than inverting the piecewise timetable, and
      // the resolution only has to beat human reaction time.
      for (let t = 0; t < horizon; t += 1) {
        const v = locate(city, line, run, time + t);
        if (v.atStop === stopId) {
          out.push({ line: lineId, vehicle: v.id, in: t, towards: v.nextStop, boardable: t < 0.5 });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.in - b.in);
}
