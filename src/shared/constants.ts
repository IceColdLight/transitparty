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
  /**
   * Sprint multiplier. Sized against the DOORS, which is the only moment it
   * exists for: a bus stands for four seconds, so from forty metres out you
   * miss it walking (5.6s) and make it running (3.3s). Anything less and the
   * key does nothing you would notice; anything more and the whole city is a
   * sprint away.
   */
  sprint: 1.7,
  /** Reaching full speed almost at once. A race wants crisp starts, not inertia. */
  accel: 26 * TEMPO,
  /** Longest transfer the route planner will consider on foot. */
  transferMax: 260,
};

/**
 * Sprinting is a burst, not a gear. You get a few seconds of it and then you
 * have to have not used it for a while.
 *
 * The shape matters more than the numbers. A sprint you can hold indefinitely
 * is just a faster walk speed, and a faster walk speed is a direct attack on
 * the one thing this game rests on — that the network beats your legs. What a
 * burst buys instead is a DECISION, made twice a race: the doors are open and
 * you are forty metres away, do you spend it here or keep it for the change
 * at the far end.
 */
export const STAMINA = {
  /** seconds of continuous sprint from full */
  burst: 3.6,
  /** seconds of not sprinting to refill from empty */
  recover: 13,
  /**
   * You cannot START a sprint below this, though you may finish one. Without
   * it, tapping the key every other frame is a permanent 40% speed boost with
   * a stutter, which is both faster than sprinting properly and unreadable to
   * everyone watching.
   */
  floor: 0.25,
};

/**
 * What you actually average on a long walk, sprinting whenever you can.
 *
 * The route planner uses THIS, not the base speed. In steady state you can
 * sprint burst/(burst + recover) of the time — about a fifth — which is worth
 * a 15% quicker walk overall. Small, but the walk-versus-ride margin is the
 * criterion every generated race is vetted against, and quoting it against a
 * speed the player can beat just by holding a key would make `par` a
 * comfortable lie.
 *
 * It is deliberately derived rather than typed in: change the sprint or the
 * stamina and the planner follows.
 */
const sprintDuty = STAMINA.burst / (STAMINA.burst + STAMINA.recover);
export const SUSTAINED_WALK =
  WALK.speed * (1 - sprintDuty) + WALK.speed * WALK.sprint * sprintDuty;

/**
 * The player as a physical object. First person, so these are real metres:
 * the eye height is what you see the city from and the step is what lets you
 * walk onto a bus without thinking about it.
 */
export const PLAYER = {
  eye: 1.62,
  radius: 0.36,
  /**
   * How high a lip you can walk up without jumping. Every vehicle deck is
   * below this on purpose — boarding at a stop should be walking on, not a
   * platforming challenge. Jumping OFF is where the skill lives.
   */
  step: 0.75,
  /** m/s upward. Clears about 1.2m, which is a railing and not a building. */
  jump: 7.4,
  gravity: 22,
  /** how hard you can steer in mid-air, m/s per second */
  airAccel: 10,
  /**
   * How fast borrowed momentum bleeds off once your feet leave the deck.
   * A jump hangs for 2*jump/gravity, so at 0.55 you keep about 70% of a
   * tram's speed through the arc — which is the difference between hopping
   * off and being fired off.
   */
  airDrag: 0.55,
};

/**
 * How far the platform sits from the middle of the road.
 *
 * This exists because of a bug that would otherwise have no fix. A stop and
 * the vehicle calling at it are the same point, and anything standing over a
 * deck is lifted onto it — so a player waiting at a stop would be scooped up
 * by whatever arrived first, and the choice of what to board would be made
 * for them. Standing them five metres to one side puts three metres of road
 * between the platform and the widest vehicle in the city, and boarding
 * becomes what it should be: you walk out and get on THAT one.
 */
export const PLATFORM = {
  offset: 5,
  /**
   * Barely a kerb. The platform is drawn but not simulated — walking is flat,
   * on the street plane — so anything you could actually trip over is a step
   * the player walks straight through. Keep it low enough not to notice.
   */
  height: 0.06,
  length: 16,
  width: 4,
};

/**
 * Vehicle bodies, in metres, and they are rooms rather than blocks.
 *
 * Every one has a floor, walls and DOORS, and on foot the doors are the only
 * way through the walls. That turns getting off at the right stop into
 * something you plan a few seconds ahead — stand near a door, or spend the
 * dwell walking to one — which is most of what makes riding interesting
 * rather than a wait with scenery.
 *
 * The decks are all under PLAYER.step, so a doorway is walked through rather
 * than climbed into. The widths are a little over life size: a 2.55m bus is a
 * miserable thing to land on at speed, and the extra half metre is the
 * difference between a stunt that works and one that works sometimes.
 */
export const BODIES: Record<ModeId, {
  /** length, width and overall height in metres */
  l: number;
  w: number;
  h: number;
  /** height of the floor you stand on */
  deck: number;
  /**
   * Height of the side walls above the deck. Under a jump's clearance on a bus
   * and a tram — you can vault out over the side — and full height on a metro
   * and a train, where you cannot.
   */
  wall: number;
  /**
   * Door centres, as a fraction of the length either side of the middle,
   * mirrored onto both sides so it does not matter which side the platform is
   * on.
   */
  doors: number[];
  doorWidth: number;
}> = {
  train: { l: 46, w: 4.0, h: 4.0, deck: 0.7, wall: 3.3, doors: [-0.38, -0.14, 0.14, 0.38], doorWidth: 1.8 },
  metro: { l: 34, w: 3.6, h: 3.6, deck: 0.6, wall: 3.0, doors: [-0.36, -0.12, 0.12, 0.36], doorWidth: 1.7 },
  tram: { l: 22, w: 3.2, h: 3.4, deck: 0.5, wall: 1.05, doors: [-0.34, 0, 0.34], doorWidth: 1.6 },
  bus: { l: 13, w: 3.0, h: 3.2, deck: 0.5, wall: 1.05, doors: [-0.3, 0.28], doorWidth: 1.5 },
};

/*
 * BOARD_RADIUS is gone. It said how close you had to be to a stop to press
 * the board key, and there is no board key: a vehicle is a surface and you get
 * on it by standing on it. The distance that matters now is the width of the
 * road between the platform and the deck — PLATFORM.offset.
 */
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
  /**
   * Hard stop on a round, in case somebody wanders off.
   *
   * Generous, and more so since the game went first person. `par` is a
   * planner's number: it costs the ride and the wait and says nothing about
   * finding the platform, misjudging a gap, or being carried two stops past
   * your change because you were looking the wrong way. Ending a round on the
   * clock is a failure of the timer, not of the player.
   */
  roundSeconds: 900 / TEMPO,
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

  /**
   * How much slower the race must be if you only ever board a metro or a
   * train. It is the number that stops the whole game being "find the metro".
   *
   * Rail is fast, runs straight instead of round the block, and stops rarely,
   * so it wins any comparison it is allowed into — and with a third of every
   * city's stations on the rail network, it was allowed into nearly all of
   * them. Measured over 50 cities, ignoring every bus and tram cost you 47%:
   * annoying, and nowhere near enough to make anybody read a map. The road
   * network was decoration.
   *
   * Two rules fix it and both are what a real network looks like rather than
   * a handicap. Races start and finish OFF the rail network, so the local
   * lines are how you reach the trunk and how you leave it. And a race is
   * thrown out unless rail-only genuinely costs you this much. Together they
   * take rail-only from x1.47 to x1.94 of the best route, and the share of
   * races where rail alone comes within 15% of it from a third to none — at
   * no cost in cities: still 50 out of 50 on the first pass.
   */
  minRailPenalty: 1.25,

  /**
   * And the same in the other direction. Penalising rail alone without
   * penalising road alone just swaps which mode you can safely ignore, and
   * "always take the bus" is exactly as shallow a map as "always take the
   * metro" — it is simply slower.
   *
   * Lower than the rail figure on purpose. Buses go everywhere, so a
   * road-only route almost always EXISTS; it is just slow. Demanding as big a
   * penalty from it as from rail throws away most of the good races.
   */
  minRoadPenalty: 1.18,
};

/** Player colours, in join order. */
export const PALETTE = [
  '#ff5c5c', '#5cc8ff', '#a4ff5c', '#ffdd5c', '#d25cff', '#5cffd8', '#ff9d5c', '#9d9dff',
];
