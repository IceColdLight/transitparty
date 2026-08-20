/**
 * Every tuned number in the game, in one file, imported by the server, the
 * client AND the tests. A number that lives in two places drifts.
 *
 * Units are metres and seconds throughout. The city is drawn to real
 * geography, so a metre here is a metre you have to walk.
 */

export const WS_PORT = 8081;

/** Server simulation rate. Fixed step; the sim never sees a variable dt. */
export const TICK_HZ = 30;
/** How often that state goes out. Half the tick rate is plenty for walkers. */
export const BROADCAST_HZ = 15;
/**
 * Playout buffer. Other players are drawn this far in the past so their
 * motion interpolates instead of stuttering between packets. Override with
 * ?delay=250 over a bad link.
 */
export const INTERP_DELAY_MS = 90;

export const CITY = {
  // Sized by the walk-versus-ride trade, not by taste. Waiting for a vehicle
  // is a fixed cost paid once per leg, so a SHORT journey is always a close
  // call and a long one never is. At 2400x1800 the planner could not find a
  // single race where riding beat walking by the required margin — the trip
  // was over before the waiting had amortised. The city has to be big enough
  // that catching something is obviously right.
  width: 3000,
  height: 2100,
  /** no line terminates closer than this to the edge — termini need approaches */
  margin: 150,
  /**
   * Two stops closer together than this ARE the same station. This one number
   * makes interchanges: a bus laid across a metro will land a stop near one of
   * its stations and get absorbed into it, so transfers are a consequence of
   * geography rather than something the generator has to plan.
   */
  mergeRadius: 78,
  /**
   * How close to a bridge you have to be to get across the water. Bridges are
   * the only crossings on foot, and only four lines cross at all — see
   * river.ts for why the city needed a chokepoint in the first place.
   */
  bridgeRadius: 85,
  bridges: 3,
};

export const WALK = {
  /**
   * 2.4 m/s — a hurry, not a stroll and not a sprint.
   *
   * This started at 3.6 because the city felt like treacle at anything less,
   * and it quietly broke the generator: waiting for a vehicle is a fixed cost
   * paid once per leg, so a two-change journey pays three waits, and against a
   * 13 km/h walk that made RIDING the slow option. Of 496 candidate races,
   * 161 were thrown out for exactly this and not one survived. Walking has to
   * be genuinely worse than the network or there is no game on top of it.
   *
   * The treacle problem was real and is solved elsewhere: you spawn ON the
   * origin platform, so the round opens with a boarding decision rather than
   * a walk.
   */
  speed: 2.4,
  /** Reaching full speed in ~0.15s. A race wants crisp starts, not inertia. */
  accel: 26,
  /** Longest transfer the route planner will consider on foot. */
  transferMax: 260,
};

/** You can board a vehicle from this far off its stop — the width of a platform. */
export const BOARD_RADIUS = 17;
/** Standing this close to the destination, on foot, wins the round. */
export const ARRIVE_RADIUS = 22;

export type ModeId = 'train' | 'metro' | 'tram' | 'bus';

/**
 * The four modes exist to be a TRADE, not a ladder. Every one of them is the
 * right answer somewhere:
 *
 *   train  fastest by a mile, but three stations in the whole city and you
 *          wait nearly three minutes for one. Worth it across the map, absurd
 *          for two stops.
 *   metro  the backbone. Fast, frequent, but only where it goes.
 *   tram   slower than the metro and denser, so it is usually the thing that
 *          gets you the last 600m the metro missed.
 *   bus    barely faster than running, but it stops everywhere and comes
 *          often. The answer when the walk would have been 400m.
 *
 * `spacing` drives stop placement, which is what really separates them: it is
 * the reason a bus is never far away and a train always is.
 */
export const MODES: Record<ModeId, {
  /** cruise speed, m/s */
  speed: number;
  /**
   * The band a finished line's IN-VEHICLE speed must land in, m/s — end to end
   * distance over end to end time, dwells included. A line outside its band is
   * thrown away and the corridor redrawn.
   *
   * This exists so the modes are PREDICTABLE. Cruise speed alone does not
   * order them: what you actually travel at is set as much by how often the
   * thing stops, and a train squeezed into cramped stops by interchange merges
   * could come out slower than a good metro. Measured over 60 cities that
   * happened in 0.1% of train/metro line pairs — rare enough never to notice
   * and often enough to make "is the S faster than the M" un-guessable, which
   * is the one question the player must always be able to answer.
   *
   * The bands do not overlap, so the ordering is now true by construction:
   * bus < tram < metro < train, on every line, in every city.
   */
  effMin: number;
  effMax: number;
  /** seconds standing at each stop with the doors open — your window to run */
  dwell: number;
  /** target seconds between vehicles */
  headway: number;
  /** target metres between stops */
  spacing: number;
  /** stroke width in the world view, metres */
  width: number;
  colors: readonly string[];
  prefix: string;
  label: string;
}> = {
  train: { speed: 34, dwell: 14, headway: 140, spacing: 950, width: 13, prefix: 'S', label: 'train',
    effMin: 17.5, effMax: 26, colors: ['#8f6ec4', '#6f7fd0'] },
  metro: { speed: 19, dwell: 9, headway: 75, spacing: 540, width: 11, prefix: 'M', label: 'metro',
    effMin: 11.5, effMax: 16.5, colors: ['#e2574c', '#e08a33', '#d9508c', '#4aa3df'] },
  tram:  { speed: 11, dwell: 6, headway: 52, spacing: 300, width: 8, prefix: 'T', label: 'tram',
    effMin: 7.6, effMax: 10.5, colors: ['#2fa36b', '#3f9d9d', '#77a832', '#3f8f5c'] },
  bus:   { speed: 8,  dwell: 5, headway: 42, spacing: 195, width: 6, prefix: 'B', label: 'bus',
    effMin: 5.2, effMax: 7.2, colors: ['#c9a227', '#b8863b', '#a89a3a'] },
};

/** How many lines of each mode the generator lays down. */
export const FLEET = {
  train: 2,
  metro: 4,
  tram: 5,
  bus: 7,
};

export const RACE = {
  /** Hard stop on a round, in case somebody wanders off. */
  roundSeconds: 540,
  /** Results on screen between rounds. */
  intermissionSeconds: 14,
  /**
   * The three properties that make a generated race worth running, checked at
   * generation time and held by tests/city.test.ts. A city that fails all
   * three is not a hard city, it is a broken one.
   */
  /**
   * Walking the whole way must be at least this much worse than riding.
   *
   * 2.2, not the 3 it wants to be, and the difference is waiting. The planner
   * charges every boarding an average half-headway, so a two-change journey
   * pays over a minute standing still — which is honest, and which a real
   * player beats by reading the live departures before they commit. The
   * player's ratio is better than par's. This is the floor, not the target.
   */
  minWalkRatio: 2.0,
  /**
   * TWO changes, not one, and this was the hardest number in the file to
   * arrive at.
   *
   * At one, the generator kept handing out races whose optimal route was
   * "ride to a bridge, ride across, walk" — and since every plausible-looking
   * alternative was within a few seconds of that, the map was not worth
   * reading. Measured over 60 cities the average optimum was 1.07 changes.
   *
   * Everything tried first was a proxy for this and all of them cost more
   * than they bought: keeping the destination off the crossing lines moved
   * the average to 1.13, keeping BOTH ends off them reached 1.67 but threw
   * away 25 cities in 60 for being unsolvable inside the time window. Asking
   * for the property directly works, because the generator is then free to
   * find whichever pair of stops happens to have it.
   */
  minTransfers: 2,
  /** Planner's estimate of the winning time must land in this window. */
  parMin: 150,
  parMax: 400,
};

/** Player colours, in join order. */
export const PALETTE = [
  '#ff5c5c', '#5cc8ff', '#a4ff5c', '#ffdd5c', '#d25cff', '#5cffd8', '#ff9d5c', '#9d9dff',
];
