import type { ModeId } from './constants.js';
import type { River } from './river.js';
import type { Block, Streets } from './streets.js';

/** A station. Positions are world metres; the city is drawn to real geography. */
export type Stop = {
  id: number;
  name: string;
  x: number;
  y: number;
  /** ids of every line calling here — length > 1 means it is an interchange */
  lines: number[];
};

/**
 * One line, out and back along the same stops. There is no branching and no
 * loop: a branch is a thing you can board by mistake, which is a good
 * mechanic and a bad first prototype.
 *
 * `legs`, `oneWay` and `cycle` are derived at generation time from the actual
 * distances between the actual stops, so a line that got dragged sideways by
 * an interchange merge is slower, exactly as it should be.
 */
export type Line = {
  id: number;
  mode: ModeId;
  /** "M2", "B14" */
  name: string;
  color: string;
  stops: number[];
  /** seconds; legs[i] is the run from stops[i] to stops[i+1] */
  legs: number[];
  /** seconds for one end-to-end run, dwells included */
  oneWay: number;
  /** seconds for out and back; a vehicle's whole timetable repeats on this */
  cycle: number;
  /** seconds the doors are open at each stop */
  dwell: number;
  /**
   * Actual seconds between vehicles. Not the mode's target: the fleet is a
   * whole number, so the real headway is cycle/fleet. Evenly spaced vehicles
   * matter — a remainder shows up in play as one long gap every cycle.
   */
  headway: number;
  fleet: number;
  /** seconds of timetable shift, so every line in the city does not pulse together */
  offset: number;
  /**
   * This line's sideways displacement from the centre of the road, one vector
   * per stop, mitred at the corners. Added for the outbound direction and
   * subtracted for the return, which is what makes traffic keep to one side.
   * See LANES.
   */
  lane: { x: number; y: number }[];
  /**
   * Where this line stands at each of its stops, along the street. Unlike
   * `lane` it does NOT flip with the direction of travel — a stand is a place
   * on the kerb, not a side of the road. See LANES.berth.
   */
  berth: { x: number; y: number }[];
};

export type City = {
  seed: number;
  stops: Stop[];
  lines: Line[];
  /**
   * The street grid. Not decoration: it is the only walkable surface in the
   * city, buses and trams are laid along it, and every station sits on it.
   */
  streets: Streets;
  /** Everything that is not a street. Solid. */
  blocks: Block[];
  /**
   * The water and its bridges. Not scenery: you cannot walk across the river
   * except at a bridge, and only four lines cross it at all. It is the thing
   * that stops the network being a mesh.
   */
  river: River;
  /** stop ids */
  origin: number;
  destination: number;
  /** the central interchange — every train and most metros call here */
  hub: number;
  /** what the route planner reckons this race is, used to vet the generation */
  par: {
    /** seconds, planner's estimate with average waits */
    time: number;
    transfers: number;
    /** seconds to walk it in a straight line, the number riding has to beat */
    walk: number;
    /**
     * False when the generator gave up and took the best race it could find
     * rather than one meeting RACE's criteria. The server still plays it —
     * being stuck without a city is worse — but tests watch this number,
     * because a rise in it is the generator regressing.
     */
    strict: boolean;
    /** how many cities had to be thrown away to find this one */
    attempts: number;
  };
};

/**
 * A vehicle is NOT simulated and NOT sent over the wire. It is a pure function
 * of (city, time): the timetable is deterministic, so the server and every
 * client independently agree on where every tram in the city is, to the
 * millisecond, for free. Riding one is therefore just holding its id.
 */
export type Vehicle = {
  /** "3.1" — line 3, run 1. Stable for the life of a city. */
  id: string;
  line: number;
  run: number;
  x: number;
  y: number;
  /** heading, radians, for drawing */
  angle: number;
  /** +1 running along the stop list, -1 coming back */
  dir: 1 | -1;
  /** stop id it is standing at with the doors open, or -1 if it is moving */
  atStop: number;
  /** stop id it is heading for */
  nextStop: number;
  /** seconds until it reaches nextStop */
  eta: number;
  /** seconds of door time left, 0 when moving */
  doorTime: number;
};

export type PlayerState = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  /** height of the feet above the street — 0 on the ground, a deck aboard */
  h: number;
  /** world radians: which way they are looking */
  facing: number;
  /** feet on something solid, as opposed to mid-jump */
  grounded: boolean;
  /**
   * The vehicle under their feet, or null. Nobody boards anything: this is
   * whatever surface they happen to be standing on, so it appears the moment
   * they step onto a deck and vanishes the moment they step off.
   */
  riding: string | null;
  /** 0..1 sprint stamina. Everyone's is visible, so a rival's dash is readable */
  stamina: number;
  /** actually sprinting right now, for the trail on their token */
  sprinting: boolean;
  /** seconds after the gun they crossed the line, or null */
  finished: number | null;
  /** finishing position, 1-based, or 0 */
  place: number;
};

export type RoundState = {
  /** the city IS this number — both ends build it from here */
  seed: number;
  index: number;
  phase: 'racing' | 'intermission';
  /** seconds elapsed in the current phase */
  elapsed: number;
  /** seconds this phase runs for */
  duration: number;
};

export type WorldState = {
  /** server sim clock in seconds, advancing in exact fixed steps */
  time: number;
  round: RoundState;
  players: PlayerState[];
};

export type C2SWalk = {
  type: 'walk';
  seq: number;
  /** world-space wish direction, already normalised */
  wx: number;
  wy: number;
  facing: number;
  /** holding the sprint key */
  sprint: boolean;
  /** holding the jump key */
  jump: boolean;
};
/**
 * The client can say two things: where it is trying to walk, and what to call
 * itself. There is no board key — you get on things by walking onto them —
 * and no reset either: walking off the grid recovers on its own, in
 * shared/movement.ts.
 */
export type C2SName = { type: 'name'; name: string };
export type C2SMessage = C2SWalk | C2SName;

export type S2CWelcome = {
  type: 'welcome';
  id: string;
  color: string;
  tickRate: number;
};
export type S2CState = { type: 'state'; state: WorldState };
export type S2CMessage = S2CWelcome | S2CState;
