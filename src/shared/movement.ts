/**
 * Walking. Shared, because the client predicts it and the server decides it,
 * and the two have to agree about what the river does.
 */
import { CITY, WALK } from './constants.js';
import { type River, illegalCrossing } from './river.js';

export type Walker = { x: number; y: number; vx: number; vy: number };

/**
 * One fixed step of walking. `wx, wy` is a world-space wish direction, already
 * normalised; zero means stand still.
 *
 * The river is the only thing you can collide with, and the axis-separated
 * retry is what stops it being a wall you stick to: a diagonal into the bank
 * keeps whichever component still clears the water, so you slide along the
 * riverside towards the bridge instead of stopping dead and looking broken.
 */
export function stepWalk(p: Walker, wx: number, wy: number, dt: number, river: River): void {
  const tx = wx * WALK.speed, ty = wy * WALK.speed;
  const k = Math.min(1, WALK.accel * dt);
  p.vx += (tx - p.vx) * k;
  p.vy += (ty - p.vy) * k;

  const from = { x: p.x, y: p.y };
  let nx = p.x + p.vx * dt;
  let ny = p.y + p.vy * dt;

  const clear = (x: number, y: number) =>
    !illegalCrossing(river, from, { x, y }, CITY.bridgeRadius);

  if (!clear(nx, ny)) {
    if (clear(nx, p.y)) { ny = p.y; p.vy = 0; }
    else if (clear(p.x, ny)) { nx = p.x; p.vx = 0; }
    else { nx = p.x; ny = p.y; p.vx = 0; p.vy = 0; }
  }

  p.x = Math.min(CITY.width, Math.max(0, nx));
  p.y = Math.min(CITY.height, Math.max(0, ny));
}
