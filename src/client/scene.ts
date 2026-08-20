/**
 * The city, built once from a seed, as three.js geometry.
 *
 * Everything static goes in on load and never moves: the ground, the blocks,
 * the water, the bridges, the platforms and their signs. Only the vehicles and
 * the other players are touched per frame, and the vehicles are read straight
 * out of the timetable, so this file has no simulation in it at all.
 *
 * Two things are doing most of the work for the FEEL of the thing:
 *
 * **Fog.** It is not atmosphere, it is the game design. In the old top-down
 * view you could read half the network at a glance, which made the map on TAB
 * redundant and the route obvious. Down here you can see to the end of the
 * street and no further, so where the lines go is something you have to have
 * looked up and remembered.
 *
 * **The beam.** The destination is a column of light you can see over the
 * rooftops. Without it a first-person city is a maze with no compass, and the
 * game stops being about routes and starts being about not getting lost —
 * which is a different, worse game.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BODIES, CITY, LANES, LEVELS, PLATFORM, type ModeId } from '../shared/constants.js';
import { onStreet, platformAt } from '../shared/streets.js';
import { nearestOnRiver } from '../shared/river.js';
import { inRect } from '../shared/stations.js';
import { VIADUCT_CLEARANCE, footprintsOf, hash2, viaductLegs } from '../shared/plots.js';
import type { City, PlayerState, Vehicle } from '../shared/types.js';

/**
 * How far the pavement stands proud of the carriageway.
 *
 * Barely anything, and deliberately: walking is flat — there is one ground
 * plane and the kerb is not in it — so a step you could trip over is a step
 * the player walks straight through. Everything else laid on the pavement
 * (the boarding platforms) starts from here rather than from the road, or it
 * ends up buried inside it.
 */
const FOOTWAY = 0.16;

/** Horizon and zenith. The fog takes the horizon colour so distance dissolves into it. */
const SKY_LOW = 0xa8c8e8;
const SKY_HIGH = 0x4f92d8;

/**
 * How far you can see.
 *
 * Fog is a design tool here, not weather: it is the reason the network has to
 * be looked up and remembered rather than glanced at. It used to close in at
 * 340m, which was a couple of blocks and read as murk.
 *
 * It has been opened up because the wayfinding around it got richer — every
 * street is named and the map no longer shows you where you are, so the city
 * is now something you read rather than something you squint through. You can
 * see across a few junctions; you still cannot see where a line GOES.
 */
export const FOG_NEAR = 180;
export const FOG_FAR = 720;

/**
 * Painting a station sign, given a 2D context to paint it on. The context is
 * passed in rather than fetched so the same code can run against a browser
 * canvas and against a server-side one — which is what lets tools/shots.ts
 * render the city to a PNG with no browser anywhere.
 */
export function paintSign(
  g: CanvasRenderingContext2D, text: string, sub: string[], color: string,
  bg = '#10151c',
) {
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 80);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(3, 3, 250, 74);
  g.fillStyle = '#eef3f8';
  g.font = '700 27px system-ui, sans-serif';
  g.textAlign = 'center';
  let name = text;
  while (g.measureText(name).width > 232 && name.length > 4) name = name.slice(0, -1);
  g.fillText(name, 128, sub.length ? 38 : 50);
  // the lines that call here, as coloured tabs
  let x = 128 - (sub.length * 30) / 2;
  for (const c2 of sub) {
    g.fillStyle = c2;
    g.fillRect(x, 50, 24, 14);
    x += 30;
  }
}

export const SIGN_W = 256, SIGN_H = 80;

function browserSign(text: string, sub: string[], color: string, bg?: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = SIGN_W; c.height = SIGN_H;
  paintSign(c.getContext('2d')!, text, sub, color, bg);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export type Scene3D = {
  scene: THREE.Scene;
  /** keep the sky centred on whoever is looking; call it every frame */
  setViewer(x: number, y: number, z: number): void;
  /** call each frame with the current fleet */
  updateVehicles(city: City, vehicles: Vehicle[]): void;
  updatePlayers(players: PlayerState[], selfId: string): void;
  dispose(): void;
};

/** Swappable so a headless renderer can supply textures without a DOM. */
export type SceneOpts = {
  sign?: (text: string, sub: string[], color: string, bg?: string) => THREE.Texture;
};

export function buildScene(city: City, opts: SceneOpts = {}): Scene3D {
  const makeSign = opts.sign ?? browserSign;
  const junk: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const keepEarly = <T extends THREE.BufferGeometry | THREE.Material>(x: T) => {
    junk.push(x); return x;
  };
  let skyMesh: THREE.Mesh | null = null;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(SKY_LOW, FOG_NEAR, FOG_FAR);
  /**
   * A flat fallback behind everything. Belt and braces: if the sky sphere is
   * ever missed, the result should be a plain blue, never a black hole.
   */
  scene.background = new THREE.Color(SKY_LOW);

  /**
   * A real sky: a gradient from a pale horizon to a proper blue overhead,
   * painted on the inside of a sphere. A shader rather than a texture so it
   * needs no canvas, which is what lets the headless renderer draw it too.
   */
  {
    const sky = new THREE.Mesh(
      keepEarly(new THREE.SphereGeometry(3000, 24, 12)),
      keepEarly(new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          low: { value: new THREE.Color(SKY_LOW) },
          high: { value: new THREE.Color(SKY_HIGH) },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 low;
          uniform vec3 high;
          varying vec3 vDir;
          void main() {
            float t = clamp(vDir.y * 1.15, 0.0, 1.0);
            gl_FragColor = vec4(mix(low, high, pow(t, 0.85)), 1.0);
          }`,
      })),
    );
    /**
     * The sky FOLLOWS THE VIEWER. Left at the world origin, a sphere of any
     * radius is eventually somewhere you can walk out of — this city is 3000m
     * across, so a player near the far corner was standing outside their own
     * sky and looking at the culled back of it, which renders as a black
     * circle overhead.
     *
     * It also never writes depth and draws first, so it can never occlude
     * anything however close the geometry gets.
     */
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    skyMesh = sky;
    scene.add(sky);
  }

  scene.add(new THREE.HemisphereLight(0xe6f0fb, 0x39424e, 2.0));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.7);
  sun.position.set(-0.5, 1, 0.35);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd4ee, 0.5);
  fill.position.set(0.6, 0.4, -0.7);
  scene.add(fill);

  const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T) => {
    junk.push(x); return x;
  };

  /**
   * Every hole in the pavement: the mouth of each stairwell that goes DOWN.
   *
   * The ground is cut for these, and so is everything else laid on top of it —
   * the footways and the boarding platforms. They are not decoration on the
   * road, they ARE the road at that point, and paving one over the top of a
   * subway entrance puts the stairs back underneath a solid surface, which is
   * how the entrance came to be invisible the first time.
   *
   * Axis-aligned, because a shaft runs along its street.
   */
  const holePad = 0.6;
  const groundHoles = city.stations
    .filter((st) => st.level < 0)
    .map((st) => {
      const c = Math.abs(Math.cos(st.shaft.angle)), sn = Math.abs(Math.sin(st.shaft.angle));
      const hx = (st.shaft.hl + holePad) * c + (st.shaft.hw + holePad) * sn;
      const hy = (st.shaft.hl + holePad) * sn + (st.shaft.hw + holePad) * c;
      return { x0: st.shaft.x - hx, x1: st.shaft.x + hx, y0: st.shaft.y - hy, y1: st.shaft.y + hy };
    });

  /**
   * What is left of a run from `lo` to `hi` once the holes crossing it are
   * taken out. One strip in, none or more strips out.
   */
  const cutRun = (
    lo: number, hi: number, crossLo: number, crossHi: number, vertical: boolean,
  ): [number, number][] => {
    let spans: [number, number][] = [[lo, hi]];
    for (const h of groundHoles) {
      const [a, b] = vertical ? [h.y0, h.y1] : [h.x0, h.x1];
      const [ca, cb] = vertical ? [h.x0, h.x1] : [h.y0, h.y1];
      if (cb <= crossLo || ca >= crossHi) continue;
      const next: [number, number][] = [];
      for (const [s0, s1] of spans) {
        if (b <= s0 || a >= s1) { next.push([s0, s1]); continue; }
        if (a > s0) next.push([s0, a]);
        if (b < s1) next.push([b, s1]);
      }
      spans = next;
    }
    return spans;
  };

  /**
   * Open water, away from a bridge — where nothing built on the ground plane
   * belongs. A footway running the length of its street laid a kerb straight
   * across the river and out the other side, and the fence beside a viaduct
   * did the same.
   */
  const CHANNEL = CITY.channel;
  const overWater = (x: number, y: number) => {
    if (nearestOnRiver(city.river, { x, y }).dist > CHANNEL - 6) return false;
    return !city.river.bridges.some((b) => Math.hypot(b.x - x, b.y - y) < CITY.bridgeRadius);
  };

  /**
   * The channel, as one polygon per stretch of open water between bridges.
   *
   * The river was drawn as a ribbon of blue sunk a metre below the street and
   * then the ground was laid straight over the top of it, so the only place it
   * existed was the map — which is a strange thing for the feature the whole
   * game's route planning rests on. The ground gets a hole instead, and what
   * is under the hole is water.
   *
   * Split at the bridges, because a bridge is where the ground carries on.
   */
  const channels: { x: number; y: number }[][] = (() => {
    const pts = city.river.poly;
    const fine: { x: number; y: number; nx: number; ny: number }[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const steps = Math.max(1, Math.round(len / 20));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        fine.push({ x: a.x + dx * u, y: a.y + dy * u, nx: -dy / len, ny: dx / len });
      }
    }
    fine.push({
      x: pts[pts.length - 1].x, y: pts[pts.length - 1].y,
      nx: fine[fine.length - 1].nx, ny: fine[fine.length - 1].ny,
    });
    const open = fine.map((p) => !city.river.bridges
      .some((b) => Math.hypot(b.x - p.x, b.y - p.y) < CITY.bridgeRadius));
    const out: { x: number; y: number }[][] = [];
    let run: typeof fine = [];
    const flush = () => {
      if (run.length >= 2) {
        const poly = run.map((p) => ({ x: p.x + p.nx * CHANNEL, y: p.y + p.ny * CHANNEL }));
        for (let i = run.length - 1; i >= 0; i--) {
          poly.push({ x: run[i].x - run[i].nx * CHANNEL, y: run[i].y - run[i].ny * CHANNEL });
        }
        out.push(poly);
      }
      run = [];
    };
    fine.forEach((p, i) => { if (open[i]) run.push(p); else flush(); });
    flush();
    return out;
  })();

  /**
   * The ground, with a hole cut through it at every stairwell that goes DOWN.
   *
   * It used to be one unbroken plane, which meant the road was paved over the
   * top of every subway entrance: the stairs were there, you could walk down
   * them, and there was nothing whatever to see from the street. A staircase
   * you cannot find is a station you cannot use.
   *
   * Only descending shafts get a hole. A flight rising to a viaduct stands ON
   * the pavement and the pavement stays where it is.
   */
  const groundMat = keep(new THREE.MeshLambertMaterial({ color: 0x4a5058 }));
  {
    const pad = holePad;
    const shape = new THREE.Shape();
    const x0 = -CITY.width * 0.3, x1 = CITY.width * 1.3;
    const z0 = -CITY.height * 0.3, z1 = CITY.height * 1.3;
    // Built in (x, -z) so a single rotateX(-90) lays it flat facing up.
    shape.moveTo(x0, -z0);
    shape.lineTo(x1, -z0);
    shape.lineTo(x1, -z1);
    shape.lineTo(x0, -z1);
    shape.closePath();

    for (const st of city.stations) {
      if (st.level >= 0) continue;
      const c = Math.cos(st.shaft.angle), sn = Math.sin(st.shaft.angle);
      const hl = st.shaft.hl + pad, hw = st.shaft.hw + pad;
      const corner = (a: number, b: number) => ({
        x: st.shaft.x + c * a - sn * b,
        z: st.shaft.y + sn * a + c * b,
      });
      const pts = [corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)];
      const hole = new THREE.Path();
      hole.moveTo(pts[0].x, -pts[0].z);
      for (let i = 1; i < pts.length; i++) hole.lineTo(pts[i].x, -pts[i].z);
      hole.closePath();
      shape.holes.push(hole);
    }

    for (const poly of channels) {
      const hole = new THREE.Path();
      hole.moveTo(poly[0].x, -poly[0].y);
      for (let i = 1; i < poly.length; i++) hole.lineTo(poly[i].x, -poly[i].y);
      hole.closePath();
      shape.holes.push(hole);
    }

    const geo = keep(new THREE.ShapeGeometry(shape));
    geo.rotateX(-Math.PI / 2);
    scene.add(new THREE.Mesh(geo, groundMat));
  }

  // ── blocks, as instanced boxes. One block is not one building: it is split
  //    into footprints on a small grid, which is what makes a street read as a
  //    street rather than a canyon between two slabs.
  const CLEARANCE = VIADUCT_CLEARANCE;
  const railSegs = viaductLegs(city);

  /**
   * What stands on each block is decided in shared/plots.ts, because a bare
   * plot is a property of the CITY rather than of the picture: it is land the
   * player can see and cannot walk on, and that deserves a test rather than a
   * bug report.
   */
  const boxes = footprintsOf(city);
  const parks = city.blocks.filter((bl) => bl.park)
    .map((bl) => ({ x: bl.x + bl.w / 2, z: bl.y + bl.h / 2, w: bl.w, d: bl.h }));

  /**
   * A building is four instanced pieces rather than one box: a plinth at the
   * pavement, the mass, a cap on the roof, and a run of floor bands up the
   * face. Some get a setback tower on top so the skyline is not a row of
   * identical slabs.
   *
   * All of it is instanced, so the whole city's built fabric is five draw
   * calls however many blocks it has — and the bands, which do most of the
   * work of stopping a wall looking like a wall, are the cheapest part of it.
   */
  const unit = keep(new THREE.BoxGeometry(1, 1, 1));
  const massMat = keep(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const trimMat = keep(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  // Glazing, not liquorice. At 1.5m deep and near-black the bands turned every
  // façade into a humbug; a slim, dim strip reads as a row of windows instead.
  const bandMat = keep(new THREE.MeshLambertMaterial({ color: 0x3f4c5e }));

  type Piece = { m: THREE.Matrix4; c: THREE.Color };
  const mass: Piece[] = [], trim: Piece[] = [], bands: THREE.Matrix4[] = [];
  const col = new THREE.Color();
  const tmp = new THREE.Matrix4();

  /** Masonry, not noise: a handful of plausible façade colours, picked per plot. */
  const PALETTE: [number, number, number][] = [
    [0.09, 0.22, 0.62],   // warm sandstone
    [0.04, 0.34, 0.44],   // brick
    [0.58, 0.06, 0.68],   // pale blue-grey stone
    [0.11, 0.10, 0.74],   // cream render
    [0.45, 0.09, 0.52],   // weathered green-grey
    [0.02, 0.16, 0.38],   // dark brick
  ];

  for (const b of boxes) {
    const pick = PALETTE[Math.floor(hash2(b.y, b.x) * PALETTE.length) % PALETTE.length];
    const shade = 0.88 + b.tone * 0.24;
    col.setHSL(pick[0], pick[1], Math.min(0.82, pick[2] * shade));

    const setback = b.tone > 0.62 && b.h > 26;
    const mainH = setback ? b.h * 0.68 : b.h;

    tmp.makeScale(b.w, mainH, b.d);
    tmp.setPosition(b.x, mainH / 2, b.y);
    mass.push({ m: tmp.clone(), c: col.clone() });

    // plinth: a wider, darker storey at street level
    const dark = col.clone().multiplyScalar(0.72);
    tmp.makeScale(b.w + 0.7, 2.6, b.d + 0.7);
    tmp.setPosition(b.x, 1.3, b.y);
    trim.push({ m: tmp.clone(), c: dark });

    // roof cap
    tmp.makeScale(b.w + 0.5, 0.7, b.d + 0.5);
    tmp.setPosition(b.x, mainH + 0.35, b.y);
    trim.push({ m: tmp.clone(), c: dark });

    if (setback) {
      const tw = b.w * 0.6, td = b.d * 0.6, th = b.h - mainH;
      tmp.makeScale(tw, th, td);
      tmp.setPosition(b.x, mainH + th / 2, b.y);
      mass.push({ m: tmp.clone(), c: col.clone() });
      tmp.makeScale(tw + 0.4, 0.6, td + 0.4);
      tmp.setPosition(b.x, mainH + th + 0.3, b.y);
      trim.push({ m: tmp.clone(), c: dark });
    }

    // floor bands, which read as windows from any distance worth reading at
    const storey = 4.2;
    const floors = Math.min(9, Math.floor((mainH - 5) / storey));
    for (let f = 0; f < floors; f++) {
      tmp.makeScale(b.w + 0.06, 0.62, b.d + 0.06);
      tmp.setPosition(b.x, 4.6 + f * storey, b.y);
      bands.push(tmp.clone());
    }
  }

  const instanced = (pieces: Piece[], mat: THREE.Material) => {
    const mesh = new THREE.InstancedMesh(unit, mat, pieces.length);
    pieces.forEach((p, i) => { mesh.setMatrixAt(i, p.m); mesh.setColorAt(i, p.c); });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  };
  instanced(mass, massMat);
  instanced(trim, trimMat);
  {
    const mesh = new THREE.InstancedMesh(unit, bandMat, bands.length);
    bands.forEach((m2, i) => mesh.setMatrixAt(i, m2));
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  const parkMat = keep(new THREE.MeshLambertMaterial({ color: 0x2f5c37 }));
  const hedgeMat = keep(new THREE.MeshLambertMaterial({ color: 0x24472c }));
  for (const p of parks) {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(p.w, 0.25, p.d)), parkMat);
    mesh.position.set(p.x, 0.12, p.z);
    scene.add(mesh);
    const t = 1.0, hgt = 1.15;
    for (const [w, d, dx, dz] of [
      [p.w, t, 0, -p.d / 2], [p.w, t, 0, p.d / 2],
      [t, p.d, -p.w / 2, 0], [t, p.d, p.w / 2, 0],
    ] as const) {
      const h = new THREE.Mesh(keep(new THREE.BoxGeometry(w, hgt, d)), hedgeMat);
      h.position.set(p.x + dx, hgt / 2, p.z + dz);
      scene.add(h);
    }
  }

  /**
   * A fence either side of the viaduct's land, for the same reason.
   *
   * In panels, not in one run per leg: a viaduct crosses a road every couple
   * of hundred metres, and a single box the length of the leg puts a metre and
   * a half of timber straight across the carriageway — a wall standing in the
   * road that a pedestrian walks through, which is worse than no fence at all.
   * It stops at the kerb and starts again on the far side.
   */
  {
    const posts: THREE.BufferGeometry[] = [];
    const PANEL = 8;
    for (const seg of railSegs) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      const ang = Math.atan2(dy, dx);
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      for (const side of [-1, 1]) {
        for (let t = 0; t + PANEL <= len; t += PANEL) {
          const m = t + PANEL / 2;
          const px = seg.ax + ux * m + nx * side * CLEARANCE;
          const py = seg.ay + uy * m + ny * side * CLEARANCE;
          if (onStreet(city.streets, { x: px, y: py })) continue;
          if (overWater(px, py)) continue;
          const g = new THREE.BoxGeometry(PANEL - 0.4, 1.3, 0.5);
          g.translate(0, 0.65, 0);
          g.rotateY(-ang);
          g.translate(px, 0, py);
          posts.push(g);
        }
      }
    }
    if (posts.length) {
      const g = mergeGeometries(posts, false)!;
      posts.forEach((x) => x.dispose());
      scene.add(new THREE.Mesh(keep(g), keep(new THREE.MeshLambertMaterial({ color: 0x4d4437 }))));
    }
  }

  /**
   * Footways down both sides of every street.
   *
   * They separate the part of the road you share with a tram from the part you
   * do not, which the game has needed since traffic went into lanes: the
   * carriageway is where you get run over and the pavement is where you wait.
   * Laid in segments BETWEEN junctions, because a continuous strip would pave
   * straight across every crossing.
   *
   * Barely raised. Walking is flat — there is one ground plane and the kerb is
   * not in it — so anything you could actually trip over is a step the player
   * walks through.
   */
  {
    const half = city.streets.width / 2;
    const walkW = half - (LANES.base + (LANES.count - 1) * LANES.gap + 2.4);
    const mid = half - walkW / 2;
    const slabs: THREE.BufferGeometry[] = [];
    const gap = half + 1;

    const run = (a: number, b: number, fixed: number, vertical: boolean) => {
      if (b - a < 6) return;
      for (const side of [-1, 1]) {
        const c = fixed + side * mid;
        // Broken wherever the ground itself is, and wherever it would be
        // paving across open water: the bridge carries its own deck.
        for (const [s0, s1] of cutRun(a, b, c - walkW / 2, c + walkW / 2, vertical)) {
          const len = s1 - s0;
          if (len < 2) continue;
          const mx = vertical ? c : (s0 + s1) / 2;
          const my = vertical ? (s0 + s1) / 2 : c;
          if (overWater(mx, my)) continue;
          const g = new THREE.BoxGeometry(
            vertical ? walkW : len, FOOTWAY, vertical ? len : walkW,
          );
          g.translate(mx, FOOTWAY / 2, my);
          slabs.push(g);
        }
      }
    };

    // Between junctions, and in pieces short enough that "is this over the
    // river" is a question with a useful answer.
    const STEP = 24;
    const paved = (a: number, b: number, fixed: number, vertical: boolean) => {
      for (let t = a; t < b; t += STEP) run(t, Math.min(b, t + STEP), fixed, vertical);
    };
    for (const x of city.streets.xs) {
      const cuts = [0, ...city.streets.ys, CITY.height];
      for (let i = 0; i + 1 < cuts.length; i++) {
        paved(cuts[i] + (i === 0 ? 0 : gap), cuts[i + 1] - (i + 2 === cuts.length ? 0 : gap), x, true);
      }
    }
    for (const y of city.streets.ys) {
      const cuts = [0, ...city.streets.xs, CITY.width];
      for (let i = 0; i + 1 < cuts.length; i++) {
        paved(cuts[i] + (i === 0 ? 0 : gap), cuts[i + 1] - (i + 2 === cuts.length ? 0 : gap), y, false);
      }
    }

    if (slabs.length) {
      const g = mergeGeometries(slabs, false)!;
      slabs.forEach((x) => x.dispose());
      scene.add(new THREE.Mesh(keep(g), keep(new THREE.MeshLambertMaterial({ color: 0x6b7079 }))));
    }
  }

  /**
   * Road markings. They are not decoration: standing on the deck of a tram
   * doing thirty metres a second down a straight grey street, the dashes going
   * past are the only thing telling you how fast you are moving. Without them
   * the city reads as static until a building goes by.
   */
  {
    const dash: THREE.Matrix4[] = [];
    const put = (x: number, z: number, along: 'x' | 'z') => {
      const mm = new THREE.Matrix4();
      mm.makeScale(along === 'x' ? 5.5 : 0.34, 1, along === 'x' ? 0.34 : 5.5);
      mm.setPosition(x, 0.02, z);
      dash.push(mm);
    };
    const GAP = 13;
    // Not across the water: a centre line painted over the river is the same
    // mistake as a pavement laid across it, only harder to spot.
    for (const x of city.streets.xs) {
      for (let z = 40; z < CITY.height - 40; z += GAP) if (!overWater(x, z)) put(x, z, 'z');
    }
    for (const y of city.streets.ys) {
      for (let x = 40; x < CITY.width - 40; x += GAP) if (!overWater(x, y)) put(x, y, 'x');
    }
    const marks = new THREE.InstancedMesh(
      keep(new THREE.BoxGeometry(1, 0.04, 1)),
      keep(new THREE.MeshLambertMaterial({ color: 0xc9c2a8 })),
      dash.length,
    );
    dash.forEach((mm, i) => marks.setMatrixAt(i, mm));
    marks.instanceMatrix.needsUpdate = true;
    scene.add(marks);
  }

  // ── the river: water in the channel, with a quay wall down each bank ─────
  const stoneMat = keep(new THREE.MeshLambertMaterial({ color: 0x565c66 }));
  {
    const half = CHANNEL;
    const pts = city.river.poly;
    const pos: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * half, ny = dx / len * half;
      pos.push(pts[i].x + nx, 0, pts[i].y + ny, pts[i].x - nx, 0, pts[i].y - ny);
    }
    const idx: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    /**
     * Double-sided, and not because you can get under it. The strip is built
     * as a pair of edges per polyline point, so which way its faces point
     * depends on which way the river happens to run — and it did not matter
     * while the ground was laid over the top of it and the water was never
     * visible at all. Now that the channel is a hole, a river drawn the wrong
     * way round is a hole with sky at the bottom.
     */
    const water = new THREE.Mesh(geo, keep(new THREE.MeshLambertMaterial({
      color: 0x244f6e, side: THREE.DoubleSide,
    })));
    water.position.y = -1.4;
    scene.add(water);

    /**
     * The quay. It does two jobs: it closes the vertical face between the
     * street and the water, which would otherwise be a strip of sky at the
     * waterline, and it MARKS THE EDGE. Land you can see and cannot enter is
     * indistinguishable from an invisible wall unless something stands at the
     * boundary, and the river is the biggest piece of unenterable land in the
     * city — you may not walk across it except on a bridge, and that rule is
     * the reason the game has route planning in it.
     */
    const quay: THREE.BufferGeometry[] = [];
    for (const poly of channels) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = poly[i], b = poly[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        // The polygon runs up one bank and back down the other; the joining
        // edge at each end is the open water, and gets no wall.
        if (len < 1 || len > 40) continue;
        const g = new THREE.BoxGeometry(len + 1.2, 3.6, 1.4);
        g.translate(0, -1.4, 0);
        g.rotateY(-Math.atan2(dy, dx));
        g.translate((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
        quay.push(g);
      }
    }
    if (quay.length) {
      const g = mergeGeometries(quay, false)!;
      quay.forEach((x) => x.dispose());
      scene.add(new THREE.Mesh(keep(g), stoneMat));
    }
  }

  // ── bridges ─────────────────────────────────────────────────────────────
  for (const b of city.river.bridges) {
    // Top flush with the road. At -0.2 the deck stood 400mm proud of the
    // street and pedestrians walked through the side of it, because walking
    // is flat and knows only about streets and vehicle decks.
    const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(CITY.bridgeRadius * 2.1, 1.2, 190)), stoneMat);
    deck.position.set(b.x, -0.6, b.y);
    scene.add(deck);
  }

  // ── platforms and their signs ────────────────────────────────────────────
  const padMat = keep(new THREE.MeshLambertMaterial({ color: 0x6a717c }));
  const poleMat = keep(new THREE.MeshLambertMaterial({ color: 0x232830 }));
  // One platform each side of the road, because traffic keeps to one side.
  for (const s of city.stops) {
   for (const side of [1, -1] as const) {
    const pad = platformAt(city.streets, s, s.id, side);
    const onVertical = city.streets.xs.some((x) => Math.abs(s.x - x) <= city.streets.width / 2);
    // Long enough to reach every stand this stop uses. A one-line stop gets a
    // shelter; a six-line interchange gets a bus station.
    const stands = Math.min(s.lines.length, LANES.berths);
    const long = PLATFORM.length + (stands - 1) * LANES.berth;
    const short = PLATFORM.width;
    /**
     * On TOP of the pavement, and broken where the pavement is.
     *
     * `STATION.entry` and `PLATFORM.offset` are within a metre of each other —
     * both belong on the footway — so a rail stop's boarding island and its
     * subway entrance are laid across one another. The island loses: it is the
     * thing you can walk round, and a staircase you cannot see is a station
     * you cannot use. Sitting it on the kerb rather than on the road matters
     * too: at 60mm on a 160mm pavement the whole platform was buried.
     */
    const lo = (onVertical ? pad.y : pad.x) - long / 2;
    const hi = lo + long;
    const cLo = (onVertical ? pad.x : pad.y) - short / 2;
    for (const [s0, s1] of cutRun(lo, hi, cLo, cLo + short, onVertical)) {
      if (s1 - s0 < 2) continue;
      const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(
        onVertical ? short : s1 - s0, FOOTWAY + PLATFORM.height, onVertical ? s1 - s0 : short,
      )), padMat);
      mesh.position.set(
        onVertical ? pad.x : (s0 + s1) / 2,
        (FOOTWAY + PLATFORM.height) / 2,
        onVertical ? (s0 + s1) / 2 : pad.y,
      );
      scene.add(mesh);
    }

    /**
     * The sign goes on the BACK edge of the platform, away from the road.
     * At the centre it stands exactly where a player waiting for a vehicle
     * stands, which in first person means a black rectangle across your view
     * and a pole through your head.
     */
    // Away from the road, whichever way the platform stepped off it.
    const off = { x: pad.x - s.x, y: pad.y - s.y };
    const offLen = Math.hypot(off.x, off.y) || 1;
    const back = {
      x: pad.x + (off.x / offLen) * (short / 2 - 0.4),
      y: pad.y + (off.y / offLen) * (short / 2 - 0.4),
    };
    const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.09, 0.09, 3.4, 6)), poleMat);
    pole.position.set(back.x, 1.7, back.y);
    scene.add(pole);

    const tex = keep(makeSign(s.name, s.lines.map((l) => city.lines[l].color),
      s.lines.length > 1 ? '#ffd166' : '#8b9aa8'));
    const sign = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(3.2, 1.0)),
      keep(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: true })),
    );
    sign.position.set(back.x, 3.3, back.y);
    // Face along the street, so it is readable from where you walk up — and
    // put a second one back to back with it, because a double-sided plane
    // shows the far side mirrored and a station called ferhabtpuaH helps
    // nobody.
    sign.rotation.y = onVertical ? 0 : Math.PI / 2;
    scene.add(sign);
    /**
     * A hair behind the first, along its own normal. Two planes back to back
     * at exactly the same position are coplanar, and coplanar surfaces
     * z-fight: the depth test picks whichever won this pixel, so the name and
     * the line colours shimmer and tear as you move.
     */
    const twin = sign.clone();
    twin.rotation.y += Math.PI;
    const n = { x: Math.sin(-sign.rotation.y), y: Math.cos(-sign.rotation.y) };
    twin.position.set(back.x - n.x * 0.03, 3.3, back.y - n.y * 0.03);
    scene.add(twin);
   }
  }

  /**
   * The rail levels: tunnels for the metro, a viaduct for the train, and
   * proper track on both.
   *
   * The tunnel is drawn inside-out — you only ever see it from within, and
   * from outside it would otherwise be a dark slab lying across the city. The
   * viaduct is drawn the usual way round, because you walk under it.
   */
  {
    const rail: THREE.BufferGeometry[] = [];
    const tunnel: THREE.BufferGeometry[] = [];
    const deckGeo: THREE.BufferGeometry[] = [];
    const sleeper: THREE.BufferGeometry[] = [];

    for (const line of city.lines) {
      if (line.mode !== 'metro' && line.mode !== 'train') continue;
      const level = LEVELS[line.mode];
      const gauge = line.mode === 'train' ? 1.5 : 1.4;
      const body = BODIES[line.mode];

      for (let i = 0; i + 1 < line.stops.length; i++) {
        const a = city.stops[line.stops[i]], b = city.stops[line.stops[i + 1]];
        const la = line.lane[i], lb = line.lane[i + 1];

        /**
         * A railway has TWO running lines and they are not in the same place:
         * a vehicle sits at the stop plus its lane offset TIMES ITS DIRECTION,
         * so the up line is at +lane and the down line at -lane. Drawing the
         * track once, at +lane, left half the service running on rails and the
         * other half floating in mid-air.
         */
        for (const dir of [1, -1] as const) {
          const ax = a.x + la.x * dir, ay = a.y + la.y * dir;
          const bx = b.x + lb.x * dir, by = b.y + lb.y * dir;
          const dx = bx - ax, dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < 1) continue;
          const ang = Math.atan2(dy, dx);
          const mx = (ax + bx) / 2, my = (ay + by) / 2;

          for (const side of [-1, 1]) {
            const g = new THREE.BoxGeometry(len, 0.16, 0.12);
            g.translate(0, level + 0.08, side * gauge);
            g.rotateY(-ang);
            g.translate(mx, 0, my);
            rail.push(g);
          }
          for (let d = -len / 2 + 1; d < len / 2; d += 3.2) {
            const g = new THREE.BoxGeometry(0.5, 0.14, gauge * 2.6);
            g.translate(d, level - 0.02, 0);
            g.rotateY(-ang);
            g.translate(mx, 0, my);
            sleeper.push(g);
          }
        }

        /**
         * The bore and the viaduct deck go on the CENTRE LINE and are wide
         * enough to hold both tracks. Built around one direction's rails, the
         * tunnel sat off to one side with the other line running through its
         * wall and out into the soil.
         */
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const ang = Math.atan2(dy, dx);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const reach = Math.max(Math.hypot(la.x, la.y), Math.hypot(lb.x, lb.y));
        const span = (reach + body.w / 2 + 1.8) * 2;

        const place = (
          into: THREE.BufferGeometry[], w: number, h: number, d: number, y: number,
        ) => {
          const g = new THREE.BoxGeometry(w, h, d);
          g.translate(0, y, 0);
          g.rotateY(-ang);
          g.translate(mx, 0, my);
          into.push(g);
        };

        if (line.mode === 'metro') {
          place(tunnel, len, body.h + 2.6, span, level + (body.h + 2.6) / 2 - 0.5);
        } else {
          place(deckGeo, len, 1.1, span, level - 0.75);
          /**
           * Piers, but never in the carriageway. A column every thirty-four
           * metres regardless of what is underneath drops a two-metre block of
           * concrete into the middle of a junction; a real viaduct spans the
           * road instead. If the spot is a street, the pier is skipped — the
           * span either side of it is what carries the deck.
           */
          for (let d = -len / 2 + 8; d < len / 2; d += 34) {
            const px = mx + Math.cos(ang) * d, py = my + Math.sin(ang) * d;
            if (onStreet(city.streets, { x: px, y: py })) continue;
            if (overWater(px, py)) continue;
            const g = new THREE.BoxGeometry(2.2, level, 2.2);
            g.translate(0, level / 2 - 1.2, 0);
            g.rotateY(-ang);
            g.translate(px, 0, py);
            deckGeo.push(g);
          }
        }
      }
    }

    const add = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!list.length) return;
      const g = mergeGeometries(list, false)!;
      list.forEach((x) => x.dispose());
      scene.add(new THREE.Mesh(keep(g), mat));
    };
    add(rail, keep(new THREE.MeshLambertMaterial({ color: 0x9aa3ad })));
    add(sleeper, keep(new THREE.MeshLambertMaterial({ color: 0x4a4038 })));
    add(deckGeo, keep(new THREE.MeshLambertMaterial({ color: 0x5a5f68 })));
    add(tunnel, keep(new THREE.MeshLambertMaterial({ color: 0x21252c, side: THREE.BackSide })));
  }

  /**
   * A name on every corner.
   *
   * The map deliberately does not show you where you are standing, so reading
   * the city is the only way to fix your position — and a city whose streets
   * have no names cannot be read. One post per junction carrying two plates,
   * each naming the street it faces down, exactly as a real one does.
   *
   * Textures are cached per NAME rather than per plate: a city has twenty-odd
   * streets and a hundred and sixty junctions, and painting a canvas for each
   * of three hundred plates would be three hundred textures of the same two
   * dozen words.
   */
  {
    /**
     * One material per NAME, not per plate. A city has twenty-odd streets and
     * a hundred and sixty junctions; painting a canvas for each of six hundred
     * plates would be six hundred textures of the same two dozen words.
     */
    const plates = new Map<string, THREE.MeshBasicMaterial>();
    const plate = (text: string) => {
      let m = plates.get(text);
      if (!m) {
        /**
         * Dark blue with a white border, so a street name and a station name
         * are never mistaken for one another at a glance. They hang at similar
         * heights on similar poles and both say a place name; the colour is
         * the only thing doing the telling apart.
         */
        m = keep(new THREE.MeshBasicMaterial({
          map: keep(makeSign(text, [], '#e8eef6', '#123a7a')), fog: true,
        }));
        plates.set(text, m);
      }
      return m;
    };
    const postMat = keep(new THREE.MeshLambertMaterial({ color: 0x2a2f38 }));
    const postGeo = keep(new THREE.CylinderGeometry(0.07, 0.07, 4.9, 6));
    const plateGeo = keep(new THREE.PlaneGeometry(2.7, 0.85));
    const half = city.streets.width / 2;

    /**
     * Mounted on the corner building wherever there is one, which is where a
     * European city puts them and is far easier to read than a pole: you are
     * walking down a street looking at the buildings anyway, and a plate on
     * the wall is at eye level in your path rather than somewhere overhead.
     *
     * A post is the fallback for a corner with no building on it — beside a
     * park, or where the railway has taken the plot.
     */
    /**
     * Nearest by CORNER, not by centre. A block's footprint can be sixty
     * metres across, so its middle is always further from the junction than
     * any sensible search radius — measured that way every corner in the city
     * failed to find a building and fell back to a post.
     */
    const nearestBuilding = (jx: number, jy: number) => {
      let best: typeof boxes[0] | null = null, bd = 34 * 34;
      for (const bx of boxes) {
        const cx = Math.max(bx.x - bx.w / 2, Math.min(jx, bx.x + bx.w / 2));
        const cy = Math.max(bx.y - bx.d / 2, Math.min(jy, bx.y + bx.d / 2));
        const d = (cx - jx) ** 2 + (cy - jy) ** 2;
        if (d < bd) { bd = d; best = bx; }
      }
      return best;
    };

    const MOUNT = 3.9;
    for (let i = 0; i < city.streets.xs.length; i++) {
      for (let j = 0; j < city.streets.ys.length; j++) {
        const x = city.streets.xs[i], y = city.streets.ys[j];
        const b = nearestBuilding(x, y);

        /** Two plates back to back, a few centimetres apart so they cannot z-fight. */
        const put = (text: string, px: number, py: number, pz: number, rot: number, both: boolean) => {
          for (const flip of both ? [0, Math.PI] : [0]) {
            const m = new THREE.Mesh(plateGeo, plate(text));
            const a = rot + flip;
            m.position.set(px - Math.sin(-a) * 0.03, py, pz - Math.cos(-a) * 0.03);
            m.rotation.y = a;
            scene.add(m);
          }
        };

        if (b) {
          // The corner of the building nearest the junction, one plate per face.
          const sx = Math.sign(x - b.x) || 1;
          const sy = Math.sign(y - b.y) || 1;
          /**
           * Well clear of the wall, and set back from the corner.
           *
           * At 12cm the plate was inside the plinth's overhang — the ground
           * storey is drawn 70cm wider than the mass — so the corner buildings
           * simply swallowed their own signs.
           */
          const cx = b.x + sx * (b.w / 2 + 0.55);
          const cy = b.y + sy * (b.d / 2 + 0.55);
          const inx = b.x + sx * (b.w / 2 - 2.0);
          const iny = b.y + sy * (b.d / 2 - 2.0);
          // faces along z carry the north-south street; faces along x the other
          put(city.streets.xNames[i], inx, MOUNT, cy, sy > 0 ? 0 : Math.PI, false);
          put(city.streets.yNames[j], cx, MOUNT - 0.95, iny,
            sx > 0 ? Math.PI / 2 : -Math.PI / 2, false);
        } else {
          const px = x + (i % 2 === 0 ? 1 : -1) * (half - 2.2);
          const py = y + (j % 2 === 0 ? 1 : -1) * (half - 2.2);
          const post = new THREE.Mesh(postGeo, postMat);
          post.position.set(px, 2.45, py);
          scene.add(post);
          put(city.streets.xNames[i], px, 4.1, py, 0, true);
          put(city.streets.yNames[j], px, 3.15, py, Math.PI / 2, true);
        }
      }
    }
  }

  // ── station halls, and the stairs into them ──────────────────────────────
  /**
   * Station surfaces are lit from within rather than by the sun, which does
   * not reach eight metres down a hole. Emissive is the cheap way to do it —
   * a light per station would be thirty lights in a scene that has two — and
   * it gives exactly the reading you want: a bright room at the bottom of a
   * dark stair, and a black tunnel either side of it.
   */
  const hallWall = keep(new THREE.MeshLambertMaterial({ color: 0x39414c, emissive: 0x2b323b }));
  const hallFloor = keep(new THREE.MeshLambertMaterial({ color: 0x8a929c, emissive: 0x4c545e }));
  const trackBed = keep(new THREE.MeshLambertMaterial({ color: 0x3a3f47, emissive: 0x1e232a }));

  for (const st of city.stations) {
    const wallMat = hallWall;
    const floorMat = hallFloor;
    const deck = st.deck;
    // From the station, not from the vehicle: the tracks lie at the line's own
    // lane offsets and the drawn bed has to be as wide as they are far apart.
    const trackHalf = st.trackHalf;

    const put = (mesh: THREE.Mesh, r: typeof st.hall, y: number) => {
      mesh.position.set(r.x, y, r.y);
      mesh.rotation.y = -r.angle;
      scene.add(mesh);
    };

    /**
     * Two platforms with the track between them, rather than one slab with
     * rails lying on top of it. The platform tops are flush with the train
     * floor and the track bed is a deck's depth below, which is what makes a
     * metro station read as a metro station at a glance.
     */
    const platHalf = Math.max(1.5, st.hall.hw - trackHalf) / 2;
    /** Anywhere in the hall's own frame: +l along the platform, +w across it. */
    const atHall = (l: number, w: number) => ({
      x: st.hall.x + Math.cos(st.hall.angle) * l + Math.sin(-st.hall.angle) * w,
      y: st.hall.y + Math.sin(st.hall.angle) * l + Math.cos(-st.hall.angle) * w,
    });
    const intoHall = (x: number, y: number) => {
      const dx = x - st.hall.x, dy = y - st.hall.y;
      const c = Math.cos(-st.hall.angle), sn = Math.sin(-st.hall.angle);
      return { l: dx * c - dy * sn, w: dx * sn + dy * c };
    };

    /**
     * The platform is a deck's depth THICK, not a slab lying on nothing.
     *
     * Its underside used to stop half a metre down while the track bed's top
     * sat a deck lower, leaving a hundred-millimetre slot along the platform
     * face — and since there is no geometry at all below a station, what came
     * through that slot was the sky. A bright blue line down both edges of
     * every underground platform.
     */
    for (const side of [-1, 1]) {
      const thick = 0.5 + deck;
      const m = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.hall.hl * 2, thick, platHalf * 2)), floorMat,
      );
      const p = atHall(0, side * (trackHalf + platHalf));
      m.position.set(p.x, st.level - thick / 2, p.y);
      m.rotation.y = -st.hall.angle;
      scene.add(m);
    }
    put(new THREE.Mesh(
      keep(new THREE.BoxGeometry(st.hall.hl * 2, 0.4, trackHalf * 2)), trackBed,
    ), st.hall, st.level - deck - 0.2);

    /**
     * Side walls with a doorway cut where the corridor arrives.
     *
     * The wall was one slab the length of the platform, so the passage from
     * the stairs ran straight into it: you walked down, along a corridor, and
     * through a wall. It is drawn in two pieces with a gap at the crossing
     * instead — and the gap is found by intersecting the corridor's centre
     * line with the wall, so it is in the right place whatever angle the
     * stairs came in at.
     */
    const pMouth = {
      x: st.passage.x - Math.cos(st.passage.angle) * st.passage.hl,
      y: st.passage.y - Math.sin(st.passage.angle) * st.passage.hl,
    };
    const pEnd = {
      x: st.passage.x + Math.cos(st.passage.angle) * st.passage.hl,
      y: st.passage.y + Math.sin(st.passage.angle) * st.passage.hl,
    };
    const la = intoHall(pMouth.x, pMouth.y), lb = intoHall(pEnd.x, pEnd.y);
    /**
     * Down past the track bed and up to meet the ceiling. Stopping at platform
     * level left a slot under the wall; stopping short of the ceiling left one
     * over it, and either way what came through was daylight.
     */
    const wallTop = st.level + (st.mode === 'metro' ? 5.4 : 3.4);
    const wallBot = st.level - deck - 0.6;
    const wallH = wallTop - wallBot;
    for (const side of [-1, 1]) {
      const face = side * st.hall.hw;
      let gap: [number, number] | null = null;
      if ((la.w - face) * (lb.w - face) < 0) {
        const u = (face - la.w) / (lb.w - la.w);
        const at = la.l + (lb.l - la.l) * u;
        const g = st.passage.hw + 0.8;
        gap = [at - g, at + g];
      }
      const spans: [number, number][] = gap
        ? [[-st.hall.hl, Math.min(st.hall.hl, gap[0])], [Math.max(-st.hall.hl, gap[1]), st.hall.hl]]
        : [[-st.hall.hl, st.hall.hl]];
      for (const [a, b] of spans) {
        if (b - a < 0.5) continue;
        const w = new THREE.Mesh(
          keep(new THREE.BoxGeometry(b - a, wallH, 0.5)), wallMat,
        );
        const p = atHall((a + b) / 2, face);
        w.position.set(p.x, (wallTop + wallBot) / 2, p.y);
        w.rotation.y = -st.hall.angle;
        scene.add(w);
      }
    }
    if (st.mode === 'metro') {
      put(new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.hall.hl * 2, 0.4, st.hall.hw * 2)), wallMat,
      ), st.hall, st.level + 5.2);
      /**
       * And the two ends, either side of the tunnel mouth. The bore is
       * narrower than the hall — a platform is wider than a tunnel, that is
       * what a platform IS — and the strips left over at each end were open to
       * the sky, which underground is a hole in the world.
       */
      const boreHalf = trackHalf + 1.8;
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) {
          const w = new THREE.Mesh(
            keep(new THREE.BoxGeometry(0.6, wallH, st.hall.hw - boreHalf)), wallMat,
          );
          const p = atHall(end * st.hall.hl, side * (boreHalf + (st.hall.hw - boreHalf) / 2));
          w.position.set(p.x, (wallTop + wallBot) / 2, p.y);
          w.rotation.y = -st.hall.angle;
          scene.add(w);
        }
      }
    }

    /**
     * The stairs. Drawn as actual steps rather than a slope — a ramp reads as
     * a car park, and the thing a player has to spot from the street is a
     * staircase. The walkable surface underneath is the ramp; the steps sit on
     * it, which is close enough at this size that nobody will catch it out.
     */
    const down = st.level < 0;
    const atShaft = (l: number, w: number) => ({
      x: st.shaft.x + Math.cos(st.shaft.angle) * l + Math.sin(-st.shaft.angle) * w,
      y: st.shaft.y + Math.sin(st.shaft.angle) * l + Math.cos(-st.shaft.angle) * w,
    });
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const at = atShaft(-st.shaft.hl + t * st.shaft.hl * 2, 0);
      /**
       * Deep treads, deliberately. A step drops further than half a metre at
       * this depth, so half-metre-thick treads left a slot between each pair —
       * and under a staircase there is nothing at all, so what showed through
       * the slots was the sky. Overlapping them makes the flight solid.
       */
      const tread = Math.abs(st.level) / steps + 0.9;
      const g = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.shaft.hl * 2 / steps, tread, st.shaft.hw * 2)), floorMat,
      );
      g.position.set(at.x, st.level * t - tread / 2, at.y);
      g.rotation.y = -st.shaft.angle;
      scene.add(g);
      // A balustrade on a flight going UP. A flight going down gets a wall
      // instead — see below — because it also has to hold the ground back.
      if (down) continue;
      for (const side of [-1, 1]) {
        const p = atShaft(-st.shaft.hl + t * st.shaft.hl * 2, side * st.shaft.hw);
        const w = new THREE.Mesh(
          keep(new THREE.BoxGeometry(st.shaft.hl * 2 / steps, 1.1, 0.3)), wallMat,
        );
        w.position.set(p.x, st.level * t + 0.55, p.y);
        w.rotation.y = -st.shaft.angle;
        scene.add(w);
      }
    }

    /**
     * A stairwell going down is a HOLE, and a hole needs sides.
     *
     * The ground is cut away over a descending shaft, and there was nothing
     * behind the cut: standing in the street and looking into a subway
     * entrance, what you saw past the steps was the sky sphere, because the
     * sky is drawn everywhere and nothing else was. Two retaining walls the
     * full depth of the shaft and a riser across its mouth close it.
     */
    if (down) {
      const top = 0.9, bottom = st.level - 2.2;
      for (const side of [-1, 1]) {
        const w = new THREE.Mesh(
          keep(new THREE.BoxGeometry(st.shaft.hl * 2 + 1.6, top - bottom, 0.8)), wallMat,
        );
        const p = atShaft(0, side * (st.shaft.hw + 0.4));
        w.position.set(p.x, (top + bottom) / 2, p.y);
        w.rotation.y = -st.shaft.angle;
        scene.add(w);
      }
      const riser = new THREE.Mesh(
        keep(new THREE.BoxGeometry(1.2, 2.2, st.shaft.hw * 2 + 1.6)), wallMat,
      );
      const p = atShaft(-st.shaft.hl - 0.3, 0);
      riser.position.set(p.x, -1.1, p.y);
      riser.rotation.y = -st.shaft.angle;
      scene.add(riser);
    }

    /**
     * The passage from the foot of the stairs in to the platform — drawn only
     * as far as the hall, not all the way to the platform edge.
     *
     * The walkable corridor has to reach a point ON a platform, or it stops
     * over the rails. The DRAWN one must not: carried the same distance it
     * hung a roof slab and two walls out over the platform, inside the room
     * they are supposed to be outside of. It is clipped at the wall it comes
     * through, which is exactly where the doorway is.
     */
    {
      const dx = pEnd.x - pMouth.x, dy = pEnd.y - pMouth.y;
      let stop = 1;
      for (let i = 1; i <= 48; i++) {
        const u = i / 48;
        if (inRect(st.hall, pMouth.x + dx * u, pMouth.y + dy * u)) { stop = u; break; }
      }
      const len = Math.hypot(dx, dy) * stop;
      const cx = pMouth.x + dx * stop / 2, cy = pMouth.y + dy * stop / 2;
      if (len > 1) {
        const pw = new THREE.Mesh(
          keep(new THREE.BoxGeometry(len, 0.4, st.passage.hw * 2)), floorMat,
        );
        pw.position.set(cx, st.level - 0.2, cy);
        pw.rotation.y = -st.passage.angle;
        scene.add(pw);
        if (st.mode === 'metro') {
          const roof = new THREE.Mesh(
            keep(new THREE.BoxGeometry(len, 0.35, st.passage.hw * 2)), wallMat,
          );
          roof.position.set(cx, st.level + 3.2, cy);
          roof.rotation.y = -st.passage.angle;
          scene.add(roof);
          // Sides, for the same reason the shaft has them: without, the
          // corridor is a floating slab with the sky either side of it.
          for (const side of [-1, 1]) {
            const w = new THREE.Mesh(
              keep(new THREE.BoxGeometry(len, 3.6, 0.4)), wallMat,
            );
            w.position.set(
              cx + Math.sin(-st.passage.angle) * side * st.passage.hw,
              st.level + 1.6,
              cy + Math.cos(-st.passage.angle) * side * st.passage.hw,
            );
            w.rotation.y = -st.passage.angle;
            scene.add(w);
          }
        }
      }
    }

    // a sign at the mouth of the stairs, so it can be found from the street
    const mouth = {
      x: st.shaft.x - Math.cos(st.shaft.angle) * st.shaft.hl,
      y: st.shaft.y - Math.sin(st.shaft.angle) * st.shaft.hl,
    };
    const entry = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(3.0, 0.94)),
      keep(new THREE.MeshBasicMaterial({
        map: keep(makeSign(city.stops[st.stop].name,
          city.stops[st.stop].lines
            .filter((l) => city.lines[l].mode === st.mode)
            .map((l) => city.lines[l].color),
          st.mode === 'metro' ? '#4aa3df' : '#8f6ec4')),
        side: THREE.DoubleSide,
      })),
    );
    entry.position.set(mouth.x, 2.6, mouth.y);
    entry.rotation.y = -st.shaft.angle + Math.PI / 2;
    scene.add(entry);
    // Back to back, and offset, or half the city reads "ferhabtpuaH" and the
    // other half watches the two faces z-fight over every pixel.
    const entryTwin = entry.clone();
    entryTwin.rotation.y += Math.PI;
    const en = { x: Math.sin(-entry.rotation.y), y: Math.cos(-entry.rotation.y) };
    entryTwin.position.set(mouth.x - en.x * 0.03, 2.6, mouth.y - en.y * 0.03);
    scene.add(entryTwin);
  }

  // ── where you are going, and where you started ───────────────────────────
  /**
   * Starts well above head height. At ground level it was a coloured wall
   * standing on the platform you spawn on — the first thing you saw of the
   * city was the inside of its own signpost.
   */
  const beam = (x: number, z: number, color: number) => {
    const mesh = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(2.4, 2.4, 260, 10, 1, true)),
      keep(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
        depthWrite: false, fog: false,
      })),
    );
    mesh.position.set(x, 30 + 130, z);
    scene.add(mesh);
  };
  beam(city.stops[city.destination].x, city.stops[city.destination].y, 0xffd166);
  beam(city.stops[city.origin].x, city.stops[city.origin].y, 0x7fe08a);

  // ── vehicles. The fleet is fixed for the life of a city, so build every
  //    body once and only move it afterwards.
  const vehicleMeshes = new Map<string, THREE.Mesh>();
  /**
   * Door leaves, one per doorway per side, kept out of the merged shell so
   * they can move. Doors were a hole in the bodywork that was always there,
   * which meant the one rule you have to read off a vehicle — can I get out —
   * had no picture. They slide now: shut while it runs, open at a stop.
   */
  const doorLeaves = new Map<string, THREE.Object3D[]>();
  const lineMats = city.lines.map((l) => keep(new THREE.MeshLambertMaterial({ color: l.color })));
  /**
   * Real glass: you can see through it, and through the vehicle. It was a flat
   * dark panel, which at a stop made every window read as a closed shutter and
   * hid the one thing a window is for — whether there is a way out behind it.
   * `depthWrite` off so panes on the far side of a carriage still draw.
   */
  const glassMat = keep(new THREE.MeshLambertMaterial({
    color: 0xbcd8e8, transparent: true, opacity: 0.3,
    side: THREE.DoubleSide, depthWrite: false,
  }));
  /**
   * One merged geometry per mode, built once and shared by every vehicle on
   * every line of it.
   *
   * A vehicle drawn as it should be — floor, wall panels with gaps for the
   * doors, lintels, glazing, wheels, roof kit — is twenty-odd boxes, and
   * there are a hundred and seventy vehicles in a city. Merging them into
   * three geometries (body, dark parts, glass) means three draw calls per
   * vehicle rather than twenty, and the door gaps are real holes you can see
   * the inside through.
   */
  const parts = (mode: ModeId) => {
    const b = BODIES[mode];
    const body: THREE.BufferGeometry[] = [];
    const dark: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    const box = (
      into: THREE.BufferGeometry[], w: number, h: number, d: number,
      x: number, y: number, z: number,
    ) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      into.push(g);
    };

    const closed = mode === 'metro' || mode === 'train';
    const T = 0.16;                       // panel thickness

    /**
     * The floor, and the room under it for the running gear.
     *
     * The body used to start at y=0, so a bus sat flat on the tarmac with its
     * wheels buried in the underframe. It rides on its wheels now: the floor
     * pan starts a wheel's radius up and the axles fill the gap.
     */
    const clear = b.deck * 0.62;
    box(dark, b.l, b.deck - clear, b.w, 0, clear + (b.deck - clear) / 2, 0);
    box(dark, b.l * 0.9, clear * 0.55, b.w * 0.78, 0, clear * 0.72, 0);

    /** The lengths of wall left between the doorways. */
    const spans = b.doors
      .map((d) => [d * b.l - b.doorWidth / 2, d * b.l + b.doorWidth / 2] as const)
      .sort((p1, p2) => p1[0] - p2[0]);
    const panels: { c: number; len: number }[] = [];
    let cut = -b.l / 2;
    for (const [a, z] of spans) {
      if (a > cut) panels.push({ c: (cut + a) / 2, len: a - cut });
      cut = Math.max(cut, z);
    }
    if (cut < b.l / 2) panels.push({ c: (cut + b.l / 2) / 2, len: b.l / 2 - cut });

    for (const side of [-1, 1]) {
      const z = side * (b.w / 2 - T / 2);
      for (const pn of panels) {
        box(body, pn.len, b.wall, T, pn.c, b.deck + b.wall / 2, z);
        /**
         * Glazing, recessed into the panel with a frame of body colour left
         * showing round it.
         *
         * A closed vehicle gets a deep window band. A ROAD vehicle keeps its
         * sides open above the waist rail and gets only a low light in the
         * panel itself — the open side is not laziness, it is the rule that
         * lets you vault out of a moving tram, and filling it with glass you
         * can walk through would be trading a mechanic for a pane.
         */
        const gy = b.deck + (closed ? 1.55 : 0.66);
        const gh = closed ? 1.15 : 0.4;
        if (pn.len > 1.4) {
          box(glass, pn.len - 0.55, gh, T * 0.9, pn.c, gy, z + side * T * 0.25);
        }
      }
      // ends
      box(body, T, b.wall, b.w, side * (b.l / 2 - T / 2), b.deck + b.wall / 2, 0);
    }

    /**
     * A roof for everything, but road vehicles carry theirs on pillars above
     * waist-high sides — an open-sided tram, which is a real thing and also
     * the only shape that satisfies both halves of the design: a cabin you are
     * inside, and a side low enough to vault when your stop goes past.
     *
     * Without it a bus was an open-topped box and read, accurately, as a skip.
     */
    if (closed) {
      box(body, b.l, 0.14, b.w, 0, b.deck + b.wall + 0.07, 0);
    } else {
      const roofY = b.deck + b.h - 0.07;
      box(body, b.l, 0.14, b.w, 0, roofY, 0);
      for (const side of [-1, 1]) {
        const z = side * (b.w / 2 - T / 2);
        for (const pn of panels) {
          for (const end of [-1, 1]) {
            const px = pn.c + end * (pn.len / 2 - 0.09);
            box(body, 0.18, b.h - b.wall - 0.14, T, px, b.deck + b.wall + (b.h - b.wall) / 2 - 0.07, z);
          }
        }
      }
    }

    // benches down both sides, so the inside looks like an inside
    for (const side of [-1, 1]) {
      for (const pn of panels) {
        if (pn.len < 1.4) continue;
        box(dark, pn.len - 0.4, 0.42, 0.52,
          pn.c, b.deck + 0.21, side * (b.w / 2 - 0.42));
      }
    }

    /**
     * Running gear. A bus has two axles at the ends of it; anything on rails
     * has bogies, which are a pair of close-set axles under a frame — and it
     * is the give-away silhouette from any distance.
     */
    const bogie = closed || mode === 'tram';
    const centres = mode === 'bus' ? [-0.31, 0.33] : [-0.34, 0.34];
    for (const a of centres) {
      const axles = bogie ? [a - 0.045, a + 0.045] : [a];
      if (bogie) {
        box(dark, b.l * 0.13, clear * 0.85, b.w * 0.62, a * b.l, clear * 0.62, 0);
      }
      for (const ax of axles) {
        for (const side of [-1, 1]) {
          const wheel = new THREE.CylinderGeometry(clear, clear, 0.3, 10);
          wheel.rotateX(Math.PI / 2);
          wheel.translate(ax * b.l, clear, side * (b.w / 2 - 0.3));
          dark.push(wheel);
        }
      }
    }

    // roof kit — the quickest way to tell the four apart at a distance
    const roof = b.deck + (closed ? b.wall + 0.14 : b.h);
    if (mode === 'tram' || mode === 'train') {
      // pantograph: a folded arm and the bar that rides the wire
      box(dark, 1.6, 0.1, 0.12, b.l * 0.22, roof + 0.5, -0.35);
      box(dark, 1.6, 0.1, 0.12, b.l * 0.22, roof + 0.5, 0.35);
      box(dark, 0.16, 0.06, b.w * 0.7, b.l * 0.22 + 0.7, roof + 0.95, 0);
    }
    if (mode === 'metro') {
      for (const a of [-0.25, 0, 0.25]) box(dark, b.l * 0.16, 0.34, b.w * 0.55, a * b.l, roof + 0.17, 0);
    }
    if (mode === 'train') {
      // a nose, so the front of a train looks like the front of a train
      box(body, b.l * 0.06, b.wall * 0.72, b.w * 0.86, b.l * 0.5, b.deck + b.wall * 0.36, 0);
    }
    /**
     * A windscreen at each end. On an open-sided road vehicle it sits in the
     * band between the waist rail and the roof, which is the only glass it
     * carries; on a metro or a train it is the full height of the end wall,
     * and it is what lets you see down a platform from inside a carriage.
     */
    for (const end of [-1, 1]) {
      const y0 = closed ? b.deck + 0.75 : b.deck + b.wall + 0.1;
      const y1 = b.deck + (closed ? b.wall - 0.25 : b.h - 0.4);
      box(glass, 0.12, y1 - y0, b.w * 0.84, end * (b.l / 2 - 0.25), (y0 + y1) / 2, 0);
    }
    if (mode === 'tram') {
      // an articulation waist, narrower than the rest of it
      box(dark, 1.2, b.wall * 0.9, b.w * 1.02, 0, b.deck + b.wall / 2, 0);
    }

    const merge = (list: THREE.BufferGeometry[]) => {
      const m = mergeGeometries(list, false)!;
      list.forEach((g) => g.dispose());
      return keep(m);
    };
    return { body: merge(body), dark: merge(dark), glass: merge(glass) };
  };

  /**
   * One half of one door: a kick panel, two stiles, a top rail and a pane.
   *
   * Full height on everything now, including the open-sided road vehicles —
   * a waist-high leaf on a tram read as a gate on a cattle truck, and the door
   * is the part of a vehicle a player looks straight at while deciding whether
   * they are going to make it.
   */
  const leafParts = (mode: ModeId) => {
    const b = BODIES[mode];
    const closed = mode === 'metro' || mode === 'train';
    // `h` on a road vehicle is measured above the deck, same as the roof it
    // has to reach; on a closed one the wall IS the inside height.
    const h = closed ? b.wall : b.h - 0.14;
    const w = b.doorWidth * 0.52;
    const frame: THREE.BufferGeometry[] = [];
    const pane: THREE.BufferGeometry[] = [];
    const box = (
      into: THREE.BufferGeometry[], bw: number, bh: number, bd: number,
      x: number, y: number, z: number,
    ) => {
      const g = new THREE.BoxGeometry(bw, bh, bd);
      g.translate(x, y, z);
      into.push(g);
    };
    const kick = Math.min(0.95, h * 0.38);
    const glazed = h - kick - 0.12;
    box(frame, w, kick, 0.1, 0, -h / 2 + kick / 2, 0);
    box(frame, w, 0.12, 0.1, 0, h / 2 - 0.06, 0);
    for (const e of [-1, 1]) box(frame, 0.09, glazed, 0.1, e * (w / 2 - 0.045), -h / 2 + kick + glazed / 2, 0);
    box(pane, w - 0.18, glazed - 0.04, 0.05, 0, -h / 2 + kick + glazed / 2, 0);
    const merge = (list: THREE.BufferGeometry[]) => {
      const m = mergeGeometries(list, false)!;
      list.forEach((g) => g.dispose());
      return keep(m);
    };
    return { frame: merge(frame), pane: merge(pane), h };
  };
  const leaves: Partial<Record<ModeId, ReturnType<typeof leafParts>>> = {};

  const shells: Partial<Record<ModeId, ReturnType<typeof parts>>> = {};
  const darkMat = keep(new THREE.MeshLambertMaterial({ color: 0x24282f }));

  for (const line of city.lines) {
    const b = BODIES[line.mode];
    if (!shells[line.mode]) shells[line.mode] = parts(line.mode);
    const shell = shells[line.mode]!;
    const boardTex = keep(makeSign(line.name, [], line.color));

    for (let run = 0; run < line.fleet; run++) {
      const g = new THREE.Group() as unknown as THREE.Mesh;
      g.add(new THREE.Mesh(shell.body, lineMats[line.id]));
      g.add(new THREE.Mesh(shell.dark, darkMat));
      g.add(new THREE.Mesh(shell.glass, glassMat));

      // the line number, on the front, where you read it from the platform
      const board = new THREE.Mesh(
        keep(new THREE.PlaneGeometry(b.w * 0.7, b.w * 0.7 * 0.31)),
        keep(new THREE.MeshBasicMaterial({ map: boardTex })),
      );
      board.position.set(b.l / 2 + 0.02, b.deck + b.wall * 0.78, 0);
      board.rotation.y = Math.PI / 2;
      g.add(board);

      if (!leaves[line.mode]) leaves[line.mode] = leafParts(line.mode);
      const lf = leaves[line.mode]!;
      const doors: THREE.Object3D[] = [];
      for (const d of b.doors) {
        for (const side of [-1, 1]) {
          // Bi-parting: two leaves that slide apart into the panels either side.
          for (const half of [-1, 1]) {
            const leaf = new THREE.Group();
            leaf.add(new THREE.Mesh(lf.frame, lineMats[line.id]));
            leaf.add(new THREE.Mesh(lf.pane, glassMat));
            // Outboard of the bodywork, so a leaf sliding open passes in front
            // of the panel it hides behind instead of fighting it for pixels.
            leaf.position.set(
              d * b.l + half * b.doorWidth * 0.26,
              b.deck + lf.h / 2,
              side * (b.w / 2 + 0.02),
            );
            leaf.userData.shut = leaf.position.x;
            leaf.userData.slide = half * b.doorWidth * 0.5;
            g.add(leaf);
            doors.push(leaf);
          }
        }
      }

      scene.add(g);
      const id = `${line.id}.${run}`;
      vehicleMeshes.set(id, g);
      doorLeaves.set(id, doors);
    }
  }

  // ── other players ────────────────────────────────────────────────────────
  const playerMeshes = new Map<string, THREE.Mesh>();
  const playerGeo = keep(new THREE.CapsuleGeometry(0.36, 1.0, 4, 8));

  return {
    scene,

    setViewer(x, y, z) {
      if (skyMesh) skyMesh.position.set(x, y, z);
    },

    updateVehicles(_city, vehicles) {
      for (const v of vehicles) {
        // The doors are a function of the clock, same as the position — no
        // easing here, or the picture would disagree with the rule about
        // whether you can get out, which is the one thing it must not do.
        const doors = doorLeaves.get(v.id);
        if (doors) {
          for (const leaf of doors) {
            leaf.position.x = leaf.userData.shut + leaf.userData.slide * v.door;
          }
        }
        const mesh = vehicleMeshes.get(v.id);
        if (!mesh) continue;
        // At its own level: a metro is in a tunnel, a train is on a viaduct.
        // This was pinned to zero and every metro in the city drove down the
        // middle of the road with the buses.
        mesh.position.set(v.x, v.level, v.y);
        mesh.rotation.y = -v.angle;
      }
    },

    updatePlayers(players, selfId) {
      const seen = new Set<string>();
      for (const p of players) {
        if (p.id === selfId) continue;
        seen.add(p.id);
        let mesh = playerMeshes.get(p.id);
        if (!mesh) {
          mesh = new THREE.Mesh(playerGeo, new THREE.MeshLambertMaterial({ color: p.color }));
          scene.add(mesh);
          playerMeshes.set(p.id, mesh);
        }
        mesh.position.set(p.x, p.h + 0.86, p.y);
        mesh.rotation.y = -(p.facing + Math.PI / 2);
      }
      for (const [id, mesh] of playerMeshes) {
        if (seen.has(id)) continue;
        scene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        playerMeshes.delete(id);
      }
    },

    dispose() {
      for (const x of junk) x.dispose();
      for (const mesh of playerMeshes.values()) (mesh.material as THREE.Material).dispose();
      scene.clear();
    },
  };
}
