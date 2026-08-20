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
import { BODIES, DOORS, LEVELS, PLAYER, TEMPO, type ModeId } from './constants.js';
import type { City, Line, Vehicle } from './types.js';

/** Seconds into this vehicle's cycle. */
function phaseOf(line: Line, run: number, time: number): number {
  const spacing = line.cycle / line.fleet;
  let p = (time + line.offset + run * spacing) % line.cycle;
  if (p < 0) p += line.cycle;
  return p;
}

/**
 * The fraction of open at which a doorway is wide enough for somebody to fit
 * through it. Half a door either side, and a body is two radii across.
 */
const passableAt = (mode: ModeId) =>
  Math.min(1, (PLAYER.radius * 2) / BODIES[mode].doorWidth);

/** Seconds of doorway left, given seconds of standing left. */
const doorLeft = (mode: ModeId, stand: number) =>
  Math.max(0, stand - DOORS.settle - DOORS.travel * passableAt(mode));

/**
 * Seconds of a stop you can actually get through the doors in — the number a
 * sprint is sized against, and not the same as the dwell, because the doors
 * take a bite out of both ends of it.
 */
export const boardingWindow = (mode: ModeId, dwell: number) =>
  Math.max(0, dwell - DOORS.settle - 2 * DOORS.travel * passableAt(mode));

function locate(city: City, line: Line, run: number, time: number): Vehicle {
  const n = line.stops.length;
  const F = line.oneWay;
  let q = phaseOf(line, run, time);
  let dir: 1 | -1 = 1;
  if (q >= F) { q -= F; dir = -1; }

  const order = dir === 1 ? line.stops : line.stops.slice().reverse();
  const legs = dir === 1 ? line.legs : line.legs.slice().reverse();
  const lanes = dir === 1 ? line.lane : line.lane.slice().reverse();
  const berths = dir === 1 ? line.berth : line.berth.slice().reverse();

  /**
   * Where this line's vehicles actually run: the stop, pushed sideways into
   * its lane. The displacement is subtracted on the return leg, so the two
   * directions pass each other rather than through each other.
   *
   * The timetable is still measured along the centre line, so a vehicle's real
   * speed varies by a per cent or two around a corner. Nobody can see that;
   * everybody could see two trams occupying the same three metres of road.
   */
  /**
   * The lane flips with the direction of travel — that is what puts opposing
   * traffic on opposite sides. The berth does not: a stand is a place on the
   * kerb and it is the same place whichever way you arrived.
   */
  const at = (i: number): { x: number; y: number } => {
    const s = city.stops[order[i]];
    const l = lanes[i];
    return { x: s.x + l.x * dir, y: s.y + l.y * dir };
  };

  /**
   * How much of a stand's offset applies partway along a leg.
   *
   * A berth is where a vehicle PULLS UP, not where it drives. Applied to the
   * whole path it dragged the route with it — a stand 27m up a north-south
   * street and the next one 27m along an east-west one put the straight line
   * between them well off the road, and buses drove across blocks. It fades in
   * over the last stretch of the approach and out over the first stretch of
   * the departure, so the run itself stays in its lane.
   */
  const BERTH_FADE = 0.3;
  const berthAt = (i: number, u: number) => {
    const b = berths[i];
    const w = Math.max(0, 1 - u / BERTH_FADE);
    return { x: b.x * w, y: b.y * w };
  };
  const level = LEVELS[city.lines[line.id].mode];
  const mk = (
    x: number, y: number, angle: number, atStop: number, nextStop: number,
    eta: number, doorTime: number, door: number,
  ): Vehicle => ({
    id: `${line.id}.${run}`, line: line.id, run, x, y, angle, dir, level,
    atStop, nextStop, eta, doorTime, door,
  });
  const mode = city.lines[line.id].mode;

  for (let i = 0; i < n; i++) {
    if (q < line.dwell) {
      /**
       * Standing at the stop. At a terminus the next dwell is the other
       * direction's, so the WAIT is twice as long — but it is two stops, not
       * one long one, because the lane it stands in flips with the direction
       * and it changes sides between them. The doors shut for that, which is
       * both the honest picture of a turnaround and the only way the rule
       * below holds at a terminus.
       */
      const stand = line.dwell - q + (i === n - 1 ? line.dwell : 0);
      const left = line.dwell - q;
      const nextIdx = i < n - 1 ? i + 1 : n - 2;
      const base = at(i), nx = at(nextIdx);
      const b = berths[i];
      const p = { x: base.x + b.x, y: base.y + b.y };
      const legTime = i < n - 1 ? legs[i] : legs[n - 2];
      /**
       * The doors, as a function of the clock like everything else here.
       *
       * They open on arrival, hold, and are back shut a `settle` before the
       * wheels turn — so "it only moves once they are shut" and "they only
       * open while it is standing" are not rules anybody enforces, they are
       * things this expression cannot say otherwise.
       */
      const door = Math.min(
        1,
        q / DOORS.travel,
        Math.max(0, left - DOORS.settle) / DOORS.travel,
      );
      return mk(p.x, p.y, Math.atan2(nx.y - base.y, nx.x - base.x), order[i], order[nextIdx],
        stand + legTime, doorLeft(mode, left), door);
    }
    q -= line.dwell;
    if (i < n - 1) {
      if (q < legs[i]) {
        const u = q / legs[i];
        const p = at(i), nx = at(i + 1);
        const b0 = berthAt(i, u), b1 = berthAt(i + 1, 1 - u);
        return mk(
          p.x + (nx.x - p.x) * u + b0.x + b1.x,
          p.y + (nx.y - p.y) * u + b0.y + b1.y,
          Math.atan2(nx.y - p.y, nx.x - p.x), -1, order[i + 1], legs[i] - q, 0, 0,
        );
      }
      q -= legs[i];
    }
  }

  const base = at(n - 1), pv = at(n - 2);
  const bl = berths[n - 1];
  return mk(base.x + bl.x, base.y + bl.y,
    Math.atan2(base.y - pv.y, base.x - pv.x), order[n - 1], order[n - 2], 0, 0, 0);
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
          out.push({
            line: lineId, vehicle: v.id, in: t, towards: v.nextStop,
            boardable: t < 0.5 && v.doorTime > 0,
          });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.in - b.in);
}

/** A world point in the vehicle's own frame: +lx towards the front, +ly to one side. */
export function toLocal(v: Vehicle, x: number, y: number): { lx: number; ly: number } {
  const dx = x - v.x, dy = y - v.y;
  const c = Math.cos(-v.angle), s = Math.sin(-v.angle);
  return { lx: dx * c - dy * s, ly: dx * s + dy * c };
}

/** And back again. */
export function toWorld(v: Vehicle, lx: number, ly: number): { x: number; y: number } {
  const c = Math.cos(v.angle), s = Math.sin(v.angle);
  return { x: v.x + lx * c - ly * s, y: v.y + lx * s + ly * c };
}

/**
 * Is this point inside the vehicle's floor plan? A rotated rectangle test —
 * cheap, and the only shape a vehicle needs to be for standing on.
 */
export function overVehicle(city: City, v: Vehicle, x: number, y: number, slack = 0): boolean {
  const b = BODIES[city.lines[v.line].mode];
  const { lx, ly } = toLocal(v, x, y);
  return Math.abs(lx) <= b.l / 2 + slack && Math.abs(ly) <= b.w / 2 + slack;
}

/**
 * Is this position along the vehicle opposite a doorway that is open far
 * enough to fit through? The aperture is the door's width times how far it has
 * slid, and you fit while half of that clears your radius — so a closing door
 * stops being a way out some way before it is shut, which is the whole point
 * of being able to see it move.
 */
export function inDoorway(mode: ModeId, lx: number, open = 1): boolean {
  const b = BODIES[mode];
  const half = (b.doorWidth * open) / 2;
  if (half < PLAYER.radius) return false;
  for (const d of b.doors) {
    if (Math.abs(lx - d * b.l) <= half) return true;
  }
  return false;
}

/** Anything but shut. Whether you FIT is `inDoorway`, which knows how wide. */
export const doorsOpen = (v: Vehicle) => v.door > 0;

/**
 * The floor under a pair of feet: the highest vehicle deck they are standing
 * over, or null for the street. `reach` stops you being snapped up onto the
 * roof of something you are walking past at ground level.
 */
export function deckUnder(
  city: City, vehicles: Vehicle[], x: number, y: number, feet: number, reach: number,
  standingOn: string | null = null,
): { vehicle: Vehicle; height: number } | null {
  let best: { vehicle: Vehicle; height: number } | null = null;
  for (const v of vehicles) {
    if (!overVehicle(city, v, x, y)) continue;
    // The deck sits on the vehicle's own plane: a tunnel floor, a viaduct, or
    // the road. Without the level a metro's deck reads as being at street
    // height and pedestrians are lifted onto trains eight metres below them.
    const height = v.level + BODIES[city.lines[v.line].mode].deck;
    if (height > feet + reach) continue;
    /**
     * You stay on what you are already standing on.
     *
     * Vehicles do not avoid each other, so at a stop where two lines call it
     * is common for a second one to be occupying the same patch of road. Left
     * to pick the highest deck, this would hand the player from the bus they
     * chose to whichever tram happened to be sharing the stop — and then the
     * bus would drive away without them. It cost a third of all integration
     * runs before anyone noticed what it was.
     */
    if (v.id === standingOn) return { vehicle: v, height };
    if (!best || height > best.height) best = { vehicle: v, height };
  }
  return best;
}

/**
 * How fast a vehicle is travelling right now, by sampling the timetable either
 * side of the moment. There is no velocity to read: position is a function of
 * the clock, so its derivative is too.
 */
export function vehicleVelocity(city: City, id: string, time: number, dt = 1 / 60):
{ x: number; y: number } {
  const a = vehicleById(city, id, time - dt);
  const b = vehicleById(city, id, time);
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}
