/**
 * Render the game to PNG with no browser: the first-person view through
 * headless WebGL, and the map you hold up, drawn on its card.
 *
 * This exists because the alternative is guessing. A three-dimensional city
 * has a hundred ways to look wrong that no test will ever catch — a sign
 * facing the wrong way, a bus sunk into the road, fog that eats the
 * destination — and every one of them is obvious in a picture.
 *
 *   npm run shots            a default city
 *   npm run shots -- 4242    a specific seed
 *
 * It is not a test: nothing here asserts. It renders, you look.
 */
import createGL from 'gl';
import * as THREE from 'three';
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PLAYER, PLATFORM } from '../src/shared/constants.js';
import { buildCity } from '../src/shared/city.js';
import { platformAt } from '../src/shared/streets.js';
import { allVehicles } from '../src/shared/vehicles.js';
import { SIGN_H, SIGN_W, buildScene, paintSign } from '../src/client/scene.js';
import { drawMap } from '../src/client/map.js';
import type { PlayerState } from '../src/shared/types.js';

const W = 1440, H = 860;
const seed = Number(process.argv[2]) || 452460421;
const out = new URL('../shots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const city = buildCity(seed);
const time = 140;
const vehicles = allVehicles(city, time);

// ── a WebGL context with nothing behind it ───────────────────────────────
/**
 * three.js speaks WebGL2 and headless-gl only speaks WebGL1, so the handful
 * of calls three makes that WebGL1 has no word for are filled in from the
 * equivalent extensions — instancing, vertex arrays — and the ones this scene
 * genuinely never uses (3D textures, transform feedback, queries) are stubbed
 * so the renderer can finish starting up.
 *
 * It is a rendering harness, not the game. If a shot ever looks wrong in a way
 * the browser does not, suspect this before suspecting the scene.
 */
const context = createGL(W, H, { preserveDrawingBuffer: true }) as any;
{
  const ext = (n: string) => context.getExtension(n);
  const inst = ext('ANGLE_instanced_arrays');
  const vao = ext('OES_vertex_array_object');
  const noop = () => {};
  const shim: Record<string, unknown> = {
    texImage3D: noop, texSubImage3D: noop, texStorage2D: noop, texStorage3D: noop,
    compressedTexImage3D: noop, copyTexSubImage3D: noop,
    createQuery: () => null, deleteQuery: noop, beginQuery: noop, endQuery: noop,
    getQueryParameter: () => 0,
    bindBufferBase: noop, uniformBlockBinding: noop,
    getUniformBlockIndex: () => 0, getActiveUniformBlockParameter: () => 0,
    invalidateFramebuffer: noop, drawBuffers: noop, readBuffer: noop,
    blitFramebuffer: noop, renderbufferStorageMultisample: noop,
    clearBufferfv: noop, clearBufferiv: noop, clearBufferfi: noop,
    vertexAttribDivisor: inst ? inst.vertexAttribDivisorANGLE.bind(inst) : noop,
    drawArraysInstanced: inst ? inst.drawArraysInstancedANGLE.bind(inst) : noop,
    drawElementsInstanced: inst ? inst.drawElementsInstancedANGLE.bind(inst) : noop,
    createVertexArray: vao ? vao.createVertexArrayOES.bind(vao) : () => null,
    bindVertexArray: vao ? vao.bindVertexArrayOES.bind(vao) : noop,
    deleteVertexArray: vao ? vao.deleteVertexArrayOES.bind(vao) : noop,
    samplerParameteri: noop, bindSampler: noop, createSampler: () => null,
  };
  for (const [k, v] of Object.entries(shim)) if (typeof context[k] !== 'function') context[k] = v;
  // three asks for GLSL 3.00 shaders when it thinks it has WebGL2; this
  // context compiles GLSL 1.00, so tell it what it really has.
  context.getParameter = ((orig) => (p: number) =>
    p === 0x8B8C ? 'WebGL GLSL ES 1.0' : orig.call(context, p))(context.getParameter);
}
const fakeCanvas = {
  width: W, height: H, style: {},
  addEventListener() {}, removeEventListener() {},
  getContext: () => context,
};
const renderer = new THREE.WebGLRenderer({
  canvas: fakeCanvas as unknown as HTMLCanvasElement,
  context: context as unknown as WebGLRenderingContext,
  antialias: false,
});
renderer.setSize(W, H, false);

/** Station signs, painted on a server-side canvas and handed over as raw pixels. */
function sign(text: string, sub: string[], color: string): THREE.Texture {
  const c = createCanvas(SIGN_W, SIGN_H);
  paintSign(c.getContext('2d') as unknown as CanvasRenderingContext2D, text, sub, color);
  const img = c.getContext('2d').getImageData(0, 0, SIGN_W, SIGN_H);
  const tex = new THREE.DataTexture(new Uint8Array(img.data), SIGN_W, SIGN_H, THREE.RGBAFormat);
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

const built = buildScene(city, { sign });
const camera = new THREE.PerspectiveCamera(76, W / H, 0.1, 4200);
camera.rotation.order = 'YXZ';

const origin = city.stops[city.origin];
const pad = platformAt(city.streets, origin, city.origin);
const people: PlayerState[] = [
  { id: 'p2', name: 'Ada', color: '#5cc8ff', x: pad.x + 4, y: pad.y + 6, h: 0, facing: 1,
    grounded: true, riding: null, stamina: 0.6, sprinting: true, finished: null, place: 0 },
];
built.updateVehicles(city, vehicles);
built.updatePlayers(people, 'p1');

function shoot(name: string, x: number, y: number, h: number, look: number, pitch = 0) {
  camera.position.set(x, h + PLAYER.eye, y);
  camera.rotation.set(pitch, -(look + Math.PI / 2), 0);
  renderer.render(built.scene, camera);

  const px = new Uint8Array(W * H * 4);
  context.readPixels(0, 0, W, H, context.RGBA, context.UNSIGNED_BYTE, px);
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  // GL reads bottom-up; images are top-down.
  for (let row = 0; row < H; row++) {
    const from = (H - 1 - row) * W * 4;
    img.data.set(px.subarray(from, from + W * 4), row * W * 4);
  }
  ctx.putImageData(img, 0, 0);
  writeFileSync(`${out}${name}.png`, c.toBuffer('image/png'));
  console.log(`  shots/${name}.png`);
}

console.log(`seed ${city.seed}: ${origin.name} → ${city.stops[city.destination].name}, ` +
  `${city.stops.length} stops, ${vehicles.length} vehicles`);

// Standing on the origin platform, looking along the street.
const onVertical = city.streets.xs.some((x) => Math.abs(origin.x - x) <= city.streets.width / 2);
const along = onVertical ? Math.PI / 2 : 0;
// A few metres along the platform, where a player actually stands.
const step = onVertical ? { x: 0, y: 6 } : { x: 6, y: 0 };
shoot('fp-platform', pad.x - step.x, pad.y - step.y, PLATFORM.height, along);
// Straight down, to see the layout whole.
shoot('aerial', origin.x + 90, origin.y + 90, 260, along, -1.45);
shoot('fp-across', pad.x, pad.y, PLATFORM.height, Math.atan2(origin.y - pad.y, origin.x - pad.x));
shoot('fp-up', pad.x, pad.y, PLATFORM.height, along, 0.5);

// Riding: stand on a moving vehicle and look forward down the line.
const rider = vehicles.find((v) => v.atStop < 0 && ['bus', 'tram'].includes(city.lines[v.line].mode));
if (rider) shoot('fp-riding', rider.x, rider.y, 0.5, rider.angle);

// The new levels: a stair mouth from the street, and down on a platform.
{
  const st = city.stations.find((x) => x.mode === 'metro');
  if (st) {
    const mouth = {
      x: st.shaft.x - Math.cos(st.shaft.angle) * st.shaft.hl,
      y: st.shaft.y - Math.sin(st.shaft.angle) * st.shaft.hl,
    };
    shoot('stairs-down', mouth.x - Math.cos(st.shaft.angle) * 9,
      mouth.y - Math.sin(st.shaft.angle) * 9, 0, st.shaft.angle, -0.25);
    shoot('platform-under', st.hall.x - Math.cos(st.hall.angle) * (st.hall.hl - 6),
      st.hall.y - Math.sin(st.hall.angle) * (st.hall.hl - 6), st.level, st.hall.angle);
  }
  const tr = city.stations.find((x) => x.mode === 'train');
  if (tr) {
    shoot('viaduct', tr.hall.x - Math.cos(tr.hall.angle) * 60,
      tr.hall.y - Math.sin(tr.hall.angle) * 60, 0, tr.hall.angle, 0.25);
    // On the elevated platform, looking down the track.
    const across = tr.hall.angle + Math.PI / 2;
    const off = tr.trackHalf + 1.6;
    shoot('platform-over',
      tr.hall.x + Math.cos(across) * off - Math.cos(tr.hall.angle) * (tr.hall.hl - 4),
      tr.hall.y + Math.sin(across) * off - Math.sin(tr.hall.angle) * (tr.hall.hl - 4),
      tr.level, tr.hall.angle);
  }
}

// One portrait of each mode, from the side, ten metres off.
for (const mode of ['bus', 'tram', 'metro', 'train'] as const) {
  const v = vehicles.find((x) => city.lines[x.line].mode === mode && x.atStop >= 0)
    ?? vehicles.find((x) => city.lines[x.line].mode === mode);
  if (!v) continue;
  const side = v.angle + Math.PI / 2;
  shoot(`model-${mode}`, v.x - Math.cos(side) * 17, v.y - Math.sin(side) * 17, 3.4, side, -0.12);
}

// And the map, on its card, exactly as it is pasted onto the held quad.
{
  const MW = 1024, MH = 704, PAD = 30;
  const c = createCanvas(MW, MH);
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D;
  g.fillStyle = '#cfc7b4';
  g.fillRect(0, 0, MW, MH);
  g.fillStyle = '#b8b0a0';
  g.fillRect(MW / 2 - 1, 0, 2, MH);
  g.save();
  g.translate(PAD, PAD);
  drawMap(g, city, { w: MW - PAD * 2, h: MH - PAD * 2 }, vehicles, people, 'p1', 1);
  g.restore();
  writeFileSync(`${out}held-map.png`, c.toBuffer('image/png'));
  console.log('  shots/held-map.png');
}
