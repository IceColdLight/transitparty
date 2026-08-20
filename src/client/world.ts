/**
 * The geographic view: the city as it actually is, drawn to scale, seen from
 * above and followed around by a camera.
 *
 * This is the half of the game the schematic lies about. Everything here is
 * true — the distance between two stops is the distance you have to walk, the
 * river is where the river is, and the tram you can see two blocks away is
 * genuinely going to be at that platform in eleven seconds.
 */
import { BOARD_RADIUS, MODES } from '../shared/constants.js';
import { nearestOnRiver } from '../shared/river.js';
import type { City, PlayerState, Vehicle } from '../shared/types.js';

export type Camera = { x: number; y: number; scale: number };

/** Vehicle body length in metres, by mode — a train reads as a train. */
const CAR = { train: 46, metro: 34, tram: 22, bus: 13 } as const;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A polyline through the stops, smoothed at the corners so it reads as track. */
function linePath(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  ctx.beginPath();
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  city: City,
  cam: Camera,
  view: { w: number; h: number },
  vehicles: Vehicle[],
  players: PlayerState[],
  selfId: string,
  t: number,
) {
  ctx.save();
  ctx.fillStyle = '#0e1218';
  ctx.fillRect(0, 0, view.w, view.h);

  ctx.translate(view.w / 2, view.h / 2);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-cam.x, -cam.y);

  // What is actually on screen, in world metres — everything below culls to it.
  const halfW = view.w / 2 / cam.scale, halfH = view.h / 2 / cam.scale;
  const x0 = cam.x - halfW, x1 = cam.x + halfW;
  const y0 = cam.y - halfH, y1 = cam.y + halfH;
  const onScreen = (x: number, y: number, pad = 0) =>
    x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad;

  // ── ground: blocks and parks, with the streets showing through as gaps ──
  for (const b of city.blocks) {
    if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
    ctx.fillStyle = b.park ? '#16281c' : '#171c24';
    roundRect(ctx, b.x, b.y, b.w, b.h, 5);
    ctx.fill();
  }

  // ── the river, and the only ways across it ──────────────────────────────
  ctx.strokeStyle = '#12314a';
  ctx.lineWidth = 96;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(city.river.poly[0].x, city.river.poly[0].y);
  for (const p of city.river.poly) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.strokeStyle = '#17415f';
  ctx.lineWidth = 74;
  ctx.stroke();

  for (const b of city.river.bridges) {
    if (!onScreen(b.x, b.y, 200)) continue;
    // Lay the deck across the water, not along it.
    const near = nearestOnRiver(city.river, { x: b.x + 1, y: b.y });
    const a = Math.atan2(b.y - near.y, b.x - near.x) + Math.PI / 2;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(a);
    ctx.fillStyle = '#2b3038';
    roundRect(ctx, -22, -108, 44, 216, 6);
    ctx.fill();
    ctx.fillStyle = '#3c434e';
    roundRect(ctx, -22, -108, 44, 10, 3); ctx.fill();
    roundRect(ctx, -22, 98, 44, 10, 3); ctx.fill();
    ctx.restore();
  }

  // ── the lines themselves, widest first so the thin ones stay visible ─────
  const order = ['train', 'metro', 'tram', 'bus'] as const;
  for (const mode of order) {
    for (const line of city.lines) {
      if (line.mode !== mode) continue;
      const pts = line.stops.map((s) => city.stops[s]);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = MODES[mode].width + 5;
      linePath(ctx, pts); ctx.stroke();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = MODES[mode].width;
      linePath(ctx, pts); ctx.stroke();
    }
  }

  // ── stops ───────────────────────────────────────────────────────────────
  const showNames = cam.scale > 0.55;
  for (const s of city.stops) {
    if (!onScreen(s.x, s.y, 60)) continue;
    const inter = s.lines.length > 1;
    const r = inter ? 13 : 8.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f2f6fa';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#0e1218';
    ctx.stroke();
    if (showNames && (inter || cam.scale > 0.95)) {
      ctx.font = `700 ${Math.round(13 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.9)';
      ctx.strokeText(s.name, s.x, s.y - r - 7);
      ctx.fillStyle = '#cbd7e2';
      ctx.fillText(s.name, s.x, s.y - r - 7);
    }
  }

  // ── where you are going ─────────────────────────────────────────────────
  const dest = city.stops[city.destination];
  const pulse = 1 + Math.sin(t * 3.2) * 0.12;
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(dest.x, dest.y, 30 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(dest.x, dest.y, 48 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ── vehicles ────────────────────────────────────────────────────────────
  for (const v of vehicles) {
    if (!onScreen(v.x, v.y, 90)) continue;
    const line = city.lines[v.line];
    const len = CAR[line.mode];
    const wid = line.mode === 'bus' ? 8 : 11;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.angle);
    if (v.atStop >= 0) {
      // Doors open. This halo is the single most important thing on screen:
      // it is the difference between a tram you can catch and one you cannot.
      ctx.globalAlpha = 0.30 + 0.16 * Math.sin(t * 7);
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, -len / 2 - 9, -wid / 2 - 9, len + 18, wid + 18, 10);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = line.color;
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 4);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.stroke();
    // A nose, so you can see which way it is about to go.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    roundRect(ctx, len / 2 - 5, -wid / 2 + 2, 4, wid - 4, 2);
    ctx.fill();
    ctx.restore();

    if (cam.scale > 0.5) {
      ctx.font = `800 ${Math.round(12 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.9)';
      ctx.strokeText(line.name, v.x, v.y - 14);
      ctx.fillStyle = line.color;
      ctx.fillText(line.name, v.x, v.y - 14);
    }
  }

  // ── players ─────────────────────────────────────────────────────────────
  for (const p of players) {
    if (!onScreen(p.x, p.y, 60)) continue;
    const me = p.id === selfId;
    // Riders sit exactly on the vehicle, so fan them out or a full carriage
    // looks like one passenger.
    let ox = 0, oy = 0;
    if (p.riding) {
      let h = 0;
      for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0;
      ox = ((h % 7) - 3) * 3.4;
      oy = (((h >> 3) % 5) - 2) * 3.4;
    }
    ctx.beginPath();
    ctx.arc(p.x + ox, p.y + oy, me ? 7.5 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineWidth = me ? 3.5 : 2.5;
    ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.7)';
    ctx.stroke();

    if (!me && cam.scale > 0.45) {
      ctx.font = `700 ${Math.round(11 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3.5 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.9)';
      ctx.strokeText(p.name, p.x + ox, p.y + oy - 13);
      ctx.fillStyle = '#dfe8ee';
      ctx.fillText(p.name, p.x + ox, p.y + oy - 13);
    }
  }

  // The circle you have to be inside to board anything.
  const me = players.find((p) => p.id === selfId);
  if (me && !me.riding) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.arc(me.x, me.y, BOARD_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  // ── a compass to the destination, when it is off screen ─────────────────
  if (me && !onScreen(dest.x, dest.y, -40)) {
    const a = Math.atan2(dest.y - me.y, dest.x - me.x);
    const rx = view.w / 2 - 78, ry = view.h / 2 - 78;
    const k = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
    const sx = view.w / 2 + Math.cos(a) * k, sy = view.h / 2 + Math.sin(a) * k;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(a);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(15, 0); ctx.lineTo(-11, 9); ctx.lineTo(-11, -9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const km = Math.hypot(dest.x - me.x, dest.y - me.y);
    ctx.font = '800 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`${Math.round(km)}m`, sx, sy + 26);
  }

}
