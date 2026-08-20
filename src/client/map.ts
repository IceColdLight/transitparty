/**
 * The network map, held on TAB.
 *
 * It is a diagram, not a map, and it is wrong on purpose — see
 * shared/schematic.ts for what the distortion is and why every real transit
 * map has one. Two consequences the player feels:
 *
 *   - the middle of the city is legible, which is where the interchanges are
 *     and therefore where the planning happens
 *   - the outskirts are squashed, so the last leg of a race always looks
 *     shorter on the diagram than it turns out to be on your feet
 *
 * It shows everything live, including vehicles, because knowing where the
 * trams ARE is the information the game is played on. What it withholds is
 * scale.
 */
import { MODES } from '../shared/constants.js';
import { warp } from '../shared/schematic.js';
import type { City, PlayerState, Vehicle } from '../shared/types.js';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  city: City,
  view: { w: number; h: number },
  vehicles: Vehicle[],
  players: PlayerState[],
  selfId: string,
  alpha: number,
) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(7, 10, 15, 0.93)';
  ctx.fillRect(0, 0, view.w, view.h);

  // Fit the warped network into the window with room for labels.
  const pad = 74;
  const wp = city.stops.map(warp);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of wp) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const k = Math.min((view.w - pad * 2) / (maxX - minX || 1), (view.h - pad * 2) / (maxY - minY || 1));
  const ox = (view.w - (maxX - minX) * k) / 2 - minX * k;
  const oy = (view.h - (maxY - minY) * k) / 2 - minY * k;
  const P = (p: { x: number; y: number }) => ({ x: warp(p).x * k + ox, y: warp(p).y * k + oy });
  const S = (i: number) => ({ x: wp[i].x * k + ox, y: wp[i].y * k + oy });

  // ── the water. Thin, because on a diagram it is a reference, not terrain ──
  ctx.strokeStyle = 'rgba(38, 96, 138, 0.85)';
  ctx.lineWidth = 11;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  city.river.poly.forEach((p, i) => {
    const q = P(p);
    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
  for (const b of city.river.bridges) {
    const q = P(b);
    ctx.fillStyle = '#5b6470';
    ctx.beginPath();
    ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── lines ───────────────────────────────────────────────────────────────
  const order = ['train', 'metro', 'tram', 'bus'] as const;
  const widthOf = { train: 8, metro: 6.5, tram: 5, bus: 3.5 } as const;
  for (const mode of order) {
    for (const line of city.lines) {
      if (line.mode !== mode) continue;
      // Fan overlapping trunks apart a little so a shared corridor does not
      // read as one line. Crude next to a real diagram's parallel routing,
      // but it is the difference between four lines and one fat one.
      const off = ((line.id % 5) - 2) * 2.2;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = widthOf[mode];
      ctx.beginPath();
      line.stops.forEach((s, i) => {
        const p = S(s);
        if (i === 0) ctx.moveTo(p.x + off, p.y + off); else ctx.lineTo(p.x + off, p.y + off);
      });
      ctx.stroke();
    }
  }

  // ── stops. Interchanges get a real marker; the rest get a tick ──────────
  for (const s of city.stops) {
    const p = S(s.id);
    const inter = s.lines.length > 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, inter ? 6.5 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = inter ? '#f2f6fa' : '#8b98a6';
    ctx.fill();
    if (inter) {
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = '#0b0f15';
      ctx.stroke();
    }
  }

  // Label the interchanges only — a diagram with every name on it is a wall.
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const s of city.stops) {
    if (s.lines.length < 3 && s.id !== city.origin && s.id !== city.destination) continue;
    const p = S(s.id);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(7,10,15,0.95)';
    ctx.strokeText(s.name, p.x + 10, p.y + 4);
    ctx.fillStyle = '#c3d0dc';
    ctx.fillText(s.name, p.x + 10, p.y + 4);
  }

  // ── vehicles, live ──────────────────────────────────────────────────────
  for (const v of vehicles) {
    const p = P(v);
    const line = city.lines[v.line];
    ctx.fillStyle = line.color;
    roundRect(ctx, p.x - 3.6, p.y - 3.6, 7.2, 7.2, 2);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.stroke();
  }

  // ── origin and destination ──────────────────────────────────────────────
  const badge = (i: number, label: string, color: string) => {
    const p = S(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0b0f15';
    ctx.stroke();
    ctx.font = '900 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0b0f15';
    ctx.fillText(label, p.x, p.y + 4.5);
    ctx.textAlign = 'left';
  };
  badge(city.origin, 'A', '#7fe08a');
  badge(city.destination, 'B', '#ffd166');

  // ── everybody racing ────────────────────────────────────────────────────
  for (const pl of players) {
    const p = P(pl);
    const me = pl.id === selfId;
    ctx.beginPath();
    ctx.arc(p.x, p.y, me ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = pl.color;
    ctx.fill();
    ctx.lineWidth = me ? 3 : 2;
    ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.75)';
    ctx.stroke();
  }

  // ── legend ──────────────────────────────────────────────────────────────
  const modes = order.filter((m) => city.lines.some((l) => l.mode === m));
  let ly = 24;
  ctx.textAlign = 'left';
  for (const mode of modes) {
    const spec = MODES[mode];
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillStyle = '#78889a';
    ctx.fillText(spec.label.toUpperCase(), 20, ly);
    let lx = 74;
    for (const line of city.lines.filter((l) => l.mode === mode)) {
      ctx.fillStyle = line.color;
      roundRect(ctx, lx, ly - 10, 26, 14, 4);
      ctx.fill();
      ctx.font = '800 10px system-ui, sans-serif';
      ctx.fillStyle = '#0b0f15';
      ctx.textAlign = 'center';
      ctx.fillText(line.name, lx + 13, ly);
      ctx.textAlign = 'left';
      lx += 31;
    }
    ly += 22;
  }
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = '#5d6b7a';
  ctx.fillText('NOT TO SCALE — THE CENTRE IS ENLARGED', 20, ly + 6);

  ctx.restore();
}
