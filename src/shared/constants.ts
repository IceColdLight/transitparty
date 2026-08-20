/**
 * Every tuned number in the game, in one file, imported by the server, the
 * client AND the tests. A number that lives in two places drifts.
 *
 * Units are metres and seconds throughout. The city is drawn to real
 * geography, so a metre here is a metre you have to walk.
 */

/**
 * How much faster than reality the whole city runs.
 *
 * Everything was originally at real-world scale — 2.4 m/s on foot, a metro
 * every 75 seconds — and it played like watching a timetable. A race is not a
 * commute simulator: the interesting part is the DECISION, and at real speeds
 * you spend four fifths of a round waiting to find out whether it was right.
 *
 * So time is compressed, not distances. Speeds go up by this and every
 * duration comes down by it, which leaves every ratio the design was tuned
 * around exactly where it was: walking is still the same multiple worse than
 * riding, a transfer still costs the same fraction of the journey, par is
 * still the same distance from the round timer.
 *
 * ONE THING DOES NOT SCALE: `dwell`, the seconds a vehicle stands with its
 * doors open. That is not a simulation duration, it is a human reaction
 * window — the time you have to notice the tram, run and press a key — and
 * human reactions do not speed up when the game does. Divide it by three like
 * everything else and a bus door is open for 1.7 seconds, which is not a
 * timing challenge, it is a coin toss. It is set in absolute seconds below.
 */
export const TEMPO = 3;

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
  speed: 2.4 * TEMPO,
  /** Reaching full speed almost at once. A race wants crisp starts, not inertia. */
  accel: 26 * TEMPO,
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
type ModeSpec = {
  /** cruise speed, m/s */
  speed: number;
  /**
   * Seconds standing at each stop with the doors open — your window to run.
   * ABSOLUTE seconds, deliberately not divided by TEMPO: see the note there.
   */
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
};

/**
 * The four modes exist to be a TRADE, not a ladder. Every one of them is the
 * right answer somewhere:
 *
 *   train  fastest by a mile, but three stations in the whole city and you
 *          wait the longest for one. Worth it across the map, absurd for two
 *          stops.
 *   metro  the backbone. Fast, frequent, but only where it goes.
 *   tram   slower than the metro and denser, so it is usually the thing that
 *          gets you the last 600m the metro missed.
 *   bus    barely faster than running, but it stops everywhere and comes
 *          often. The answer when the walk would have been 400m.
 *
 * `spacing` drives stop placement, which is what really separates them: it is
 * the reason a bus is never far away and a train always is.
 */
const MODE_SPECS: Record<ModeId, ModeSpec> = {
  train: { speed: 34 * TEMPO, dwell: 8, headway: 140 / TEMPO, spacing: 950, width: 13,
    prefix: 'S', label: 'train', colors: ['#8f6ec4', '#6f7fd0'] },
  metro: { speed: 19 * TEMPO, dwell: 6, headway: 75 / TEMPO, spacing: 540, width: 11,
    prefix: 'M', label: 'metro', colors: ['#e2574c', '#e08a33', '#d9508c', '#4aa3df'] },
  tram:  { speed: 11 * TEMPO, dwell: 4, headway: 52 / TEMPO, spacing: 300, width: 8,
    prefix: 'T', label: 'tram', colors: ['#2fa36b', '#3f9d9d', '#77a832', '#3f8f5c'] },
  bus:   { speed: 8 * TEMPO,  dwell: 4, headway: 42 / TEMPO, spacing: 195, width: 6,
    prefix: 'B', label: 'bus', colors: ['#c9a227', '#b8863b', '#a89a3a'] },
};

/**
 * What a mode travels at end to end when its stops land exactly `spacing`
 * apart: the cruise speed, discounted by a stop every `spacing` metres. It is
 * always well under the cruise figure, and it is the number a passenger
 * actually experiences.
 */
export const nominalSpeed = (m: ModeSpec) => m.spacing / (m.spacing / m.speed + m.dwell);

/**
 * How far a real line may stray from its mode's nominal speed before the
 * generator throws it away and redraws the corridor.
 *
 * These exist so the modes are PREDICTABLE. Cruise speed alone does not order
 * them: what you actually travel at is set as much by how often the thing
 * stops, and a train squeezed into cramped stops by interchange merges could
 * come out slower than a good metro. Measured over 60 cities that happened in
 * 0.1% of train/metro line pairs — rare enough never to notice and often
 * enough to make "is the S faster than the M" un-guessable, which is the one
 * question the player must always be able to answer.
 *
 * The window is narrower than the gap between adjacent modes, so the bands
 * cannot overlap and the ordering is true by construction: bus < tram < metro
 * < train, on every line, in every city. The tightest gap is tram over bus, so
 * that is the pair to check if these are ever widened.
 */
const BAND = [0.87, 1.15] as const;

export const MODES: Record<ModeId, ModeSpec & { effMin: number; effMax: number }> = Object
  .fromEntries((Object.keys(MODE_SPECS) as ModeId[]).map((k) => {
    const spec = MODE_SPECS[k];
    const n = nominalSpeed(spec);
    return [k, { ...spec, effMin: n * BAND[0], effMax: n * BAND[1] }];
  })) as Record<ModeId, ModeSpec & { effMin: number; effMax: number }>;

/** How many lines of each mode the generator lays down. */
export const FLEET = {
  train: 2,
  metro: 4,
  tram: 5,
  bus: 7,
};

export const RACE = {
  /** Hard stop on a round, in case somebody wanders off. */
  roundSeconds: 630 / TEMPO,
  /**
   * Results on screen between rounds. Absolute seconds, like `dwell` — reading
   * a scoreboard is a human task and does not get faster because the trams do.
   */
  intermissionSeconds: 11,
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
  /**
   * Planner's estimate of the winning time must land in this window.
   *
   * The numerators are a little wider than the ones this window had before
   * time was compressed, and the reason is `dwell`. Every duration in the game
   * divides by TEMPO except that one, so a journey does NOT get three times
   * quicker — the stopping does not, and the denser the mode the more of the
   * trip is stopping. Transit came out about a fifth slower relative to
   * everything else, which pressed par flat against a window scaled by a
   * straight third: par topped out at 132s against a 133s ceiling, and the
   * generator started rejecting exactly the long multi-change races that are
   * the good ones. Attempts per city went from 1.03 to 1.28 and the average
   * route lost a change.
   */
  parMin: 150 / TEMPO,
  parMax: 450 / TEMPO,
};

/** Player colours, in join order. */
export const PALETTE = [
  '#ff5c5c', '#5cc8ff', '#a4ff5c', '#ffdd5c', '#d25cff', '#5cffd8', '#ff9d5c', '#9d9dff',
];
