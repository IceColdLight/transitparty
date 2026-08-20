/**
 * Render the game's own views to PNG, without a browser.
 *
 * `src/client/world.ts` and `src/client/map.ts` only ever touch the standard
 * Canvas2D API, so they will draw into a server-side canvas exactly as they
 * draw into the real one. That makes the UI reviewable from a terminal, which
 * on a machine with no browser is the difference between checking a layout and
 * guessing at it — this tool found five real bugs the first time it was
 * pointed at the map, including a legend sitting under the status panel and a
 * destination badge hidden behind the players standing on it.
 *
 *   npm run shots            a default city
 *   npm run shots -- 4242    a specific seed
 *
 * It is not a test: nothing here asserts. It renders, you look.
 */
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildCity } from '../src/shared/city.js';
import { allVehicles } from '../src/shared/vehicles.js';
import { drawWorld } from '../src/client/world.js';
import { drawMap } from '../src/client/map.js';
import type { PlayerState } from '../src/shared/types.js';

for (const [file, name] of [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'system-ui'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'system-ui'],
] as const) {
  try { GlobalFonts.registerFromPath(file, name); } catch { /* fall back to whatever is installed */ }
}

const seed = Number(process.argv[2]) || 452460421;
const out = new URL('../shots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const city = buildCity(seed);
const t = 140;
const vehicles = allVehicles(city, t);
const o = city.stops[city.origin];

/** Two on the platform and one already moving, so every case gets drawn. */
const players: PlayerState[] = [
  { id: 'p1', name: 'You', color: '#ff5c5c', x: o.x + 6, y: o.y + 4, facing: 0, riding: null, stamina: 1, sprinting: false, finished: null, place: 0 },
  // Ada is legging it, so the speed lines get drawn.
  { id: 'p2', name: 'Ada', color: '#5cc8ff', x: o.x - 34, y: o.y + 4, facing: 0, riding: null, stamina: 0.6, sprinting: true, finished: null, place: 0 },
];
const rider = vehicles.find((v) => v.atStop < 0);
if (rider) {
  players.push({ id: 'p3', name: 'Bo', color: '#a4ff5c', x: rider.x, y: rider.y, facing: 0, riding: rider.id, stamina: 0.55, sprinting: false, finished: null, place: 0 });
}

function shot(name: string, w: number, h: number, fn: (ctx: SKRSContext2D) => void) {
  const canvas = createCanvas(w, h);
  fn(canvas.getContext('2d'));
  writeFileSync(`${out}${name}.png`, canvas.toBuffer('image/png'));
  console.log(`  shots/${name}.png  ${w}x${h}`);
}

const wide = { w: 1440, h: 860 };
const narrow = { w: 820, h: 620 };
// The drawing code is typed against the DOM's context; the server-side one is
// the same API with a different name, and only the type disagrees.
const as2d = (c: SKRSContext2D) => c as unknown as CanvasRenderingContext2D;

console.log(`seed ${city.seed}: ${o.name} → ${city.stops[city.destination].name}, ` +
  `${city.stops.length} stops, ${city.lines.length} lines, ${vehicles.length} vehicles`);
shot('world', wide.w, wide.h, (c) =>
  drawWorld(as2d(c), city, { x: o.x, y: o.y, scale: 1.6 }, wide, vehicles, players, 'p1', t));
shot('world-riding', wide.w, wide.h, (c) => rider && drawWorld(
  as2d(c), city, { x: rider.x, y: rider.y, scale: 0.85 }, wide, vehicles, players, 'p3', t));
shot('map', wide.w, wide.h, (c) => drawMap(as2d(c), city, wide, vehicles, players, 'p1', 1));
shot('map-narrow', narrow.w, narrow.h, (c) => drawMap(as2d(c), city, narrow, vehicles, players, 'p1', 1));
