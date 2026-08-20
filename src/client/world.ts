/**
 * The geographic view: the city as it actually is, drawn to scale, seen from
 * above and followed around by a camera.
 *
 * This is the half of the game the schematic lies about. Everything here is
 * true — the distance between two stops is the distance you have to WALK, the
 * river is where the river is, and the tram two blocks away is genuinely going
 * to be at that platform in eleven seconds.
 *
 * It deliberately does NOT draw the network. It used to lay every line out on
 * the ground in full colour, which made the map on TAB redundant: you could
 * plan an entire route from the street without ever opening the diagram, so
 * the diagram was decoration and the game had one view instead of two. What
 * you get down here now is what you would actually get down here — streets,
 * buildings, water, and a station sign telling you what calls at it. Where
 * those lines GO is a question for the map.
 */
import { BOARD_RADIUS } from '../shared/constants.js';
import { nearestOnRiver } from '../shared/river.js';
import type { City, PlayerState, Vehicle } from '../shared/types.js';

export type Camera = { x: number; y: number; scale: number };

/**
 * A stable pseudo-random number for a point in the world. Buildings need to
 * vary and must not shimmer, and the alternative — putting a footprint list in
 * the City — would put a few thousand rectangles into something the client
 * rebuilds from a seed anyway.
 */
function hash2(x: number, y: number): number {
  let h = (Math.imul(Math.round(x), 73856093) ^ Math.imul(Math.round(y), 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

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
  // The ground IS the street: everything walkable is this colour, and every
  // building is painted on top of it. That way the walkable surface is the
  // figure rather than the gap, which is the right way round when the streets
  // are the only place you can be.
  ctx.fillStyle = '#2b313c';
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

  // ── the blocks. Solid: you walk around these, never through them ────────
  for (const b of city.blocks) {
    if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
    if (b.park) {
      ctx.fillStyle = '#1d3a26';
      roundRect(ctx, b.x, b.y, b.w, b.h, 7);
      ctx.fill();
      ctx.strokeStyle = '#25482f';
      ctx.lineWidth = 2;
      ctx.stroke();
      continue;
    }
    // A block is not one building. Split it into footprints on a small grid,
    // each with its own tone and a lit north-west edge, so what you are
    // walking around reads as a row of buildings rather than a dark rectangle.
    ctx.fillStyle = '#141922';
    roundRect(ctx, b.x, b.y, b.w, b.h, 3);
    ctx.fill();
    const cols = Math.max(1, Math.min(4, Math.round(b.w / 78)));
    const rows = Math.max(1, Math.min(4, Math.round(b.h / 78)));
    const cw = b.w / cols, ch = b.h / rows;
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const gx = b.x + cx * cw, gy = b.y + cy * ch;
        const n = hash2(gx, gy);
        const inset = 1 + n * 2.5;
        const w = cw - inset * 2, h = ch - inset * 2;
        if (w < 6 || h < 6) continue;
        const tone = 0x1a + Math.floor(n * 14);
        ctx.fillStyle = `rgb(${tone}, ${tone + 4}, ${tone + 11})`;
        roundRect(ctx, gx + inset, gy + inset, w, h, 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.03 + n * 0.035})`;
        roundRect(ctx, gx + inset, gy + inset, w, Math.min(4, h / 3), 1.5);
        ctx.fill();
      }
    }
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

  // ── stops. Names come later, once nothing can be drawn over them ────────
  const showNames = cam.scale > 0.55;
  for (const s of city.stops) {
    if (!onScreen(s.x, s.y, 60)) continue;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.lines.length > 1 ? 14 : 9.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f2f6fa';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#12161d';
    ctx.stroke();

    /**
     * Which lines call here, as a row of pips under the sign. This is the one
     * piece of network information the street keeps, and it is the difference
     * between a station and a white dot: standing at a stop you have to know
     * what you can board. It says nothing about where any of them GO, which is
     * still the map's job.
     */
    if (cam.scale > 0.75 && s.lines.length) {
      const pip = 5.5, gap = 3;
      const total = s.lines.length * pip + (s.lines.length - 1) * gap;
      let px = s.x - total / 2;
      for (const id of s.lines) {
        ctx.fillStyle = city.lines[id].color;
        roundRect(ctx, px, s.y + 17, pip, pip * 1.7, 1.6);
        ctx.fill();
        px += pip + gap;
      }
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

    /**
     * Buses and trams are ON the street and look it. A metro is underneath
     * the city and a train is up on a viaduct, so between stations they are
     * drawn faded — which is both honest about where they are and the reason
     * they are allowed to cut straight across a block that a bus has to drive
     * around. At a station they come back to full strength, because that is
     * where they surface and where you can get on.
     */
    const buried = line.mode === 'metro' ? 0.32 : line.mode === 'train' ? 0.6 : 1;
    const alpha = v.atStop >= 0 ? 1 : buried;

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.angle);
    ctx.globalAlpha = alpha;
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
    ctx.globalAlpha = 1;
    ctx.restore();

    // Label the ones you could act on: near enough to run for. At a
    // 14-second headway the city holds 170-odd vehicles, and labelling all of
    // them buried the station names under a drift of line numbers. Zoomed out
    // on a train, "at a stop" alone was not selective enough either — every
    // stop on screen had a bus in it.
    const near = Math.hypot(v.x - cam.x, v.y - cam.y) < 300;
    if (cam.scale > 0.5 && alpha > 0.5 && near) {
      // A dwelling vehicle sits exactly on its platform, so its label goes
      // BELOW it — above is where the station's own name lives, and the two
      // landing on each other made both unreadable at the one moment they
      // both matter.
      const ly = v.atStop >= 0 ? v.y + 26 : v.y - 14;
      ctx.font = `800 ${Math.round(12 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.9)';
      ctx.strokeText(line.name, v.x, ly);
      ctx.fillStyle = line.color;
      ctx.fillText(line.name, v.x, ly);
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
    // Speed lines when they are legging it. A rival sprinting is worth
    // seeing: it means they have spotted something with its doors open, and
    // it means they are spending a tank they will not have at the next change.
    if (p.sprinting) {
      ctx.save();
      ctx.translate(p.x + ox, p.y + oy);
      ctx.rotate(p.facing);
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      for (const dy of [-4.5, 0, 4.5]) {
        ctx.beginPath();
        ctx.moveTo(-9, dy);
        ctx.lineTo(-9 - (dy === 0 ? 15 : 10), dy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x + ox, p.y + oy, me ? 7.5 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineWidth = me ? 3.5 : 2.5;
    ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.7)';
    ctx.stroke();

    if (!me && cam.scale > 0.45) {
      // Beside the pip, not above or below it: above is the station's name and
      // below is the row of line pips, and a rival standing at a stop — which
      // is most of the time — landed on one or the other.
      ctx.font = `700 ${Math.round(11 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3.5 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.9)';
      ctx.strokeText(p.name, p.x + ox + 11, p.y + oy + 4);
      ctx.fillStyle = '#dfe8ee';
      ctx.fillText(p.name, p.x + ox + 11, p.y + oy + 4);
      ctx.textAlign = 'center';
    }
  }

  /**
   * Station names, last of all. Everything else on this map moves and they do
   * not, so a tram parked on top of "Königsplatz" is a label that vanishes at
   * exactly the moment you are trying to work out where you are.
   */
  if (showNames) {
    for (const s of city.stops) {
      if (!onScreen(s.x, s.y, 60)) continue;
      const inter = s.lines.length > 1;
      if (!inter && cam.scale <= 0.95) continue;
      const r = inter ? 13 : 8.5;
      ctx.font = `700 ${Math.round(13 / cam.scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4.5 / cam.scale;
      ctx.strokeStyle = 'rgba(6,9,13,0.92)';
      ctx.strokeText(s.name, s.x, s.y - r - 7);
      ctx.fillStyle = '#cbd7e2';
      ctx.fillText(s.name, s.x, s.y - r - 7);
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
