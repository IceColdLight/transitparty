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
import { CITY, MODES, WALK, type ModeId } from '../shared/constants.js';
import { nearestOnRiver } from '../shared/river.js';
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

/** Where the reader has the map scrolled to. Kept between openings. */
export type MapView = { zoom: number; panX: number; panY: number };

export function drawMap(
  ctx: CanvasRenderingContext2D,
  city: City,
  view: { w: number; h: number },
  vehicles: Vehicle[],
  players: PlayerState[],
  selfId: string,
  alpha: number,
  at: MapView = { zoom: 1, panX: 0, panY: 0 },
) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(7, 10, 15, 0.93)';
  ctx.fillRect(0, 0, view.w, view.h);

  // Fit the warped network into the window with room for labels — and keep
  // the left margin clear, because the legend lives there and a diagram drawn
  // underneath a legend is a diagram with a hole in it.
  const pad = 74;
  /**
   * The diagram is always fitted to the RIGHT of the legend, never underneath
   * it. Two earlier attempts were both wrong in the same way: hiding the
   * legend below 900px made the panel disappear on exactly the windows that
   * need it most, and floating it over the map hid whatever was behind it —
   * which in the first narrow screenshot happened to be the destination.
   *
   * Reserving the column costs the map some width. That is the correct thing
   * to spend, because a diagram you can read three quarters of beats a
   * diagram you can read all of and cannot decode.
   */
  const legendW = Math.max(196, Math.min(330, view.w * 0.30));
  const reserve = legendW;
  const wp = city.stops.map(warp);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of wp) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const availW = view.w - pad * 2 - reserve;
  const fit = Math.min(availW / (maxX - minX || 1), (view.h - pad * 2) / (maxY - minY || 1));
  const fox = reserve + (availW - (maxX - minX) * fit) / 2 + pad - minX * fit;
  const foy = (view.h - (maxY - minY) * fit) / 2 - minY * fit;

  /**
   * Zoom and pan about the middle of the sheet. Text is NOT scaled with it —
   * a name stays the same size while the space around it grows, which is what
   * makes zooming in reveal labels the collision pass had to drop rather than
   * simply making the same labels bigger.
   */
  const k = fit * at.zoom;
  const ox = view.w / 2 + (fox - view.w / 2) * at.zoom + at.panX;
  const oy = view.h / 2 + (foy - view.h / 2) * at.zoom + at.panY;
  const P = (p: { x: number; y: number }) => ({ x: warp(p).x * k + ox, y: warp(p).y * k + oy });
  const S = (i: number) => ({ x: wp[i].x * k + ox, y: wp[i].y * k + oy });

  /**
   * The water. Drawn as a soft wide band rather than a stroke, because at
   * eleven pixels of solid teal it read as another tram line — which on a
   * diagram whose whole job is telling coloured lines apart is the worst
   * possible thing for it to look like. Wide, dim and blue is unmistakably
   * terrain.
   */
  /**
   * The street grid, faint, under everything.
   *
   * This is what lets a player work out where they are standing, now that the
   * map does not tell them: read the two names on the corner, find where those
   * two streets cross on the sheet, and that is you. Without it the station
   * names are the only handhold, and only interchanges have room for a label.
   *
   * The names repeat along each street rather than sitting once at the margin,
   * so whatever corner of the map you have zoomed into, there is one nearby.
   */
  {
    const line = (fixed: number, vertical: boolean, name: string) => {
      const pts: { x: number; y: number }[] = [];
      const span = vertical ? CITY.height : CITY.width;
      for (let t = 0; t <= 12; t++) {
        const along = (t / 12) * span;
        pts.push(P(vertical ? { x: fixed, y: along } : { x: along, y: fixed }));
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      pts.forEach((q, i2) => (i2 === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.stroke();

      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(200, 214, 228, 0.62)';
      ctx.textAlign = 'center';
      let since = 1e9;
      for (let i2 = 1; i2 < pts.length; i2++) {
        const a2 = pts[i2 - 1], b2 = pts[i2];
        const seg = Math.hypot(b2.x - a2.x, b2.y - a2.y);
        since += seg;
        if (since < 300) continue;
        const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
        if (mid.x < 8 || mid.x > view.w - 8 || mid.y < 8 || mid.y > view.h - 8) continue;
        since = 0;
        let ang = Math.atan2(b2.y - a2.y, b2.x - a2.x);
        if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
        ctx.save();
        ctx.translate(mid.x, mid.y);
        ctx.rotate(ang);
        ctx.fillText(name, 0, -3);
        ctx.restore();
      }
      ctx.textAlign = 'left';
    };
    city.streets.xs.forEach((x, i2) => line(x, true, city.streets.xNames[i2]));
    city.streets.ys.forEach((y, i2) => line(y, false, city.streets.yNames[i2]));
  }

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const riverPath = () => {
    ctx.beginPath();
    city.river.poly.forEach((p, i) => {
      const q = P(p);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    });
  };
  ctx.strokeStyle = 'rgba(24, 58, 84, 0.85)';
  ctx.lineWidth = 26;
  riverPath(); ctx.stroke();
  ctx.strokeStyle = 'rgba(36, 84, 118, 0.75)';
  ctx.lineWidth = 15;
  riverPath(); ctx.stroke();

  // Bridges are rungs across the water, not dots on it — they are the only
  // places anything gets over, so they should look like crossings.
  for (const b of city.river.bridges) {
    const q = P(b);
    const near = P(nearestOnRiver(city.river, { x: b.x + 1, y: b.y }));
    const a = Math.atan2(q.y - near.y, q.x - near.x) + Math.PI / 2;
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(a);
    // Emphatically drawn. Three of these decide every race, and at three and
    // a half pixels of grey they were invisible against the water.
    ctx.strokeStyle = 'rgba(8, 12, 18, 0.9)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, -22); ctx.lineTo(0, 22);
    ctx.stroke();
    ctx.strokeStyle = '#c9d4e0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -22); ctx.lineTo(0, 22);
    ctx.stroke();
    ctx.restore();
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

  /**
   * Everybody racing EXCEPT you.
   *
   * There is no "you are here". A dot on the map turns navigation into
   * following a marker, and the whole reason the street has names and the
   * stations have signs is that finding yourself is supposed to be the work.
   * Read the corner, read the platform, find the name on the diagram.
   *
   * Rivals stay. Watching somebody take the wrong bridge is most of the point
   * of racing, and if one happens to be standing next to you and gives your
   * position away, that is a thing you had to earn by keeping up with them.
   */
  for (const pl of players) {
    if (pl.id === selfId) continue;
    const p = P(pl);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = pl.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.stroke();
  }

  /**
   * Names go on LAST — after the vehicles and the pips — because a name that
   * a passing tram is sitting on top of is not a name. Interchanges only: a
   * diagram with every station labelled is a wall of text.
   */
  /**
   * Names, laid out so they do not sit on top of each other.
   *
   * With no marker for yourself on the map, the station name is how you work
   * out which part of the diagram you are standing in — so every interchange
   * needs one, and a name buried under another name is no use at all. Busiest
   * stations get first refusal on the space; anything that would collide is
   * dropped rather than drawn over.
   */
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const fits = (x: number, y: number, w: number, h: number) => {
    for (const t of taken) {
      if (x < t.x + t.w && x + w > t.x && y < t.y + t.h && y + h > t.y) return false;
    }
    return true;
  };
  const named = city.stops
    .filter((s) => s.lines.length >= 2 || s.id === city.origin || s.id === city.destination)
    .sort((a, b) => {
      const key = (s: typeof a) =>
        (s.id === city.origin || s.id === city.destination ? 100 : 0) + s.lines.length;
      return key(b) - key(a);
    });
  for (const s of named) {
    const p = S(s.id);
    const off = s.id === city.origin || s.id === city.destination ? 28 : 10;
    const w = ctx.measureText(s.name).width;
    if (!fits(p.x + off - 1, p.y - 8, w + 2, 13)) continue;
    taken.push({ x: p.x + off - 1, y: p.y - 8, w: w + 2, h: 13 });
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(7,10,15,0.95)';
    ctx.strokeText(s.name, p.x + off, p.y + 4);
    ctx.fillStyle = '#c3d0dc';
    ctx.fillText(s.name, p.x + off, p.y + 4);
  }

  /**
   * Origin and destination, drawn LAST and as rings rather than discs.
   *
   * They used to be filled badges drawn before the players, which meant that
   * at the start of a round every pip in the game was sitting on top of the
   * "A" — and at the end of one, on top of the "B". A ring with the letter
   * hung off its shoulder survives a crowd standing in it.
   */
  const badge = (i: number, label: string, color: string) => {
    const p = S(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
    ctx.lineWidth = 6.5;
    ctx.strokeStyle = 'rgba(8, 12, 18, 0.9)';
    ctx.stroke();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    const lx = p.x + 15, ly = p.y - 15;
    ctx.beginPath();
    ctx.arc(lx, ly, 9.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0b0f15';
    ctx.stroke();
    ctx.font = '900 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0b0f15';
    ctx.fillText(label, lx, ly + 4.2);
    ctx.textAlign = 'left';
  };
  badge(city.origin, 'A', '#7fe08a');
  badge(city.destination, 'B', '#ffd166');

  // ── legend ──────────────────────────────────────────────────────────────
  /**
   * The legend answers one question and it has to answer it without being
   * read carefully: WHICH OF THESE IS FASTER. So each mode gets a bar as well
   * as a number, and walking is on the same scale at the bottom, because
   * "twice walking pace" is the only unit anybody actually feels.
   *
   * It used to be four rows of bare line badges in the top-left corner, tucked
   * under the status panel, saying nothing about what a badge meant.
   *
   * Speed here is what the lines in THIS city actually average end to end,
   * dwells included — not the mode's cruise figure, which is a number no
   * passenger ever travels at.
   */
  const modes = order.filter((m) => city.lines.some((l) => l.mode === m));
  if (modes.length) {
    const stats = modes.map((mode) => {
      const ls = city.lines.filter((l) => l.mode === mode);
      let speed = 0;
      for (const l of ls) {
        let span = 0;
        for (let i = 0; i + 1 < l.stops.length; i++) {
          span += Math.hypot(city.stops[l.stops[i]].x - city.stops[l.stops[i + 1]].x,
            city.stops[l.stops[i]].y - city.stops[l.stops[i + 1]].y);
        }
        speed += span / (l.oneWay - l.dwell);
      }
      speed /= ls.length;
      const headway = ls.reduce((a, l) => a + l.headway, 0) / ls.length;
      return { mode: mode as ModeId, lines: ls, speed, headway };
    });
    const fastest = Math.max(...stats.map((s2) => s2.speed));
    const bx = 18, by = 18, bw = legendW - 36;
    // Measure the panel instead of guessing it: a mode with enough lines wraps
    // its badges onto a second row, and a fixed height clipped them.
    let boxH = 62 + 30;
    for (const st of stats) {
      const perRow = Math.max(1, Math.floor((bw - 32 + 4) / 29));
      boxH += 24 + 8 + 24 + (Math.ceil(st.lines.length / perRow) - 1) * 19;
    }

    ctx.fillStyle = 'rgba(12, 17, 24, 0.94)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bw, boxH, 9);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = '800 12px system-ui, sans-serif';
    ctx.fillStyle = '#e7edf3';
    ctx.fillText('NETWORK', bx + 16, by + 26);
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#5d6b7a';
    ctx.fillText('not to scale — the centre is enlarged', bx + 16, by + 42);

    /**
     * Each mode gets three lines rather than one: its line badges (wrapped),
     * then its name and numbers, then the bar. Cramming them onto one row put
     * the bus's seven badges straight through "24 km/h · every 0:41" — the
     * exact number the panel exists to show.
     */
    let y = by + 62;
    for (const st of stats) {
      let lx = bx + 16;
      for (const line of st.lines) {
        if (lx + 25 > bx + bw - 16) { lx = bx + 16; y += 19; }
        ctx.fillStyle = line.color;
        roundRect(ctx, lx, y, 25, 15, 4);
        ctx.fill();
        ctx.font = '800 10px system-ui, sans-serif';
        ctx.fillStyle = '#0c1016';
        ctx.textAlign = 'center';
        ctx.fillText(line.name, lx + 12.5, y + 11);
        ctx.textAlign = 'left';
        lx += 29;
      }
      y += 24;

      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = '#c3d0dc';
      ctx.fillText(MODES[st.mode].label, bx + 16, y);
      /**
       * Speed as a MULTIPLE OF WALKING, not km/h.
       *
       * The city runs at TEMPO times real life, so the honest km/h figures
       * come out at 197 for a train and — the giveaway — 26 on foot, which is
       * a sprinter. Dividing them back down would have been worse: the speeds
       * would have read as real while the clock beside them still ran at game
       * pace. A multiple of walking is true in either frame, it is the
       * comparison the player is actually making, and it makes the "on foot"
       * row at the bottom the unit rather than an afterthought.
       */
      const mins = Math.floor(st.headway / 60), secs = Math.round(st.headway % 60);
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.fillStyle = '#8b9aa8';
      ctx.textAlign = 'right';
      ctx.fillText(`${(st.speed / WALK.speed).toFixed(1)}× walking · every ${mins}:${String(secs).padStart(2, '0')}`,
        bx + bw - 16, y);
      ctx.textAlign = 'left';
      y += 8;

      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(ctx, bx + 16, y, bw - 32, 9, 3);
      ctx.fill();
      ctx.fillStyle = st.lines[0].color;
      roundRect(ctx, bx + 16, y, Math.max(4, (bw - 32) * (st.speed / fastest)), 9, 3);
      ctx.fill();
      y += 24;
    }

    // walking, on the same scale, so the bars mean something
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#5d6b7a';
    ctx.fillText('on foot', bx + 16, y);
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('walking pace', bx + bw - 16, y);
    ctx.textAlign = 'left';
    y += 8;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, bx + 16, y, bw - 32, 9, 3);
    ctx.fill();
    ctx.fillStyle = '#5d6b7a';
    roundRect(ctx, bx + 16, y, Math.max(3, (bw - 32) * (WALK.speed / fastest)), 9, 3);
    ctx.fill();
  }

  ctx.restore();
}
