/**
 * The client: connect, rebuild the city from the seed, stand in it.
 *
 * Three things are worth knowing before changing anything.
 *
 * The city is never received, it is REBUILT. The server sends a seed; this
 * builds the identical network from it, geometry and timetable and all. So
 * switching to a whole new city is one integer over the wire.
 *
 * Vehicles are not interpolated, they are EVALUATED. Everything on rails is a
 * pure function of the clock, so it is drawn at the true present moment at
 * whatever framerate the machine manages, with no smoothing and no jitter.
 *
 * And there is no board key. A vehicle is a moving platform and riding one is
 * standing on it, which means the client predicts the same physics the server
 * decides — see shared/movement.ts.
 */
import * as THREE from 'three';
import { INTERP_DELAY_MS, PLAYER, RACE, STAMINA } from '../shared/constants.js';
import { buildCity } from '../shared/city.js';
import { type Body, newBody, stepBody } from '../shared/movement.js';
import { allVehicles, toLocal, toWorld, vehicleById } from '../shared/vehicles.js';
import type { City, PlayerState, WorldState } from '../shared/types.js';
import { connect } from './net.js';
import { type MapView, drawMap } from './map.js';
import { type Scene3D, buildScene } from './scene.js';

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server')
  ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const interpDelay = (Number(params.get('delay')) || INTERP_DELAY_MS) / 1000;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const odFrom = el('od-from'), odTo = el('od-to'), clockEl = el('clock'), parEl = el('par');
const standingsEl = el('standings'), promptEl = el('prompt');
const netEl = el('status-net');
const nameEl = el<HTMLInputElement>('name');
const joinEl = el<HTMLFormElement>('join');
const staminaEl = el('stamina'), stamFill = el<HTMLDivElement>('stam-fill');
const stamLabel = el('stam-label');
const resultsEl = el('results'), rTitle = el('r-title'), rSub = el('r-sub');
const rRows = el('r-rows'), rNext = el('r-next');
const lockEl = el('lock'), crosshairEl = el('crosshair'), mapHintEl = el('maphint');

// ── renderer ──────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
document.body.insertBefore(renderer.domElement, document.body.firstChild);
/** Far enough that the destination beam is visible from across the city. */
const camera = new THREE.PerspectiveCamera(76, 1, 0.1, 4200);
camera.rotation.order = 'YXZ';

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ── the map you carry ─────────────────────────────────────────────────────
/**
 * A physical object, not an overlay: a folded card you hold up in front of
 * your face while TAB is down and put away when you let go. Holding it costs
 * you most of your view of the street, which is the right price for knowing
 * where the lines go — and it is the reason the network can be hidden from the
 * world at all.
 */
const MAP_W = 1024, MAP_H = 704, MAP_PAD = 30;
const mapCanvas = document.createElement('canvas');
mapCanvas.width = MAP_W; mapCanvas.height = MAP_H;
const mapCtx = mapCanvas.getContext('2d')!;
const mapTex = new THREE.CanvasTexture(mapCanvas);
mapTex.anisotropy = 4;
const heldMap = new THREE.Mesh(
  new THREE.PlaneGeometry(0.62, 0.62 * (MAP_H / MAP_W)),
  new THREE.MeshBasicMaterial({ map: mapTex, transparent: true, fog: false }),
);
heldMap.position.set(0.02, -0.9, -0.52);
heldMap.rotation.set(-0.18, 0, 0.02);
heldMap.renderOrder = 10;
(heldMap.material as THREE.Material).depthTest = false;
camera.add(heldMap);

/**
 * Where the map is scrolled to, kept between openings.
 *
 * A player who has zoomed into the quarter they are working in should find it
 * still there next time they take the map out — putting it away and getting it
 * back should not undo their reading.
 */
const mapAt: MapView = { zoom: 1, panX: 0, panY: 0 };
let mapDrawnAt = -1;
function refreshMap(city: City, vehicles: ReturnType<typeof allVehicles>, players: PlayerState[]) {
  // Card stock, then the diagram printed on it.
  mapCtx.fillStyle = '#cfc7b4';
  mapCtx.fillRect(0, 0, MAP_W, MAP_H);
  mapCtx.fillStyle = '#b8b0a0';
  mapCtx.fillRect(MAP_W / 2 - 1, 0, 2, MAP_H);
  mapCtx.save();
  mapCtx.translate(MAP_PAD, MAP_PAD);
  drawMap(mapCtx, city, { w: MAP_W - MAP_PAD * 2, h: MAP_H - MAP_PAD * 2 },
    vehicles, players, selfId, 1, mapAt);
  mapCtx.restore();
  mapTex.needsUpdate = true;
}

// ── input ─────────────────────────────────────────────────────────────────
const keys = new Set<string>();
let facing = 0, pitch = 0;
let locked = false;

const typing = () => document.activeElement?.tagName === 'INPUT';
addEventListener('keydown', (e) => {
  if (typing()) {
    if (e.key === 'Enter' || e.key === 'Escape') (document.activeElement as HTMLElement).blur();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'tab' || k === ' ') e.preventDefault();
  keys.add(k);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  lockEl.style.display = locked ? 'none' : 'flex';
  crosshairEl.style.opacity = locked ? '1' : '0';
  if (!locked) keys.clear();
});
addEventListener('mousemove', (e) => {
  if (!locked) return;
  /**
   * With the map up the mouse reads the MAP, not the street: it pans the sheet
   * instead of turning your head. You are looking at a piece of paper held in
   * front of your face — being able to look around it as well would make the
   * thing weightless, and the whole reason holding it costs you is that it
   * takes your attention.
   */
  if (keys.has('tab')) {
    mapAt.panX += e.movementX * 1.1;
    mapAt.panY += e.movementY * 1.1;
    const room = 520 * mapAt.zoom;
    mapAt.panX = Math.max(-room, Math.min(room, mapAt.panX));
    mapAt.panY = Math.max(-room, Math.min(room, mapAt.panY));
    mapDrawnAt = -1;
    return;
  }
  const sens = 0.0022;
  facing += e.movementX * sens;
  pitch -= e.movementY * sens;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
});

addEventListener('wheel', (e) => {
  if (!locked || !keys.has('tab')) return;
  e.preventDefault();
  const before = mapAt.zoom;
  mapAt.zoom = Math.max(1, Math.min(5, mapAt.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  // Keep whatever was in the middle of the sheet in the middle of the sheet.
  const r = mapAt.zoom / before;
  mapAt.panX *= r;
  mapAt.panY *= r;
  mapDrawnAt = -1;
}, { passive: false });

/**
 * The click has to be caught on the OVERLAY, not on the canvas.
 *
 * `#lock` is a fixed, full-screen panel at z-index 30 — it covers the canvas
 * completely, so a listener on the canvas never sees the click that is
 * supposed to start the game and the "click to play" card just sat there.
 *
 * The rejection is swallowed on purpose: a browser refuses a fresh lock for a
 * second or so after the user pressed Escape, and an unhandled rejection every
 * time somebody taps Escape twice is noise.
 */
function grabMouse() {
  const r = renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
  if (r && typeof r.catch === 'function') r.catch(() => {});
}
/**
 * Starting the game is one gesture: name, then mouse. Clicking the card
 * anywhere works, except on the name box itself — typing your name should not
 * swallow the cursor.
 */
joinEl.addEventListener('submit', (e) => { e.preventDefault(); submitName(); grabMouse(); });
lockEl.addEventListener('click', (e) => {
  if (e.target === nameEl) return;
  submitName();
  grabMouse();
});
renderer.domElement.addEventListener('click', grabMouse);

const held = (...names: string[]) => names.some((n) => keys.has(n));

/** WASD is relative to where you are looking, which is the whole point of a head. */
function walkWish() {
  let f = 0, r = 0;
  if (held('w', 'arrowup')) f += 1;
  if (held('s', 'arrowdown')) f -= 1;
  if (held('d', 'arrowright')) r += 1;
  if (held('a', 'arrowleft')) r -= 1;
  if (!f && !r) return { x: 0, y: 0 };
  const fx = Math.cos(facing), fy = Math.sin(facing);
  const x = fx * f - fy * r, y = fy * f + fx * r;
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

// ── state ─────────────────────────────────────────────────────────────────
let selfId = '';
let city: City | null = null;
let citySeed = -1;
let scene3d: Scene3D | null = null;
let prev: WorldState | null = null;
let curr: WorldState | null = null;
let simTime = 0;
/** How fast the local clock runs relative to real time while it catches up. */
let timeRate = 1;
const me: Body = newBody(0, 0);
let mePrimed = false;

const net = connect(serverUrl, {
  onWelcome(id) { selfId = id; },
  onStatus(s) { netEl.textContent = s; },
  onState(msg) {
    prev = curr;
    curr = msg.state;
    if (msg.state.round.seed !== citySeed) {
      citySeed = msg.state.round.seed;
      city = buildCity(citySeed);
      scene3d?.dispose();
      scene3d = buildScene(city);
      scene3d.scene.add(camera);
      mePrimed = false;
      prev = null;
      mapDrawnAt = -1;
    }
    /**
     * Nudge the CLOCK RATE, not the clock.
     *
     * Adding a fraction of the error straight onto the clock made it wobble:
     * the server's time advances in fixed steps and arrives twice per three
     * of them, so the error alternates, and everything on rails is a pure
     * function of that clock — a wobbling clock is a wobbling city. Steering
     * the rate keeps time monotone and smooth, and a big enough error is
     * still a snap, because that is a dropped connection rather than drift.
     */
    const d = msg.state.time - simTime;
    if (Math.abs(d) > 0.4) { simTime = msg.state.time; timeRate = 1; }
    else timeRate = 1 + Math.max(-0.12, Math.min(0.12, d * 0.8));
  },
});

/**
 * The name is asked for on the way in, on the same card that takes the mouse.
 * It used to be a loose box in the corner of the HUD, which nobody filled in
 * because nothing ever asked them to.
 */
const NAME_KEY = 'transitparty.name';
try { nameEl.value = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* private mode */ }
function submitName() {
  const n = nameEl.value.trim();
  if (!n) return;
  net.send({ type: 'name', name: n });
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function othersAt(t: number, at: number): PlayerState[] {
  if (!curr) return [];
  const c0 = city;
  return curr.players.map((q) => {
    const p: PlayerState = { ...q };
    if (!prev) return p;
    const a = prev.players.find((z) => z.id === p.id);
    const span = curr!.time - prev.time;
    if (!a || span <= 1e-6) return p;
    const u = Math.max(0, Math.min(1, (t - prev.time) / span));
    p.h = a.h + (p.h - a.h) * u;

    /**
     * A passenger is interpolated ON THE DECK, not across the ground.
     *
     * Blending two world positions taken half a packet apart on a vehicle
     * doing thirty metres a second slides them along the floor and leaves them
     * trailing wherever it has got to since. Interpolating where they STAND
     * and then putting that back on the vehicle at the moment being drawn
     * makes a full carriage move as one solid object again.
     */
    if (c0 && p.riding && a.riding === p.riding) {
      const was = vehicleById(c0, p.riding, prev.time);
      const now = vehicleById(c0, p.riding, curr!.time);
      const here = vehicleById(c0, p.riding, at);
      if (was && now && here) {
        const la = toLocal(was, a.x, a.y);
        const lb = toLocal(now, q.x, q.y);
        const w = toWorld(here, la.lx + (lb.lx - la.lx) * u, la.ly + (lb.ly - la.ly) * u);
        p.x = w.x; p.y = w.y;
        return p;
      }
    }
    p.x = a.x + (p.x - a.x) * u;
    p.y = a.y + (p.y - a.y) * u;
    return p;
  });
}

let lastFrame = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  simTime += dt * timeRate;

  if (!city || !curr || !scene3d) return;
  const c = city;
  const racing = curr.round.phase === 'racing';

  const server = curr.players.find((p) => p.id === selfId) ?? null;
  if (server && !mePrimed) {
    me.x = server.x; me.y = server.y; me.h = server.h;
    me.riding = server.riding; mePrimed = true;
  }

  const vehicles = allVehicles(c, simTime);

  /**
   * Standing on something that turns turns you with it. Without this the tram
   * rotates under your feet and your head does not, so a right-hand bend
   * leaves you facing the wall you just came past.
   */
  if (me.riding) {
    const was = vehicleById(c, me.riding, simTime - dt);
    const now = vehicleById(c, me.riding, simTime);
    if (was && now) {
      let spin = now.angle - was.angle;
      while (spin > Math.PI) spin -= Math.PI * 2;
      while (spin < -Math.PI) spin += Math.PI * 2;
      facing += spin;
    }
  }

  // ── predict your own body, then defer to the server ─────────────────────
  const canMove = locked && racing && server?.finished === null;
  const wish = canMove ? walkWish() : { x: 0, y: 0 };
  const sprint = canMove && held('shift');
  const jump = canMove && held(' ');
  stepBody(me, { wx: wish.x, wy: wish.y, sprint, jump }, dt, {
    streets: c.streets, river: c.river, transit: { city: c, vehicles, time: simTime },
  });

  if (server) {
    // Stamina is the server's number, always: a predicted resource lets a
    // laggy client sprint further than everybody else.
    me.stamina = server.stamina;
    // Agreeing about what you are standing on matters more than agreeing
    // about where you are. While it holds, ease toward the server; when it
    // breaks, the prediction is about a different surface and has to be
    // abandoned outright rather than blended into nonsense.
    const k = Math.min(1, dt * 5);
    if (server.riding !== me.riding) {
      me.x = server.x; me.y = server.y; me.h = server.h; me.riding = server.riding;
      me.vx = 0; me.vy = 0; me.vh = 0;
    } else if (me.riding) {
      /**
       * Aboard something, correct in the VEHICLE's frame, not the world's.
       *
       * The server reports where you were on its clock and the client predicts
       * where you are on its own, and the two clocks are never quite equal. In
       * world space the difference is mostly the vehicle's own travel — three
       * metres of it on a train at a tenth of a second — so a world-space
       * correction spends every frame dragging the player backwards along the
       * deck while the carry pushes them forwards. That fight is the jitter.
       *
       * Comparing where you stand ON THE DECK removes the vehicle's motion
       * from the question entirely: both ends agree you are two metres from
       * the door, whatever the clock says.
       */
      const atServer = vehicleById(c, me.riding, curr.time);
      const atClient = vehicleById(c, me.riding, simTime);
      if (atServer && atClient) {
        const want = toLocal(atServer, server.x, server.y);
        const have = toLocal(atClient, me.x, me.y);
        const w = toWorld(atClient,
          have.lx + (want.lx - have.lx) * k,
          have.ly + (want.ly - have.ly) * k);
        me.x = w.x; me.y = w.y;
      }
      me.h += (server.h - me.h) * k;
    } else {
      me.x += (server.x - me.x) * k;
      me.y += (server.y - me.y) * k;
      me.h += (server.h - me.h) * k;
    }
  }

  net.send({
    type: 'walk', seq: 0, wx: wish.x, wy: wish.y, facing,
    sprint, jump,
  });

  // ── camera ──────────────────────────────────────────────────────────────
  camera.position.set(me.x, me.h + PLAYER.eye, me.y);
  camera.rotation.set(pitch, -(facing + Math.PI / 2), 0);
  scene3d.setViewer(camera.position.x, camera.position.y, camera.position.z);

  const people = othersAt(simTime - interpDelay, simTime);
  scene3d.updateVehicles(c, vehicles);
  scene3d.updatePlayers(people, selfId);

  // ── the map in your hands ───────────────────────────────────────────────
  const wantMap = locked && keys.has('tab');

  /**
   * Zoom the map with + and -, held rather than tapped. The wheel does the
   * same thing, and not every mouse has one that works.
   */
  if (wantMap) {
    const zin = held('+', '='), zout = held('-', '_');
    if (zin !== zout) {
      const was = mapAt.zoom;
      const rate = 1 + dt * 1.9;
      mapAt.zoom = Math.max(1, Math.min(5, mapAt.zoom * (zin ? rate : 1 / rate)));
      const r = mapAt.zoom / was;
      mapAt.panX *= r;
      mapAt.panY *= r;
      mapDrawnAt = -1;
    }
  }
  const target = wantMap ? -0.17 : -0.92;
  heldMap.position.y += (target - heldMap.position.y) * Math.min(1, dt * 13);
  heldMap.visible = heldMap.position.y > -0.9;
  mapHintEl.style.opacity = wantMap || !locked ? '0' : '1';
  if (heldMap.visible && simTime - mapDrawnAt > 0.12) {
    refreshMap(c, vehicles, people);
    mapDrawnAt = simTime;
  }

  renderer.render(scene3d.scene, camera);

  // ── HUD ─────────────────────────────────────────────────────────────────
  const origin = c.stops[c.origin], dest = c.stops[c.destination];
  odFrom.textContent = origin.name;
  odTo.textContent = dest.name;
  clockEl.textContent = fmt(racing ? curr.round.elapsed : 0);
  parEl.textContent = `par ${fmt(c.par.time)} · ${c.par.transfers} changes`;

  const aboard = me.riding ? vehicleById(c, me.riding, simTime) : null;
  if (aboard) {
    // With the status panel gone, the one line at the bottom carries what you
    // are on as well as what it is about to do.
    const line = c.lines[aboard.line];
    const badge = `<span style="color:${line.color}">${line.name}</span>`;
    promptEl.innerHTML = aboard.atStop >= 0
      ? `${badge} at <b>${c.stops[aboard.atStop].name}</b> — doors ` +
        `<span style="color:#ffd166">${aboard.doorTime.toFixed(0)}s</span>`
      : `<span style="opacity:0.75">${badge} — next stop ` +
        `${c.stops[aboard.nextStop].name} in ${aboard.eta.toFixed(0)}s</span>`;
  } else {
    // Anything with its doors open, close enough to run for.
    const near = vehicles
      .filter((v) => v.atStop >= 0 && Math.hypot(v.x - me.x, v.y - me.y) < 26)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    if (server?.finished != null) {
      promptEl.innerHTML = `<span style="color:#7fe08a">finished ${server.place}. in ${fmt(server.finished)}</span>`;
    } else if (near) {
      const line = c.lines[near.line];
      promptEl.innerHTML = `<span style="color:${line.color}">${line.name}</span> to ` +
        `<b>${c.stops[near.nextStop].name}</b> — ` +
        `<span style="color:#ffd166">${near.doorTime.toFixed(0)}s</span>, step on`;
    } else promptEl.innerHTML = '';
  }

  const stam = server?.stamina ?? 1;
  staminaEl.style.opacity = racing ? '0.92' : '0.28';
  stamFill.style.width = `${(stam * 100).toFixed(1)}%`;
  const spent = stam < STAMINA.floor && !me.sprinting;
  stamFill.className = spent ? 'spent' : stam < 0.4 ? 'low' : '';
  stamLabel.textContent = spent ? 'winded' : me.sprinting ? 'running' : 'shift to run';

  const ranked = [...curr.players].sort((a, b) => {
    if (a.finished !== null && b.finished !== null) return a.finished - b.finished;
    if (a.finished !== null) return -1;
    if (b.finished !== null) return 1;
    return Math.hypot(a.x - dest.x, a.y - dest.y) - Math.hypot(b.x - dest.x, b.y - dest.y);
  });
  standingsEl.innerHTML = ranked.map((p, i) => {
    const d = Math.hypot(p.x - dest.x, p.y - dest.y);
    const tail = p.finished !== null ? fmt(p.finished) : `${(d / 1000).toFixed(2)}km`;
    return `<div class="row${p.id === selfId ? ' me' : ''}">` +
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="nm">${i + 1}. ${p.name}</span><span class="tm">${tail}</span></div>`;
  }).join('');

  if (!racing) {
    resultsEl.style.display = 'flex';
    const done = ranked.filter((p) => p.finished !== null);
    rTitle.textContent = done.length ? `${done[0].name} wins` : 'Nobody made it';
    rSub.textContent = `${origin.name} → ${dest.name} · par ${fmt(c.par.time)} with ${c.par.transfers} changes`;
    rRows.innerHTML = ranked.map((p, i) => `<div class="row">` +
      `<span class="pl">${p.finished !== null ? `${i + 1}.` : '—'}</span>` +
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="nm">${p.name}</span>` +
      `<span class="tm">${p.finished !== null ? fmt(p.finished) : 'DNF'}</span></div>`).join('');
    rNext.textContent = `next city in ${Math.max(0, Math.ceil(RACE.intermissionSeconds - curr.round.elapsed))}s`;
  } else resultsEl.style.display = 'none';
}
requestAnimationFrame(frame);
