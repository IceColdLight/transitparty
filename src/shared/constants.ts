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
  /**
   * Half the width of the water. The river is a hole in the ground with a quay
   * wall down each side, so this is also how much land it takes: nothing is
   * built inside it, and nothing walks across it except on a bridge.
   */
  channel: 48,
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
/**
 * Traffic lanes.
 *
 * Vehicle position is a pure function of the timetable, and nothing avoids
 * anything else, so every line calling at a stop parked in the same three
 * metres of road and every pair of lines sharing a street drove through each
 * other. In a top-down view that was untidy; in first person it made a
 * chokepoint unreadable — you could not tell what was there, let alone pick
 * the one you wanted.
 *
 * Each line is displaced sideways from the centre of the road, and the
 * displacement FLIPS with the direction of travel, so the city drives on one
 * side like a city. That alone separates every head-on pair. The lane index
 * then splits same-direction lines between two lanes.
 *
 * The displacement is baked into the geometry at generation time as a mitred
 * offset at each stop, not applied at runtime from the current heading —
 * computed live, the offset vector swings through ninety degrees at a corner
 * and the vehicle jumps across the junction.
 */
export const LANES = {
  /** distance from the centre line to the first lane */
  base: 2.2,
  /** and to the next one out — wider than the widest vehicle, so adjacent
   *  lanes cannot touch however they are assigned */
  gap: 4.0,
  count: 3,
  /**
   * How far a mitre may stretch the offset at a corner, as a multiple of the
   * lane's own width.
   *
   * A mitre keeps the offset road parallel to the centre line through a bend,
   * and the sharper the bend the further out the corner point goes — to
   * infinity at a hairpin. Clamping the ANGLE instead of the distance let a
   * bus route's tightest corner throw a vehicle 16.6m sideways, which is
   * outside the road it is supposed to be driving on.
   */
  maxMitre: 1.15,
  /**
   * How far apart, ALONG the road, different lines pull up at the same stop.
   *
   * Lanes separate opposing traffic and split same-direction lines two ways,
   * and that still left the worst case untouched: two bus lines sharing a lane
   * and a street travel at the same speed, so they can sit inside each other
   * for half a kilometre — and, much worse, park in the same three metres at
   * the stop where you are trying to tell them apart.
   *
   * Giving each line its own bay is the fix that matters, because the moment
   * that has to be readable is the one where you are choosing. It is baked
   * into the geometry alongside the lane offset, for the same reason: applied
   * from the heading at runtime it would swing round at every corner.
   */
  /**
   * Where each line stands AT a stop, measured along the street rather than
   * along the line.
   *
   * Lanes are expressed in each line's own frame, which separates lines that
   * run parallel and does nothing at all for lines that meet a stop from
   * different directions — a tram coming north and a bus coming east both sat
   * on the junction with their offsets pointing different ways, two metres
   * apart. Berths are in the street's frame, so they separate everything that
   * calls there whatever direction it arrived from.
   *
   * Four stands, spread along the kerb, and the platform is drawn long enough
   * to reach all of them. Beyond four lines a stop starts reusing them, which
   * is the residue this does not fix.
   */
  berth: 18,
  berths: 4,
};

export const PLATFORM = {
  /**
   * Clear of the outermost lane by a comfortable margin. There is one of these
   * on EACH side of the road, because with traffic keeping to one side the
   * platform you want depends on which way you are going — which is the
   * question the game most wants you to have to ask.
   */
  offset: 14.5,
  /**
   * Barely a kerb. The platform is drawn but not simulated — walking is flat,
   * on the street plane — so anything you could actually trip over is a step
   * the player walks straight through. Keep it low enough not to notice.
   */
  height: 0.06,
  length: 16,
  width: 3.4,
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
 * than climbed into. The widths are close to life size — they were half a
 * metre wider when landing on a roof was how you boarded, and once doors
 * became the way in, the extra width bought nothing and cost lane separation
 * on a road only so wide.
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
  train: { l: 46, w: 3.4, h: 4.0, deck: 0.7, wall: 3.3, doors: [-0.38, -0.14, 0.14, 0.38], doorWidth: 1.8 },
  metro: { l: 34, w: 3.1, h: 3.6, deck: 0.6, wall: 3.0, doors: [-0.36, -0.12, 0.12, 0.36], doorWidth: 1.7 },
  tram: { l: 22, w: 2.9, h: 3.4, deck: 0.5, wall: 1.05, doors: [-0.34, 0, 0.34], doorWidth: 1.6 },
  bus: { l: 13, w: 2.7, h: 3.2, deck: 0.5, wall: 1.05, doors: [-0.3, 0.28], doorWidth: 1.5 },
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
 * How far apart the two running lines of a railway are, and how much further
 * out a second line at the same station goes. Small: rail has its own
 * alignment and does not share a street with anybody, so it needs only enough
 * to keep opposing trains apart — and everything has to fit inside the station
 * box with room for a platform beside it.
 */
export const RAIL = {
  gauge: 2.7,
  spread: 3.4,
  /**
   * The sharpest turn a railway may make AT A STATION, in degrees.
   *
   * A station is a box square to the line with a train standing in it, and at
   * a bend those two things point in different directions — the platform along
   * one leg, the train along the other, the rails through the wall between
   * them. No amount of drawing fixes it; the geometry is simply contradictory.
   *
   * So the line is redrawn instead. The measured cost of demanding this is in
   * `tests/levels.test.ts`: it is nearly free, because a corridor that bends
   * hard at a stop is usually a corridor that went out to a bridge and came
   * straight back, which was a bad railway for other reasons too.
   */
  maxTurn: 30,
};

/**
 * What height each mode runs at. The metro is in a tunnel and the train is on
 * a viaduct; buses and trams are on the road with everybody else.
 *
 * These are the numbers that turn the city into three levels to navigate
 * rather than one. Deep enough that a staircase is a walk, shallow enough that
 * the walk is seconds rather than a chore.
 */
export const LEVELS: Record<ModeId, number> = {
  train: 9,
  metro: -8,
  tram: 0,
  bus: 0,
};

/** Platform boxes, the stairs into them, and the passage between. */
export const STATION = {
  /** the hall is this much longer than the vehicle that calls at it */
  overhang: 14,
  /** clear space either side of the outermost track, for people to stand on */
  platform: 3.6,
  /**
   * How far off the centre of the road the stairs are.
   *
   * On the FOOTWAY, beyond the outermost lane. The first version put the
   * entrance on the centre line where the stop is, which is the middle of the
   * carriageway — so a stairwell was a hole in the road with buses driving
   * through it.
   */
  entry: 14.3,
  /** length of the ramp, and so how far the entrance is along the street */
  shaftLength: 19,
  shaftWidth: 4.6,
  /** the corridor from the foot of the stairs to the platform */
  passageWidth: 7.5,
  /**
   * Seconds the route planner adds to boarding anything that is not at street
   * level. Stairs are not free, and a planner that thinks they are quotes
   * journeys that cannot be made in the time.
   */
  access: 14 / TEMPO,
};

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
/**
 * How long a door takes, and how long it stays shut before the wheels turn.
 *
 * ABSOLUTE seconds, like `dwell`, and short: the world runs at TEMPO, so a
 * real bus door's second and a half is half of one here. `settle` is the gap
 * between the doors finishing and the vehicle leaving — it is what makes
 * "shut, THEN go" something you can watch rather than something you are told.
 *
 * Both come out of the dwell, so they are also a tax on your window to board.
 * See `boardingWindow`, which is the number the sprint is actually sized
 * against; the four seconds a bus stands for is not four seconds of doorway.
 */
export const DOORS = {
  /** seconds from shut to fully open, and back */
  travel: 0.35,
  /** seconds standing with the doors shut before departure */
  settle: 0.15,
} as const;

type ModeSpec = {
  /** cruise speed, m/s */
  speed: number;
  /**
   * Seconds standing at each stop — your window to run, less what the doors
   * themselves take at each end of it.
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
  tram:  { speed: 11 * TEMPO, dwell: 4, headway: 78 / TEMPO, spacing: 300, width: 8,
    prefix: 'T', label: 'tram', colors: ['#2fa36b', '#3f9d9d', '#77a832', '#3f8f5c'] },
  bus:   { speed: 8 * TEMPO,  dwell: 4, headway: 68 / TEMPO, spacing: 195, width: 6,
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
   * How long the rest of the field gets once somebody has finished.
   *
   * There is no round timer any more, and that is deliberate. A hard stop on
   * the clock has to be set against the worst case — somebody who has taken a
   * wrong bus and is walking back — so it is always far longer than any round
   * actually needs, which means it never does anything except sit there
   * counting down at people who are doing fine. What actually ends a round is
   * that somebody won it. Everyone else gets two minutes to come in.
   *
   * ABSOLUTE seconds, like `dwell` and `intermissionSeconds`: it is a
   * concession to the people still travelling, and a person's patience does
   * not speed up because the trams do.
   */
  wrapSeconds: 120,
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
