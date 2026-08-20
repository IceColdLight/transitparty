/**
 * The client: connect, rebuild the city from the seed, draw it, and tell the
 * server which way you are trying to walk.
 *
 * Two things here are worth knowing before changing anything.
 *
 * The city is never received, it is REBUILT. The server sends a seed; this
 * builds the identical network from it. So switching rounds is one integer
 * over the wire.
 *
 * And vehicles are not interpolated, they are EVALUATED. Everything on rails
 * is a pure function of the clock, so it is drawn at the true present moment
 * at whatever framerate the machine manages, with no smoothing and no jitter.
 * A player riding one is drawn AT their vehicle rather than at the position
 * the last packet gave them — which is both exact and free, and is why a tram
 * full of racers moves as one solid object instead of a shivering cloud.
 */
import { ARRIVE_RADIUS, BOARD_RADIUS, INTERP_DELAY_MS, RACE } from '../shared/constants.js';
import { buildCity } from '../shared/city.js';
import { stepWalk, type Walker } from '../shared/movement.js';
import { allVehicles, departures, vehicleById } from '../shared/vehicles.js';
import type { City, PlayerState, Vehicle, WorldState } from '../shared/types.js';
import { connect } from './net.js';
import { mapHeld, readWalkWish, take } from './input.js';
import { drawWorld, type Camera } from './world.js';
import { drawMap } from './map.js';

const params = new URLSearchParams(location.search);
/**
 * The socket rides the same origin as the page, proxied by Vite to the game
 * server: one host and one port to share, and on an https tunnel it becomes
 * wss:// on its own, since a secure page refuses to open a plain ws://.
 */
const serverUrl = params.get('server')
  ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const interpDelay = (Number(params.get('delay')) || INTERP_DELAY_MS) / 1000;

const canvas = document.createElement('canvas');
document.body.insertBefore(canvas, document.body.firstChild);
const ctx = canvas.getContext('2d')!;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const odFrom = el('od-from'), odTo = el('od-to'), clockEl = el('clock'), parEl = el('par');
const sWhat = el('s-what'), sNext = el('s-next'), sTogo = el('s-togo');
const standingsEl = el('standings'), boardEl = el('board'), promptEl = el('prompt');
const netEl = el('status-net'), nameEl = el<HTMLInputElement>('name');
const resultsEl = el('results'), rTitle = el('r-title'), rSub = el('r-sub');
const rRows = el('r-rows'), rNext = el('r-next');
const mapHintEl = el('maphint');

/**
 * HUD panels that get out of the way while the map is up. The legend lives in
 * the map's top-left corner and the status panel sat directly on top of it,
 * which meant the one thing explaining what a coloured line MEANT was the one
 * thing you could not see.
 *
 * Deliberately not everything: the race header (where you are going), the
 * departure board (what is leaving from under your feet) and the standings are
 * exactly what you want while planning, and all three sit clear of the legend.
 */
const dimUnderMap = [el('status'), el('hint'), nameEl];

let selfId = '';
let city: City | null = null;
let citySeed = -1;

/** Two most recent states, for interpolating everybody else. */
let prev: WorldState | null = null;
let curr: WorldState | null = null;
let simTime = 0;

/** Local prediction of your own walking, corrected softly toward the server. */
const me: Walker = { x: 0, y: 0, vx: 0, vy: 0 };
let mePrimed = false;

const cam: Camera = { x: 0, y: 0, scale: 1.6 };
let mapAlpha = 0;

const net = connect(serverUrl, {
  onWelcome(id) { selfId = id; },
  onStatus(s) { netEl.textContent = s; },
  onState(msg) {
    prev = curr;
    curr = msg.state;
    if (msg.state.round.seed !== citySeed) {
      citySeed = msg.state.round.seed;
      city = buildCity(citySeed);
      mePrimed = false;
      prev = null;
    }
    const d = msg.state.time - simTime;
    if (Math.abs(d) > 0.35) simTime = msg.state.time; else simTime += d * 0.12;
  },
});

nameEl.addEventListener('change', () => {
  if (nameEl.value.trim()) net.send({ type: 'name', name: nameEl.value.trim() });
});

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Everybody else, interpolated; riders snapped onto their vehicle. */
function playersAt(t: number, vehicleOf: (id: string) => Vehicle | null): PlayerState[] {
  if (!curr) return [];
  const out: PlayerState[] = [];
  for (const c of curr.players) {
    const p: PlayerState = { ...c };
    if (p.riding) {
      const v = vehicleOf(p.riding);
      if (v) { p.x = v.x; p.y = v.y; }
    } else if (prev) {
      const a = prev.players.find((q) => q.id === p.id);
      const span = curr.time - prev.time;
      if (a && span > 1e-6) {
        const u = Math.max(0, Math.min(1, (t - prev.time) / span));
        p.x = a.x + (p.x - a.x) * u;
        p.y = a.y + (p.y - a.y) * u;
      }
    }
    out.push(p);
  }
  return out;
}

/** The departure board is expensive to build and changes once a second. */
let depCache: { stop: number; at: number; rows: ReturnType<typeof departures> } | null = null;
function departuresFor(c: City, stop: number, t: number) {
  if (depCache && depCache.stop === stop && t - depCache.at < 0.4) return depCache.rows;
  const rows = departures(c, stop, t, 420);
  depCache = { stop, at: t, rows };
  return rows;
}

let lastFrame = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  simTime += dt;

  const view = { w: innerWidth, h: innerHeight };
  if (!city || !curr) {
    ctx.fillStyle = '#0c1016';
    ctx.fillRect(0, 0, view.w, view.h);
    return;
  }
  const c = city;
  const racing = curr.round.phase === 'racing';

  // ── your own position ───────────────────────────────────────────────────
  const server = curr.players.find((p) => p.id === selfId) ?? null;
  const myVehicle = server?.riding ? vehicleById(c, server.riding, simTime) : null;

  if (server && !mePrimed) { me.x = server.x; me.y = server.y; me.vx = 0; me.vy = 0; mePrimed = true; }

  const wish = racing && !myVehicle && server?.finished === null ? readWalkWish() : { x: 0, y: 0 };
  if (myVehicle) {
    me.x = myVehicle.x; me.y = myVehicle.y; me.vx = 0; me.vy = 0;
  } else if (server) {
    stepWalk(me, wish.x, wish.y, dt, c.river);
    // Soft reconciliation. The walk is cheap and deterministic, so the two
    // only ever differ by a packet's worth of lag; yanking would be visible
    // and drifting would not.
    me.x += (server.x - me.x) * Math.min(1, dt * 6);
    me.y += (server.y - me.y) * Math.min(1, dt * 6);
  }

  net.send({ type: 'walk', seq: 0, wx: wish.x, wy: wish.y, facing: Math.atan2(wish.y, wish.x) });
  if (take('interact')) net.send({ type: 'action', action: 'interact' });
  if (take('reset')) net.send({ type: 'action', action: 'reset' });

  // ── camera: pulled back while riding, because you are covering ground ────
  const wantScale = myVehicle ? 0.85 : 1.6;
  cam.scale += (wantScale - cam.scale) * Math.min(1, dt * 2.4);
  cam.x += (me.x - cam.x) * Math.min(1, dt * 9);
  cam.y += (me.y - cam.y) * Math.min(1, dt * 9);

  // ── the world ───────────────────────────────────────────────────────────
  const vehicles = allVehicles(c, simTime);
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const people = playersAt(simTime - interpDelay, (id) => byId.get(id) ?? null);
  const mine = people.find((p) => p.id === selfId);
  if (mine) { mine.x = me.x; mine.y = me.y; }

  drawWorld(ctx, c, cam, view, vehicles, people, selfId, simTime);

  const wantMap = mapHeld() ? 1 : 0;
  mapAlpha += (wantMap - mapAlpha) * Math.min(1, dt * 14);
  drawMap(ctx, c, view, vehicles, people, selfId, mapAlpha);
  mapHintEl.style.opacity = mapAlpha > 0.05 ? '0' : '1';
  for (const panel of dimUnderMap) panel.style.opacity = String(1 - mapAlpha);

  // ── HUD ─────────────────────────────────────────────────────────────────
  const origin = c.stops[c.origin], dest = c.stops[c.destination];
  odFrom.textContent = origin.name;
  odTo.textContent = dest.name;
  clockEl.textContent = fmt(racing ? curr.round.elapsed : 0);
  parEl.textContent = `par ${fmt(c.par.time)} · ${c.par.transfers} changes · walking it: ${fmt(c.par.walk)}`;

  // nearest stop to you, which is what the departure board is about
  let near = -1, nearD = Infinity;
  for (const s of c.stops) {
    const d = Math.hypot(s.x - me.x, s.y - me.y);
    if (d < nearD) { nearD = d; near = s.id; }
  }
  const atStop = nearD < 46 ? near : -1;

  const boardable = !myVehicle && vehicles.find(
    (v) => v.atStop >= 0 && Math.hypot(v.x - me.x, v.y - me.y) <= BOARD_RADIUS,
  );

  if (myVehicle) {
    const line = c.lines[myVehicle.line];
    sWhat.innerHTML = `aboard <span style="color:${line.color}">${line.name}</span>`;
    sNext.textContent = myVehicle.atStop >= 0
      ? `${c.stops[myVehicle.nextStop].name} — doors open ${myVehicle.doorTime.toFixed(0)}s`
      : `${c.stops[myVehicle.nextStop].name} in ${myVehicle.eta.toFixed(0)}s`;
  } else {
    sWhat.textContent = wish.x || wish.y ? 'walking' : 'standing';
    sNext.textContent = near >= 0 ? `${c.stops[near].name} · ${Math.round(nearD)}m` : '—';
  }
  const togo = Math.hypot(dest.x - me.x, dest.y - me.y);
  sTogo.textContent = `${Math.round(togo)}m · ${dest.name}`;

  // ── the prompt: one line, one key ───────────────────────────────────────
  if (!racing) promptEl.innerHTML = '';
  else if (server?.finished !== null && server) {
    promptEl.innerHTML = `<span style="color:#7fe08a">finished ${server.place}. in ${fmt(server.finished!)}</span>`;
  } else if (myVehicle && myVehicle.atStop >= 0) {
    promptEl.innerHTML = `<kbd>E</kbd> get off at <b>${c.stops[myVehicle.atStop].name}</b>` +
      ` <span style="color:#ffd166">${myVehicle.doorTime.toFixed(0)}s</span>`;
  } else if (myVehicle) {
    promptEl.innerHTML = `<span style="opacity:0.75">next stop ${c.stops[myVehicle.nextStop].name}` +
      ` in ${myVehicle.eta.toFixed(0)}s</span>`;
  } else if (boardable) {
    const line = c.lines[boardable.line];
    promptEl.innerHTML = `<kbd>E</kbd> board <span style="color:${line.color}">${line.name}</span>` +
      ` towards <b>${c.stops[boardable.nextStop].name}</b>`;
  } else if (togo < ARRIVE_RADIUS * 3) {
    promptEl.innerHTML = `<span style="color:#ffd166">walk to ${dest.name}</span>`;
  } else promptEl.innerHTML = '';

  // ── the departure board ─────────────────────────────────────────────────
  if (atStop >= 0 && !myVehicle && racing) {
    const stop = c.stops[atStop];
    const rows = departuresFor(c, atStop, simTime).slice(0, 6);
    boardEl.style.display = 'block';
    boardEl.innerHTML = `<div class="hd">departures · <b>${stop.name}</b></div>` +
      (rows.length ? rows.map((d) => {
        const line = c.lines[d.line];
        const secs = Math.max(0, Math.round(d.in));
        const cls = secs === 0 ? 'now' : secs < 20 ? 'soon' : '';
        return `<div class="dep">` +
          `<span class="badge" style="background:${line.color}">${line.name}</span>` +
          `<span class="dest">${c.stops[d.towards].name}</span>` +
          `<span class="in ${cls}">${secs === 0 ? 'HERE' : `${secs}s`}</span></div>`;
      }).join('') : '<div class="dep"><span class="dest">nothing calls here</span></div>');
  } else boardEl.style.display = 'none';

  // ── standings ───────────────────────────────────────────────────────────
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

  // ── between rounds ──────────────────────────────────────────────────────
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
