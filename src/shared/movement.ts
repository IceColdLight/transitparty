/**
 * Walking. Shared, because the client predicts it and the server decides it,
 * and the two have to agree about where the pavement is.
 */
import { CITY, STAMINA, WALK } from './constants.js';
import { type River, illegalCrossing } from './river.js';
import { type Streets, onStreet, snapToStreet } from './streets.js';

export type Walker = {
  x: number; y: number; vx: number; vy: number;
  /** 0..1 */
  stamina: number;
  /** whether the sprint is actually running — see the latch in stepWalk */
  sprinting: boolean;
};

export const newWalker = (x: number, y: number): Walker =>
  ({ x, y, vx: 0, vy: 0, stamina: 1, sprinting: false });

/**
 * One fixed step of walking. `wx, wy` is a world-space wish direction, already
 * normalised; zero means stand still.
 *
 * Two things can stop you: a building, and the river. The axis-separated retry
 * is what stops either being a wall you stick to — a diagonal into a corner
 * keeps whichever component still clears, so you slide along the frontage to
 * the junction, or along the bank towards the bridge, instead of stopping dead
 * and looking broken. On a rectilinear grid that also means holding a diagonal
 * walks you round a block without touching the keyboard again.
 */
export function stepWalk(
  p: Walker, wx: number, wy: number, dt: number, streets: Streets, river: River,
  wantSprint = false,
): void {
  /**
   * The latch: starting a sprint needs `floor` in the tank, continuing one
   * only needs something. Without the asymmetry, tapping the key every other
   * frame is a permanent speed boost with a stutter — faster than sprinting
   * properly, and unreadable to everybody watching you do it.
   */
  const moving = wx !== 0 || wy !== 0;
  p.sprinting = moving && wantSprint
    && (p.sprinting ? p.stamina > 0 : p.stamina >= STAMINA.floor);

  if (p.sprinting) p.stamina = Math.max(0, p.stamina - dt / STAMINA.burst);
  else p.stamina = Math.min(1, p.stamina + dt / STAMINA.recover);

  const speed = p.sprinting ? WALK.speed * WALK.sprint : WALK.speed;
  const tx = wx * speed, ty = wy * speed;
  const k = Math.min(1, WALK.accel * dt);
  p.vx += (tx - p.vx) * k;
  p.vy += (ty - p.vy) * k;

  const from = { x: p.x, y: p.y };

  // Somewhere off the grid — inside a building after a spawn, a rounding
  // error, an edit to the generator. Walk back onto the street rather than
  // being frozen there forever, which is the one failure a player cannot
  // diagnose or escape.
  if (!onStreet(streets, from)) {
    const back = snapToStreet(streets, from);
    const d = Math.hypot(back.x - from.x, back.y - from.y) || 1;
    p.x += ((back.x - from.x) / d) * WALK.speed * dt;
    p.y += ((back.y - from.y) / d) * WALK.speed * dt;
    p.vx = 0; p.vy = 0;
    return;
  }

  let nx = p.x + p.vx * dt;
  let ny = p.y + p.vy * dt;

  const clear = (x: number, y: number) =>
    onStreet(streets, { x, y })
    && !illegalCrossing(river, from, { x, y }, CITY.bridgeRadius);

  if (!clear(nx, ny)) {
    if (clear(nx, p.y)) { ny = p.y; p.vy = 0; }
    else if (clear(p.x, ny)) { nx = p.x; p.vx = 0; }
    else { nx = p.x; ny = p.y; p.vx = 0; p.vy = 0; }
  }

  p.x = Math.min(CITY.width, Math.max(0, nx));
  p.y = Math.min(CITY.height, Math.max(0, ny));
}
