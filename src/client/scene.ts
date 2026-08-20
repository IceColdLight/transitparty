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
import { platformAt } from '../shared/streets.js';
import { VIADUCT_CLEARANCE, footprintsOf, hash2, viaductLegs } from '../shared/plots.js';
import type { City, PlayerState, Vehicle } from '../shared/types.js';

const SKY = 0x9fb3c8;
/** You can see to the end of the street. That is the point. */
export const FOG_NEAR = 60;
export const FOG_FAR = 340;

/**
 * Painting a station sign, given a 2D context to paint it on. The context is
 * passed in rather than fetched so the same code can run against a browser
 * canvas and against a server-side one — which is what lets tools/shots.ts
 * render the city to a PNG with no browser anywhere.
 */
export function paintSign(g: CanvasRenderingContext2D, text: string, sub: string[], color: string) {
  g.fillStyle = '#10151c';
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

function browserSign(text: string, sub: string[], color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = SIGN_W; c.height = SIGN_H;
  paintSign(c.getContext('2d')!, text, sub, color);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export type Scene3D = {
  scene: THREE.Scene;
  /** call each frame with the current fleet */
  updateVehicles(city: City, vehicles: Vehicle[]): void;
  updatePlayers(players: PlayerState[], selfId: string): void;
  dispose(): void;
};

/** Swappable so a headless renderer can supply textures without a DOM. */
export type SceneOpts = { sign?: (text: string, sub: string[], color: string) => THREE.Texture };

export function buildScene(city: City, opts: SceneOpts = {}): Scene3D {
  const makeSign = opts.sign ?? browserSign;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

  scene.add(new THREE.HemisphereLight(0xdce8f5, 0x2a3038, 2.1));
  const sun = new THREE.DirectionalLight(0xffe9cf, 1.5);
  sun.position.set(-0.5, 1, 0.35);
  scene.add(sun);

  const junk: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T) => {
    junk.push(x); return x;
  };

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
    const pad = 0.6;
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

  const buildingGeo = keep(new THREE.BoxGeometry(1, 1, 1));
  // NOT vertexColors: an InstancedMesh carries its own `instanceColor`, and
  // asking the shader for a per-vertex colour attribute that the geometry does
  // not have paints every building pure black.
  const buildingMat = keep(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, boxes.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  boxes.forEach((b, i) => {
    m.makeScale(b.w, b.h, b.d);
    m.setPosition(b.x, b.h / 2, b.y);
    buildings.setMatrixAt(i, m);
    // A wider spread than looks sensible on paper. Narrow it and a street
    // canyon becomes one continuous grey wall with no depth to it at all.
    const warm = hash2(b.y, b.x);
    col.setHSL(0.07 + warm * 0.56, 0.05 + b.tone * 0.16, 0.34 + warm * 0.30);
    buildings.setColorAt(i, col);
  });
  buildings.instanceMatrix.needsUpdate = true;
  if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
  scene.add(buildings);

  /**
   * Parks get a hedge round them, and the railway gets a fence.
   *
   * Both are land you can see and cannot walk on, and without something at the
   * edge that is indistinguishable from an invisible wall. Walking stays
   * confined to the streets — that is the whole basis of the pedestrian graph
   * the route planner shares — so the answer is not to open them but to make
   * it obvious they are shut.
   */
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

  // A fence either side of the viaduct's land, for the same reason.
  {
    const posts: THREE.BufferGeometry[] = [];
    for (const seg of railSegs) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      const ang = Math.atan2(dy, dx);
      for (const side of [-1, 1]) {
        const g = new THREE.BoxGeometry(len, 1.3, 0.5);
        g.translate(0, 0.65, side * CLEARANCE);
        g.rotateY(-ang);
        g.translate((seg.ax + seg.bx) / 2, 0, (seg.ay + seg.by) / 2);
        posts.push(g);
      }
    }
    if (posts.length) {
      const g = mergeGeometries(posts, false)!;
      posts.forEach((x) => x.dispose());
      scene.add(new THREE.Mesh(keep(g), keep(new THREE.MeshLambertMaterial({ color: 0x4d4437 }))));
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
    for (const x of city.streets.xs) {
      for (let z = 40; z < CITY.height - 40; z += GAP) put(x, z, 'z');
    }
    for (const y of city.streets.ys) {
      for (let x = 40; x < CITY.width - 40; x += GAP) put(x, y, 'x');
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

  // ── the river: a ribbon along the channel, sunk below street level ───────
  {
    const half = 48;
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
    const water = new THREE.Mesh(geo, keep(new THREE.MeshLambertMaterial({
      color: 0x244f6e, transparent: true, opacity: 0.94,
    })));
    water.position.y = -1.4;
    scene.add(water);
  }

  // ── bridges, and the quay walls that stop you walking into the water ─────
  const stoneMat = keep(new THREE.MeshLambertMaterial({ color: 0x565c66 }));
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
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(
      onVertical ? short : long, PLATFORM.height, onVertical ? long : short,
    )), padMat);
    mesh.position.set(pad.x, PLATFORM.height / 2, pad.y);
    scene.add(mesh);

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
          for (let d = -len / 2 + 8; d < len / 2; d += 34) {
            const g = new THREE.BoxGeometry(2.2, level, 2.2);
            g.translate(d, level / 2 - 1.2, 0);
            g.rotateY(-ang);
            g.translate(mx, 0, my);
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
    for (const side of [-1, 1]) {
      const off = side * (trackHalf + platHalf);
      const m = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.hall.hl * 2, 0.5, platHalf * 2)), floorMat,
      );
      m.position.set(
        st.hall.x + Math.sin(-st.hall.angle) * off,
        st.level - 0.25,
        st.hall.y + Math.cos(-st.hall.angle) * off,
      );
      m.rotation.y = -st.hall.angle;
      scene.add(m);
    }
    put(new THREE.Mesh(
      keep(new THREE.BoxGeometry(st.hall.hl * 2, 0.4, trackHalf * 2)), trackBed,
    ), st.hall, st.level - deck - 0.2);

    // side walls and a ceiling, so a tunnel station feels like a room
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.hall.hl * 2, 5.2, 0.5)), wallMat,
      );
      w.position.set(
        st.hall.x + Math.sin(-st.hall.angle) * side * st.hall.hw,
        st.level + 2.6,
        st.hall.y + Math.cos(-st.hall.angle) * side * st.hall.hw,
      );
      w.rotation.y = -st.hall.angle;
      scene.add(w);
    }
    if (st.mode === 'metro') {
      put(new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.hall.hl * 2, 0.4, st.hall.hw * 2)), wallMat,
      ), st.hall, st.level + 5.2);
    }

    /**
     * The stairs. Drawn as actual steps rather than a slope — a ramp reads as
     * a car park, and the thing a player has to spot from the street is a
     * staircase. The walkable surface underneath is the ramp; the steps sit on
     * it, which is close enough at this size that nobody will catch it out.
     */
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const lx = -st.shaft.hl + t * st.shaft.hl * 2;
      const at = {
        x: st.shaft.x + Math.cos(st.shaft.angle) * lx,
        y: st.shaft.y + Math.sin(st.shaft.angle) * lx,
      };
      const g = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.shaft.hl * 2 / steps, 0.5, st.shaft.hw * 2)), floorMat,
      );
      g.position.set(at.x, st.level * t - 0.25, at.y);
      g.rotation.y = -st.shaft.angle;
      scene.add(g);
      // Walls down both sides, because the stairwell has them: you go in at
      // the top and come out at the bottom, not over the side halfway down.
      for (const side of [-1, 1]) {
        const w = new THREE.Mesh(
          keep(new THREE.BoxGeometry(st.shaft.hl * 2 / steps, 1.1, 0.3)), wallMat,
        );
        w.position.set(
          at.x + Math.sin(-st.shaft.angle) * side * st.shaft.hw,
          st.level * t + 0.55,
          at.y + Math.cos(-st.shaft.angle) * side * st.shaft.hw,
        );
        w.rotation.y = -st.shaft.angle;
        scene.add(w);
      }
    }

    // the passage from the foot of the stairs in to the platform
    {
      const pw = new THREE.Mesh(
        keep(new THREE.BoxGeometry(st.passage.hl * 2, 0.4, st.passage.hw * 2)), floorMat,
      );
      pw.position.set(st.passage.x, st.level - 0.2, st.passage.y);
      pw.rotation.y = -st.passage.angle;
      scene.add(pw);
      if (st.mode === 'metro') {
        const roof = new THREE.Mesh(
          keep(new THREE.BoxGeometry(st.passage.hl * 2, 0.35, st.passage.hw * 2)), wallMat,
        );
        roof.position.set(st.passage.x, st.level + 3.2, st.passage.y);
        roof.rotation.y = -st.passage.angle;
        scene.add(roof);
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
  const lineMats = city.lines.map((l) => keep(new THREE.MeshLambertMaterial({ color: l.color })));
  const glassMat = keep(new THREE.MeshLambertMaterial({ color: 0x16202b }));
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
    const doorH = closed ? 2.1 : b.wall;  // a doorway you walk through

    // floor
    box(dark, b.l, b.deck, b.w, 0, b.deck / 2, 0);

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
        // glazing, on the outside of the panel
        const gy = b.deck + (closed ? 1.5 : 0.72);
        const gh = closed ? 1.0 : 0.34;
        if (pn.len > 1) box(glass, pn.len - 0.5, gh, T * 0.6, pn.c, gy, z + side * T * 0.5);
      }
      // lintels over the doors, so a doorway is a door and not a slot to the roof
      if (closed) {
        for (const d of b.doors) {
          box(body, b.doorWidth, b.wall - doorH, T, d * b.l, b.deck + doorH + (b.wall - doorH) / 2, z);
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

    // running gear, under the floor
    const axles = mode === 'bus' ? [-0.32, 0.34] : [-0.34, 0.34];
    for (const a of axles) {
      for (const side of [-1, 1]) {
        const wheel = new THREE.CylinderGeometry(b.deck * 0.62, b.deck * 0.62, 0.34, 8);
        wheel.rotateX(Math.PI / 2);
        wheel.translate(a * b.l, b.deck * 0.55, side * (b.w / 2 - 0.24));
        dark.push(wheel);
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
    if (mode === 'bus') {
      // a windscreen, so the front end reads as the front end
      box(glass, 0.1, b.h - b.wall - 0.4, b.w * 0.88, b.l / 2 - 0.2, b.deck + b.wall + 0.6, 0);
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

      scene.add(g);
      vehicleMeshes.set(`${line.id}.${run}`, g);
    }
  }

  // ── other players ────────────────────────────────────────────────────────
  const playerMeshes = new Map<string, THREE.Mesh>();
  const playerGeo = keep(new THREE.CapsuleGeometry(0.36, 1.0, 4, 8));

  return {
    scene,

    updateVehicles(_city, vehicles) {
      for (const v of vehicles) {
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
