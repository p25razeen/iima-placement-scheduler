/* Canvas renderer: PP Gupta Auditorium, the central tracker, the wings on three floors, Placecom volunteers and moving students. */
window.PS = window.PS || {};
(function (PS) {
  'use strict';
  const W = 1200, H = 710;
  const AUD = { x: 14, y: 40, w: 372, h: 650 };
  const DOOR = { x: AUD.x + AUD.w, y: AUD.y + AUD.h / 2 };
  const TRK = { x: 408, y: DOOR.y - 78, w: 100, h: 156 };
  const DESK = { x: TRK.x + TRK.w / 2, y: TRK.y + TRK.h / 2 + 18 };
  const SPINE_X = 530;
  const FX = 552, FW = W - FX - 10;
  const TO_TRACKER = 0.15, AT_TRACKER = 0.5; // share of each walk: reach the tracker, check in, then on to the wing

  // layout adapts to the number of wings, rooms per wing and students
  let L = null;
  function floorsFor(nW) { // wings 2,3 ground; 6,7,8 first; 9-12 (and any extra) second
    const f = [[], [], []];
    for (let w = 0; w < nW; w++) f[Math.min(2, PS.wingFloor(w))].push(w);
    return f;
  }
  function layoutFor(P, nStudents) {
    const key = [P.wings, P.roomsPerWingPlanned, P.roomsPerWingBuffer, P.gdRoomsPerWing, nStudents].join('|');
    if (L && L.key === key) return L;
    const nW = Math.max(1, Math.round(P.wings)), perWing = Math.max(1, Math.round(P.roomsPerWingPlanned + P.roomsPerWingBuffer));
    const floors = floorsFor(nW);
    const gap = 10, bandH = (H - 40 - 10 - gap * 2) / 3;
    const maxPer = Math.max(1, ...floors.map(f => f.length));
    const wingW = Math.min(156, (FW - 8 * (maxPer - 1)) / maxPer);
    const wings = new Array(nW), bands = [];
    // second floor at the top, ground floor at the bottom, like a cross-section of the building
    for (let fl = 0; fl < 3; fl++) {
      const row = 2 - fl, y = 40 + row * (bandH + gap);
      const band = { floor: fl, y, h: bandH, corridorY: y + bandH - 11, wings: floors[fl] };
      bands.push(band);
      floors[fl].forEach((w, i) => { wings[w] = { x: FX + i * (wingW + 8), y: y + 18, w: wingW, h: bandH - 18 - 30, floor: fl, corridorY: band.corridorY }; });
    }
    const synH = 22; // syndicate (GD) rooms either side of the wing entrance
    const iw = wingW - 12, ih = wings[0].h - 26 - synH - 6; const gx = 3, gy = 4;
    let best = null;
    for (let c = 1; c <= perWing; c++) {
      const r = Math.ceil(perWing / c), rw = (iw - gx * (c - 1)) / c, rh = (ih - gy * (r - 1)) / r;
      const sc = Math.min(rw, rh / 1.25); if (rw > 6 && rh > 6 && (!best || sc > best.sc)) best = { c, rw, rh, sc };
    }
    best = best || { c: perWing, rw: 6, rh: 6 };
    const n = Math.max(1, nStudents), seatCols = Math.max(10, Math.ceil(Math.sqrt(n * (AUD.w - 40) / (AUD.h - 90))));
    const seatRows = Math.ceil(n / seatCols);
    const sx = (AUD.w - 40) / Math.max(1, seatCols - 1), sy = Math.min(30, (AUD.h - 100) / Math.max(1, seatRows - 1));
    L = { key, synH, gdN: Math.max(1, Math.round(P.gdRoomsPerWing || 2)), wings, bands, roomCols: best.c, rw: best.rw, rh: best.rh, gx, gy, seatCols, sx, sy, seatR: Math.max(1.6, Math.min(5.2, Math.min(sx, sy) / 3.6)), roomFont: Math.max(6, Math.min(9, best.rw / 4.4)) };
    return L;
  }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#999';
  const FONT = (sz, wt) => (wt ? wt + ' ' : '') + sz + 'px Inter, Segoe UI, system-ui, sans-serif';

  function seatPos(i) {
    const col = i % L.seatCols, row = Math.floor(i / L.seatCols);
    return { x: AUD.x + 20 + col * L.sx, y: AUD.y + 70 + row * L.sy };
  }
  function roomRect(wing, slot) {
    const g = L.wings[wing]; if (!g) return { x: -100, y: -100, w: 1, h: 1 };
    const col = slot % L.roomCols, row = Math.floor(slot / L.roomCols);
    return { x: g.x + 6 + col * (L.rw + L.gx), y: g.y + 20 + row * (L.rh + L.gy), w: L.rw, h: L.rh };
  }
  // syndicate rooms sit either side of the wing entrance, where the Placecom volunteer is; they hold GDs on GD days
  const EW = 26;
  function gdRect(wing, slot) {
    const g = L.wings[wing]; if (!g) return { x: -100, y: -100, w: 1, h: 1 };
    const n = L.gdN, nl = Math.ceil(n / 2), nr = n - nl, sideW = (g.w - 12 - EW) / 2, y = g.y + g.h - L.synH - 4;
    if (slot < nl) { const w = (sideW - 3 * (nl - 1)) / nl; return { x: g.x + 6 + slot * (w + 3), y, w, h: L.synH }; }
    const j = slot - nl, w = (sideW - 3 * (nr - 1)) / Math.max(1, nr); return { x: g.x + 6 + sideW + EW + j * (w + 3), y, w, h: L.synH };
  }
  function gdSeat(wing, slot, i, n) {
    const r = gdRect(wing, slot), cols = Math.max(1, Math.min(5, Math.ceil(n / 2))), rows = Math.ceil(n / cols);
    const col = i % cols, row = Math.floor(i / cols);
    return { x: r.x + (col + 0.5) * r.w / cols, y: r.y + 11 + (rows > 1 ? row * 6 : 3) };
  }
  function entrance(wing) { const g = L.wings[wing] || L.wings[0]; return { x: g.x + g.w / 2, y: g.y + g.h, cy: g.corridorY }; }
  function deskSpot(s) { return { x: DESK.x + ((s.id % 9) - 4) * 9, y: DESK.y + 18 + ((Math.floor(s.id / 9) % 5) - 2) * 8 }; }

  function pathToTracker(s) {
    const seat = seatPos(s.id);
    return [seat, { x: DOOR.x - 6, y: Math.min(Math.max(seat.y, DOOR.y - 40), DOOR.y + 40) }, { x: DOOR.x + 4, y: DOOR.y }, { x: TRK.x, y: DOOR.y }, deskSpot(s)];
  }
  function pathToPoint(s, wing, pt) {
    const en = entrance(wing), d = deskSpot(s);
    return [d, { x: TRK.x + TRK.w, y: DOOR.y }, { x: SPINE_X, y: DOOR.y }, { x: SPINE_X, y: en.cy }, { x: en.x, y: en.cy }, { x: en.x, y: en.y }, pt];
  }
  function pathToRoom(s, room) { const rr = roomRect(room.wing, room.slot); return pathToPoint(s, room.wing, { x: rr.x + rr.w / 2, y: rr.y + rr.h * 0.62 }); }
  function along(pts, f) {
    let total = 0; const segs = [];
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segs.push(d); total += d; }
    let target = f * total;
    for (let i = 1; i < pts.length; i++) { if (target <= segs[i - 1]) { const r = segs[i - 1] ? target / segs[i - 1] : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * r, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * r }; } target -= segs[i - 1]; }
    return pts[pts.length - 1];
  }
  // f runs 0 → 1 from the auditorium to the room (reversed for the walk back)
  function walkPos(s, room, f) {
    if (f <= TO_TRACKER) return along(pathToTracker(s), f / TO_TRACKER);
    if (f <= AT_TRACKER) return deskSpot(s);
    return along(pathToRoom(s, room), (f - AT_TRACKER) / (1 - AT_TRACKER));
  }
  function walkPosPt(s, wing, pt, f) {
    if (f <= TO_TRACKER) return along(pathToTracker(s), f / TO_TRACKER);
    if (f <= AT_TRACKER) return deskSpot(s);
    return along(pathToPoint(s, wing, pt), (f - AT_TRACKER) / (1 - AT_TRACKER));
  }
  // straight from one GD to the next, still checking in at the central tracker on the way
  function roomToRoom(s, a, pa, b, pb, f) {
    const back = pathToPoint(s, a.wing, pa).slice().reverse(), on = pathToPoint(s, b.wing, pb);
    return along(back.concat(on.slice(1)), f);
  }

  const colorCache = {};
  PS.firmColor = function (name) {
    if (colorCache[name]) return colorCache[name];
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return (colorCache[name] = 'hsl(' + h + ',55%,58%)');
  };
  PS.firmTint = function (name) { const c = PS.firmColor(name); return c.replace('58%)', '90%)'); };
  const shortName = (n, max) => { const w = n.replace(/\(.*?\)/g, '').replace(/&/g, '').split(/\s+/).filter(Boolean); const s = w.length === 1 ? w[0] : w[0]; return s.slice(0, max); };

  class Renderer {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.bubbleSeen = new Map(); this.hover = null;
      const dpr = window.devicePixelRatio || 1; canvas.width = W * dpr; canvas.height = H * dpr; this.ctx.scale(dpr, dpr);
      this.colors = { free: css('--c-free'), walk: css('--c-walk'), int: css('--c-int'), hold: css('--c-hold'), placed: css('--c-placed'), dream: css('--c-dream'), out: css('--c-out') };
    }
    // ---------------- GD day replay: positions come straight from the GD timetable
    gdPrep(gd) {
      if (this.gdCache && this.gdCache.day === gd.day && this.gdCache.mode === gd.mode) return this.gdCache;
      const groups = gd.day[gd.mode].groups, segs = new Map();
      groups.forEach(g => g.members.forEach((id, i) => { if (!segs.has(id)) segs.set(id, []); segs.get(id).push({ g, i }); }));
      for (const v of segs.values()) v.sort((a, b) => a.g.start - b.g.start);
      return (this.gdCache = { day: gd.day, mode: gd.mode, groups, segs });
    }
    gdPos(sim, s, t, gd) {
      const C = this.gdPrep(gd), segs = C.segs.get(s.id), tr = Math.max(0.5, sim.P.transit);
      if (!segs) return { p: seatPos(s.id), kind: 'none' };
      const seat = (x) => gdSeat(x.g.wing, x.g.slot, x.i, x.g.size);
      const walk = (x, f) => ({ p: walkPosPt(s, x.g.wing, seat(x), f), kind: 'walk', desk: f > TO_TRACKER && f <= AT_TRACKER });
      let k = segs.findIndex(x => x.g.end > t);
      if (k < 0) { const last = segs[segs.length - 1]; const f = (t - last.g.end) / tr; return f < 1 ? walk(last, 1 - f) : { p: seatPos(s.id), kind: 'done' }; }
      const cur = segs[k], prev = segs[k - 1];
      if (t >= cur.g.start) return { p: seat(cur), kind: 'gd', seg: cur };
      if (prev && cur.g.start - prev.g.end <= 2 * tr) { const f = (t - prev.g.end) / Math.max(0.01, cur.g.start - prev.g.end); return { p: roomToRoom(s, prev.g, seat(prev), cur.g, seat(cur), Math.max(0, Math.min(1, f))), kind: 'walk', desk: Math.abs(f - 0.5) < 0.08 }; }
      if (prev && t < prev.g.end + tr) return walk(prev, 1 - (t - prev.g.end) / tr);
      if (t >= cur.g.start - tr) return walk(cur, (t - (cur.g.start - tr)) / tr);
      return { p: seatPos(s.id), kind: 'wait' };
    }
    walkFrac(s, tv) { let f = (tv - s.moveStart) / Math.max(0.01, s.moveEnd - s.moveStart); f = Math.max(0, Math.min(1, f)); return s.loc === 'walkBack' ? 1 - f : f; }
    studentPos(s, tv) {
      if ((s.loc === 'walkTo' || s.loc === 'walkBack') && s.room) return walkPos(s, s.room, this.walkFrac(s, tv));
      if (s.loc === 'room' && s.room) { const rr = roomRect(s.room.wing, s.room.slot); return { x: rr.x + rr.w / 2, y: rr.y + rr.h * 0.62 }; }
      return seatPos(s.id);
    }
    atTracker(s, tv) { if (!((s.loc === 'walkTo' || s.loc === 'walkBack') && s.room)) return false; const f = this.walkFrac(s, tv); return f > TO_TRACKER && f <= AT_TRACKER; }
    studentColor(s) {
      if (s.loc === 'walkTo' || s.loc === 'walkBack') return this.colors.walk;
      if (s.loc === 'room') return this.colors.int;
      if (s.status === 'dreaming' && s.active) return this.colors.dream;
      if (s.cAccepted) return this.colors.placed;
      if (s.holdFirm != null) return this.colors.hold;
      if (!s.active) return s.status === 'dreaming' ? this.colors.dream : this.colors.out;
      return this.colors.free;
    }
    draw(sim, tv, gd) {
      layoutFor(sim.P, sim.students.length);
      const ctx = this.ctx; ctx.clearRect(0, 0, W, H);
      ctx.font = FONT(11); ctx.textBaseline = 'middle';
      // auditorium
      ctx.fillStyle = '#f7f5f1'; ctx.strokeStyle = '#d9d4ca'; ctx.lineWidth = 1;
      roundRect(ctx, AUD.x, AUD.y, AUD.w, AUD.h, 12); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e9e4da'; roundRect(ctx, AUD.x + 60, AUD.y + 10, AUD.w - 120, 30, 6); ctx.fill();
      ctx.fillStyle = '#6b7380'; ctx.textAlign = 'center'; ctx.font = FONT(12, 600);
      ctx.fillText('PP Gupta Auditorium', AUD.x + AUD.w / 2, AUD.y + 25);
      // corridors: door → tracker → stairs → each floor's corridor
      ctx.strokeStyle = '#e6e1d7'; ctx.lineWidth = 10; ctx.lineCap = 'round';
      const cys = L.bands.filter(b => b.wings.length).map(b => b.corridorY);
      ctx.beginPath(); ctx.moveTo(DOOR.x + 4, DOOR.y); ctx.lineTo(SPINE_X, DOOR.y);
      ctx.moveTo(SPINE_X, Math.min(DOOR.y, ...cys)); ctx.lineTo(SPINE_X, Math.max(DOOR.y, ...cys)); ctx.stroke();
      for (const b of L.bands) if (b.wings.length) { const last = L.wings[b.wings[b.wings.length - 1]]; ctx.beginPath(); ctx.moveTo(SPINE_X, b.corridorY); ctx.lineTo(last.x + last.w / 2, b.corridorY); ctx.stroke(); }
      ctx.lineWidth = 1; ctx.lineCap = 'butt';
      ctx.fillStyle = '#d9d4ca'; ctx.fillRect(DOOR.x - 3, DOOR.y - 22, 6, 44);
      ctx.save(); ctx.translate(SPINE_X - 12, (Math.min(...cys) + Math.max(...cys)) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = '#a49d90'; ctx.font = FONT(9, 600); ctx.textAlign = 'center'; ctx.fillText('STAIRS · LIFT', 0, 0); ctx.restore();
      // central tracker
      ctx.fillStyle = '#fff8e6'; ctx.strokeStyle = '#e8c56a'; ctx.lineWidth = 1.2; roundRect(ctx, TRK.x, TRK.y, TRK.w, TRK.h, 10); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#7a5600'; ctx.textAlign = 'center'; ctx.font = FONT(11, 700); ctx.fillText('Central', TRK.x + TRK.w / 2, TRK.y + 15); ctx.fillText('tracker', TRK.x + TRK.w / 2, TRK.y + 28);
      drawPerson(ctx, DESK.x - 16, DESK.y - 22, '#e0a526'); drawPerson(ctx, DESK.x + 16, DESK.y - 22, '#e0a526');
      ctx.fillStyle = '#c9a24a'; roundRect(ctx, DESK.x - 38, DESK.y - 9, 76, 9, 3); ctx.fill();
      ctx.fillStyle = '#4b5361'; roundRect(ctx, DESK.x - 5, DESK.y - 19, 10, 8, 1.5); ctx.fill();
      // empty seats
      for (let i = 0; i < sim.students.length; i++) { const p = seatPos(i); ctx.strokeStyle = '#e1dcd2'; ctx.beginPath(); ctx.arc(p.x, p.y, L.seatR, 0, Math.PI * 2); ctx.stroke(); }
      // floors, wings and rooms
      for (const b of L.bands) {
        if (!b.wings.length) continue;
        ctx.fillStyle = '#8a8377'; ctx.textAlign = 'left'; ctx.font = FONT(10, 700); ctx.fillText(PS.FLOOR_NAMES[b.floor].toUpperCase(), FX, b.y + 7);
      }
      const roomFirm = new Map(), gdNow = new Map();
      if (gd) { for (const g of gd.day[gd.mode].groups) if (tv >= g.start && tv < g.end) gdNow.set(g.wing * 100 + g.slot, g); }
      else if (sim.physRooms) for (const r of sim.physRooms.values()) roomFirm.set(r.wing * 100 + r.slot, r);
      const perWing = Math.round(sim.P.roomsPerWingPlanned + sim.P.roomsPerWingBuffer);
      const nameMax = Math.max(2, Math.floor(L.rw / (L.roomFont * 0.62)));
      for (let w = 0; w < L.wings.length; w++) {
        const g = L.wings[w];
        ctx.fillStyle = '#fbfaf8'; ctx.strokeStyle = '#d9d4ca'; roundRect(ctx, g.x, g.y, g.w, g.h, 9); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#4b5361'; ctx.textAlign = 'left'; ctx.font = FONT(12, 600); ctx.fillText('Wing ' + PS.wingLabel(w), g.x + 7, g.y + 11);
        // Placecom volunteer at the wing entrance, with a syndicate room on either side
        const e = entrance(w); ctx.fillStyle = '#d9d4ca'; ctx.fillRect(e.x - 9, e.y - 2, 18, 4);
        drawPerson(ctx, e.x, e.y - L.synH / 2 - 4, '#e0a526');
        ctx.fillStyle = '#9a6c00'; ctx.textAlign = 'left'; ctx.font = FONT(8.5); ctx.fillText('Placecom', e.x + 12, e.cy - 2);
        for (let j = 0; j < L.gdN; j++) {
          const rr = gdRect(w, j), g = gdNow.get(w * 100 + j);
          if (g) { ctx.fillStyle = PS.firmTint(g.comp); ctx.strokeStyle = PS.firmColor(g.comp); ctx.lineWidth = 1.5; }
          else { ctx.fillStyle = gd ? '#ffffff' : '#f4f1ea'; ctx.strokeStyle = gd ? '#cbbf9f' : '#ddd8ce'; ctx.lineWidth = 1; }
          roundRect(ctx, rr.x, rr.y, rr.w, rr.h, 4); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
          ctx.textAlign = 'center'; ctx.font = FONT(7, 600);
          if (g) { ctx.fillStyle = '#1d232b'; ctx.fillText(shortName(g.comp, Math.max(3, Math.floor(rr.w / 4.6))), rr.x + rr.w / 2, rr.y + 5.5); }
          else { ctx.fillStyle = '#a49d90'; ctx.fillText(gd ? 'GD room' : 'Syndicate', rr.x + rr.w / 2, rr.y + rr.h / 2); }
        }
        for (let j = 0; j < perWing; j++) {
          const rr = roomRect(w, j); const r = roomFirm.get(w * 100 + j); const buffer = j >= sim.P.roomsPerWingPlanned;
          if (r && r.firm) { ctx.fillStyle = PS.firmTint(r.firm.name); ctx.strokeStyle = PS.firmColor(r.firm.name); ctx.lineWidth = 1.5; }
          else { ctx.fillStyle = buffer ? '#efece6' : '#ffffff'; ctx.strokeStyle = buffer ? '#cfc9bd' : '#ddd8ce'; ctx.lineWidth = 1; }
          roundRect(ctx, rr.x, rr.y, rr.w, rr.h, 4); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
          if (buffer && !(r && r.firm)) { ctx.save(); ctx.beginPath(); roundRect(ctx, rr.x, rr.y, rr.w, rr.h, 4); ctx.clip(); ctx.strokeStyle = '#e2ddd3'; for (let k = -rr.h; k < rr.w; k += 7) { ctx.beginPath(); ctx.moveTo(rr.x + k, rr.y + rr.h); ctx.lineTo(rr.x + k + rr.h, rr.y); ctx.stroke(); } ctx.restore(); }
          if (r && r.firm) { ctx.fillStyle = '#1d232b'; ctx.textAlign = 'center'; ctx.font = FONT(L.roomFont, 600); ctx.fillText(shortName(r.firm.name, nameMax), rr.x + rr.w / 2, rr.y + 7); }
        }
      }
      // students
      let atDesk = 0;
      if (gd) {
        const col = { gd: this.colors.int, walk: this.colors.walk, wait: this.colors.free, done: this.colors.free, none: this.colors.out };
        const pos = sim.students.map(s => ({ s, q: this.gdPos(sim, s, tv, gd) }));
        pos.sort((a, b) => (b.q.kind === 'wait' || b.q.kind === 'none' || b.q.kind === 'done') - (a.q.kind === 'wait' || a.q.kind === 'none' || a.q.kind === 'done'));
        for (const { q } of pos) {
          if (q.desk) atDesk++;
          const inRoom = q.kind === 'gd';
          ctx.fillStyle = col[q.kind]; ctx.strokeStyle = 'rgba(0,0,0,.3)';
          ctx.beginPath(); ctx.arc(q.p.x, q.p.y, inRoom ? 2.4 : (q.kind === 'walk' ? Math.max(3, L.seatR) : L.seatR * 0.9), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.fillStyle = '#7a5600'; ctx.textAlign = 'center'; ctx.font = FONT(10); ctx.fillText(atDesk + ' checking in', TRK.x + TRK.w / 2, TRK.y + TRK.h - 10);
        ctx.font = FONT(11); return;
      }
      const ordered = sim.students.slice().sort((a, b) => (a.loc === 'seat') - (b.loc === 'seat'));
      for (let k = ordered.length - 1; k >= 0; k--) {
        const s = ordered[k]; const p = this.studentPos(s, tv); if (this.atTracker(s, tv)) atDesk++;
        ctx.fillStyle = this.studentColor(s); ctx.strokeStyle = 'rgba(0,0,0,.3)';
        ctx.beginPath(); ctx.arc(p.x, p.y, s.loc === 'seat' ? L.seatR * 0.9 : Math.max(3, L.seatR), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (s.holdFirm != null && !s.cAccepted && s.loc === 'seat') {
          const frac = Math.max(0, s.holdClock / sim.P.holdClock);
          ctx.strokeStyle = '#9a6c00'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(p.x, p.y, 7.2, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
        }
      }
      ctx.fillStyle = '#7a5600'; ctx.textAlign = 'center'; ctx.font = FONT(10); ctx.fillText(atDesk + ' checking in', TRK.x + TRK.w / 2, TRK.y + TRK.h - 10);
      // bubbles
      const now = performance.now();
      sim.bubbles = sim.bubbles.filter(b => { if (!this.bubbleSeen.has(b)) this.bubbleSeen.set(b, now); return now - this.bubbleSeen.get(b) < 1600; }).slice(-30);
      for (const b of sim.bubbles) {
        const s = sim.students[b.sid]; const p = this.studentPos(s, tv); const age = (now - this.bubbleSeen.get(b)) / 1600;
        ctx.globalAlpha = Math.max(0, 1 - age * age); ctx.font = FONT(10.5, 600);
        const tw = ctx.measureText(b.text).width + 10; const bx = Math.min(W - tw - 2, Math.max(2, p.x - tw / 2)), by = Math.max(12, p.y - 22 - age * 10);
        ctx.fillStyle = b.color; roundRect(ctx, bx, by - 8, tw, 16, 8); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(b.text, bx + tw / 2, by); ctx.globalAlpha = 1;
      }
      ctx.font = FONT(11);
    }
    hit(sim, tv, x, y, gd) {
      layoutFor(sim.P, sim.students.length);
      if (gd) {
        for (const s of sim.students) { const q = this.gdPos(sim, s, tv, gd); if (Math.hypot(q.p.x - x, q.p.y - y) < 5) return { type: 'gdstudent', s, q }; }
        for (let w = 0; w < L.wings.length; w++) for (let j = 0; j < L.gdN; j++) { const rr = gdRect(w, j); if (x >= rr.x && x <= rr.x + rr.w && y >= rr.y && y <= rr.y + rr.h) return { type: 'gdroom', wing: w, slot: j, group: gd.day[gd.mode].groups.find(g => g.wing === w && g.slot === j && tv >= g.start && tv < g.end) }; }
        if (x >= TRK.x && x <= TRK.x + TRK.w && y >= TRK.y && y <= TRK.y + TRK.h) return { type: 'tracker' };
        return null;
      }
      for (const s of sim.students) { const p = this.studentPos(s, tv); if (Math.hypot(p.x - x, p.y - y) < 7) return { type: 'student', s }; }
      for (let w = 0; w < L.wings.length; w++) for (let j = 0; j < L.gdN; j++) { const rr = gdRect(w, j); if (x >= rr.x && x <= rr.x + rr.w && y >= rr.y && y <= rr.y + rr.h) return { type: 'gdroom', wing: w, slot: j }; }
      if (sim.physRooms) for (const r of sim.physRooms.values()) { const rr = roomRect(r.wing, r.slot); if (x >= rr.x && x <= rr.x + rr.w && y >= rr.y && y <= rr.y + rr.h) return { type: 'room', r }; }
      if (x >= TRK.x && x <= TRK.x + TRK.w && y >= TRK.y && y <= TRK.y + TRK.h) return { type: 'tracker' };
      return null;
    }
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawPerson(ctx, x, y, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y - 7, 4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(x - 6, y + 9); ctx.quadraticCurveTo(x, y - 6, x + 6, y + 9); ctx.closePath(); ctx.fill(); }
  PS.Renderer = Renderer; PS.CANVAS_W = W; PS.CANVAS_H = H;
})(window.PS);
