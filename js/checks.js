/* Invariant checks and read-only diagnostics for experiments.
   attachChecks(sim, opts) wraps methods of ONE simulation instance. The wrappers only read state and call the original
   methods unchanged, so the simulation's behaviour and random draws are identical with or without them.
   Every finding is either a VIOLATION (a placement rule is broken) or an EXCEPTION (a legitimate operational outcome
   that looks like a rule breach, e.g. a GD that actually starts after 6 pm because earlier GDs overran). */
window.PS = window.PS || {};
(function (PS) {
  'use strict';

  PS.attachChecks = function (sim, opts) {
    opts = Object.assign({ invariants: true, truncation: false, handovers: true, maxRecords: 200 }, opts || {});
    const P = sim.P, proto = Object.getPrototypeOf(sim);
    const R = { violations: [], exceptions: [], counts: {}, excCounts: {}, truncation: null, handovers: null, gd: [] };
    const rec = (kind, rule, entities, state) => {
      const box = kind === 'violation' ? R.counts : R.excCounts; box[rule] = (box[rule] || 0) + 1;
      const list = kind === 'violation' ? R.violations : R.exceptions;
      if (list.length < opts.maxRecords) list.push({ seed: P.seed, mode: sim.mode, cluster: sim.cluster, t: sim.t, time: PS.fmtTime(Math.max(0, sim.t)), rule, entities, state });
    };
    const V = (rule, ent, st) => rec('violation', rule, ent, st), E = (rule, ent, st) => rec('exception', rule, ent, st);
    const sname = (s) => s.name + ' #' + s.id;
    const wrap = (name, fn) => { const orig = proto[name]; sim[name] = function (...a) { return fn.call(this, orig, a); }; };
    const lastRelease = new Map(); // room -> {t, buffer} when its firm left
    let acceptEvents = 0;

    if (opts.invariants) {
      // ---- calls: who may be sent to which panel, and when
      wrap('sendTo', function (orig, [s, f, panel, round]) {
        const t = this.t, rk = s.rank ? s.rank.get(f.idx) : null;
        const ent = { student: sname(s), firm: f.label, round };
        if (f.state !== 'open') V('call-firm-not-open', ent, { firmState: f.state });
        if (t >= P.softStop) V('call-after-soft-stop', ent, { t });
        if (s.loc !== 'seat') V('call-student-not-seated', ent, { loc: s.loc });
        for (const g of this.firms) for (const q of g.panels) if (q.student === s) V('student-double-booked', ent, { alsoWith: g.label });
        if (!s.active || s.status === 'final' || s.cAccepted) V('call-student-out-of-process', ent, { status: s.status, accepted: s.cAccepted, active: s.active });
        if (!f.onList.has(s.id)) V('call-student-not-on-list', ent, {});
        if (round === 1 && f.done.has(s.id)) V('round1-repeated', ent, {});
        if (round === 2 && !f.done.has(s.id)) V('round2-without-round1', ent, {});
        if (rk == null) V('call-unranked-role', ent, {});
        else {
          if (rk > s.maxRank) V(round === 2 ? 'round2-below-rejected-or-held' : 'call-below-rejected-or-held', ent, { rank: rk, maxRank: s.maxRank });
          if (s.holdFirm != null && !(rk < s.holdRank)) V(round === 2 ? 'round2-not-above-hold' : 'call-not-above-hold', ent, { rank: rk, holdRank: s.holdRank });
        }
        return orig.apply(this, [s, f, panel, round]);
      });
      // ---- decisions: no outright rejection in cluster 3 when the rule is on
      wrap('decide', function (orig, [s, f]) {
        const before = f.rejectsRecv; const r = orig.apply(this, [s, f]);
        if (P.finalNoReject && this.cluster === 3 && f.rejectsRecv > before) V('reject-in-cluster-3', { student: sname(s), firm: f.label }, {});
        return r;
      });
      wrap('accept', function (orig, a) { acceptEvents++; return orig.apply(this, a); });
      // ---- rooms: a firm takes a room only when it is free, the turnover has passed and the reuse rule allows it
      wrap('takeRoom', function (orig, [f, pr, waitForPlanned]) {
        const t = this.t, before = f.panels.length;
        if (waitForPlanned && pr && pr.from != null && t < pr.from) V('afternoon-panel-early', { firm: f.label }, { from: pr.from });
        const ok = orig.apply(this, [f, pr, waitForPlanned]);
        if (ok && f.panels.length > before) {
          const room = f.panels[f.panels.length - 1].room, lr = lastRelease.get(room);
          const ent = { firm: f.label, room: 'W' + PS.wingLabel(room.wing) + '/' + (room.slot + 1) };
          if (lr) {
            const earliest = (!room.buffer && lr.t <= P.reuseCloseBy) ? Math.max(P.reuseOpenFrom, lr.t + P.turnover) : lr.t + P.turnover;
            if (t < earliest) V('room-reused-too-early', ent, { released: lr.t, earliest });
          }
        }
        return ok;
      });
      wrap('closeFirm', function (orig, [f, why]) {
        const r = orig.apply(this, [f, why]);
        for (const p of f.panels) lastRelease.set(p.room, { t: this.t, buffer: p.room.buffer });
        if (why === 'filled' && this.count(f) < f.X) E('closed-filled-below-X', { firm: f.label }, { count: this.count(f), X: f.X });
        return r;
      });
      // ---- state checked after every minute
      wrap('step', function (orig, a) {
        const r = orig.apply(this, a);
        if (!this.firms || this.dayOver && this.t === 0) return r;
        const inPanel = new Map();
        for (const f of this.firms) {
          if (this.count(f) > f.X) V('hires-exceed-X', { firm: f.label }, { count: this.count(f), X: f.X });
          if (f.state === 'closed') for (const p of f.panels) if (p.room.firm === f) V('closed-firm-holds-room', { firm: f.label }, {});
          if (f.state === 'open' || f.state === 'closing') for (const p of f.panels) if (p.student) inPanel.set(p.student, (inPanel.get(p.student) || 0) + 1);
        }
        for (const [s, n] of inPanel) if (n > 1) V('student-in-two-panels', { student: sname(s) }, { panels: n });
        for (const s of this.students) {
          const n = inPanel.get(s) || 0;
          if ((s.loc === 'room' || s.loc === 'walkTo') && n === 0) V('student-in-room-without-panel', { student: sname(s) }, { loc: s.loc });
          if (s.loc === 'seat' && n > 0) V('seated-student-holds-panel', { student: sname(s) }, {});
        }
        const occ = new Map();
        for (const f of this.firms) if (f.state === 'open' || f.state === 'closing') for (const p of f.panels) occ.set(p.room, (occ.get(p.room) || 0) + 1);
        for (const [room, n] of occ) if (n > 1) V('room-shared', { room: 'W' + PS.wingLabel(room.wing) + '/' + (room.slot + 1) }, { holders: n });
        return r;
      });
      // ---- end-of-season accounting
      wrap('finish', function (orig, a) {
        const r = orig.apply(this, a);
        const S = PS.summarize(this), M = this.metrics;
        if (S.placed + S.unplaced !== this.students.length) V('placed-plus-unplaced', {}, { placed: S.placed, unplaced: S.unplaced, n: this.students.length });
        const net = (M.net[1] || 0) + (M.net[2] || 0) + (M.net[3] || 0);
        if (net !== S.placed) V('net-placements-mismatch', {}, { net, placed: S.placed });
        const gross = [1, 2, 3].reduce((x, k) => x + (M.clusters[k] ? M.clusters[k].grossOffers : 0), 0);
        if (gross !== acceptEvents) V('gross-offers-mismatch', {}, { gross, acceptEvents });
        for (const s of this.students) if (s.status === 'final' && s.offer == null) V('final-without-offer', { student: sname(s) }, {});
        return r;
      });
      // ---- one wing per role: in every plan, and for the panels actually opened on the day
      wrap('makeDecisions', function (orig, a) {
        const r = orig.apply(this, a); const d = this.decisions[this.cluster];
        if (d) for (const m of d.modes) for (const f of d.firms) { const ws = new Set((f.plans[m].rooms || []).filter(Boolean).map(x => x.wing)); if (ws.size > 1) V('plan-role-in-two-wings (' + m + ')', { firm: f.label, cluster: this.cluster }, { wings: [...ws].map(PS.wingLabel) }); }
        return r;
      });
      wrap('takeRoom', function (orig, a) {
        const r = orig.apply(this, a); const f = a[0]; const ws = new Set(f.panels.map(p => p.room.wing));
        if (ws.size > 1) V('day-role-in-two-wings', { firm: f.label }, { wings: [...ws].map(PS.wingLabel) });
        return r;
      });
      // ---- GD days: checked on both timetables as soon as they are built
      wrap('runGd', function (orig, a) {
        const r = orig.apply(this, a); const k = a[0], d = this.gdDays[k]; if (!d) return r;
        for (const m of ['baseline', 'optimised']) PS.checkGdDay(this, d, m, k, V, E);
        return r;
      });
    }

    // ---------------------------------------------------------------- diagnostic: top-eight truncation (read-only shadow solve)
    if (opts.truncation) {
      const T = R.truncation = { calls: 0, differ: 0, fullMatchedMore: 0, extraMatched: 0, scoreGap: 0, rows: 0, maxRows: 0, maxCols: 0, msK8: 0, msFull: 0, replicaMismatch: 0, sameObjective: 0 };
      let pending = null;
      wrap('assign', function (orig, a) {
        if (this.matchMode === 'baseline' || this.t >= P.softStop) return orig.apply(this, a);
        const free = []; for (const f of this.firms) if (f.state === 'open') for (const p of f.panels) if (!p.student) free.push({ f, p });
        if (!free.length) return orig.apply(this, a);
        this.soonFirms = this.firms.filter(g => g.state === 'open' && g.panels.some(q => q.student && q.endAt - this.t <= P.lookAhead));
        const avail = (s) => s.loc === 'seat' && !s.cAccepted && s.status !== 'final';
        const rowsAll = free.map(({ f, p }) => {
          const r2 = f.r2q.filter(id => this.round2Ok(f, this.students[id]));
          const c = []; for (const id of r2) { const s = this.students[id]; if (avail(s)) c.push({ s, round: 2 }); }
          for (const e of f.list) { const s = this.students[e.id]; if (avail(s) && this.eligible(f, s)) c.push({ s, round: 1 }); }
          return { f, p, all: c.map(x => ({ ...x, sc: this.candidateScore(f, x.s, p, x.round) })).sort((x, y) => y.sc - x.sc) };
        });
        const solve = (K) => {
          const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
          const cols = new Map(), rows = rowsAll.map(r => ({ ...r, sc: K ? r.all.slice(0, K) : r.all }));
          rows.forEach(r => r.sc.forEach(c => { if (!cols.has(c.s.id)) cols.set(c.s.id, cols.size); }));
          if (!cols.size) return { pairs: new Map(), score: 0, ms: 0, cols: 0 };
          const ids = [...cols.keys()], n = rows.length, m = Math.max(ids.length, n), BIG = 1e6;
          const cost = rows.map(() => new Array(m).fill(BIG)); rows.forEach((r, i) => r.sc.forEach(c => { cost[i][cols.get(c.s.id)] = 100 - c.sc; }));
          const ans = PS.hungarian(cost); const pairs = new Map(); let score = 0;
          ans.forEach((j, i) => { if (j < 0 || j >= ids.length || cost[i][j] >= BIG) return; const c = rows[i].sc.find(x => x.s.id === ids[j]); pairs.set(i, ids[j]); score += c.sc; });
          return { pairs, score, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0, cols: ids.length };
        };
        const a8 = solve(8), af = solve(0);
        T.calls++; T.rows += rowsAll.length; T.maxRows = Math.max(T.maxRows, rowsAll.length); T.maxCols = Math.max(T.maxCols, af.cols); T.msK8 += a8.ms; T.msFull += af.ms;
        let differ = a8.pairs.size !== af.pairs.size; if (!differ) for (const [i, j] of a8.pairs) if (af.pairs.get(i) !== j) { differ = true; break; }
        if (differ) T.differ++;
        if (af.pairs.size > a8.pairs.size) { T.fullMatchedMore++; T.extraMatched += af.pairs.size - a8.pairs.size; }
        T.scoreGap += af.score - a8.score; if (Math.abs(af.score - a8.score) < 1e-9) T.sameObjective++;
        // the real assignment must equal the K = 8 replica; count any mismatch (it would mean the shadow is not faithful)
        const sent = []; const os = this.sendTo; this.sendTo = function (s, f, p, round) { sent.push([p, s.id]); return os.call(this, s, f, p, round); };
        const res = orig.apply(this, a); this.sendTo = os;
        const replica = new Map([...a8.pairs].map(([i, j]) => [rowsAll[i].p, j]));
        if (sent.length !== replica.size || sent.some(([p, id]) => replica.get(p) !== id)) T.replicaMismatch++;
        return res;
      });
    }

    // ---------------------------------------------------------------- diagnostic: noon-handover panels, five outcomes
    if (opts.handovers) {
      const H = R.handovers = { records: [] }; const live = [];
      const bufferFree = (t) => { for (const r of sim.physRooms.values()) if (r.buffer && !r.firm && t >= r.freeAt) return true; return false; };
      wrap('openFirm', function (orig, [f]) {
        const r = orig.apply(this, [f]);
        for (const pr of (f.pendingRooms || [])) { if (pr.retry) continue; const o = { cluster: this.cluster, firm: f, pr, from: pr.from, opened: null, panel: null, used: false, outcome: null, dueRoomState: null, bufferFreeAtDue: null }; live.push(o); H.records.push(o); }
        return r;
      });
      const prevTake = sim.takeRoom;
      sim.takeRoom = function (f, pr, w) {
        const before = f.panels.length; const ok = prevTake.call(this, f, pr, w);
        if (w && ok && f.panels.length > before) { const o = live.find(x => x.pr === pr && x.firm === f && x.opened == null); if (o) { o.opened = this.t; o.panel = f.panels[f.panels.length - 1]; } }
        return ok;
      };
      const prevSend = sim.sendTo;
      sim.sendTo = function (s, f, p, round) { const o = live.find(x => x.panel === p); if (o) o.used = true; return prevSend.call(this, s, f, p, round); };
      const prevStep = sim.step;
      sim.step = function () {
        const t = this.t; const r = prevStep.call(this);
        for (const o of live) {
          if (o.outcome) continue;
          const f = o.firm;
          if (t === o.from && o.opened == null) {
            const room = this.physRooms.get(o.pr.wing * 100 + o.pr.slot);
            o.dueRoomState = room.firm ? 'occupied by ' + room.firm.name : (t < room.freeAt ? 'in turnover' : 'free');
            o.bufferFreeAtDue = bufferFree(t);
          }
          if (o.opened != null) {
            if (f.state === 'closed') o.outcome = o.used ? (o.opened - o.from <= 1 ? 'on time' : 'delayed') : 'lost on the day';
            continue;
          }
          if (!f.pendingRooms || !f.pendingRooms.includes(o.pr)) {
            const filled = f.state === 'closing' || (f.state === 'closed' && f.closeWhy === 'filled');
            if (filled) o.outcome = 'unnecessary: firm filled';
            else if (f.state === 'closed' && f.actualClose < o.from) o.outcome = 'unnecessary: list exhausted';
            else o.outcome = 'failed: room never came free';
            o.resolvedAt = t;
          }
        }
        return r;
      };
      const prevEndDay = sim.endDay;
      sim.endDay = function () {
        const r = prevEndDay.call(this);
        for (const o of live) if (!o.outcome) {
          if (o.opened != null) o.outcome = o.used ? (o.opened - o.from <= 1 ? 'on time' : 'delayed') : 'lost on the day';
          else o.outcome = (o.firm.closeWhy === 'filled') ? 'unnecessary: firm filled' : 'failed: room never came free';
        }
        live.length = 0; return r;
      };
      H.summary = () => {
        const out = { total: H.records.length }; const by = {};
        for (const o of H.records) by[o.outcome || 'unresolved'] = (by[o.outcome || 'unresolved'] || 0) + 1;
        out.byOutcome = by;
        const del = H.records.filter(o => o.outcome === 'delayed').map(o => o.opened - o.from);
        out.delay = del.length ? { n: del.length, mean: del.reduce((a, b) => a + b, 0) / del.length, max: Math.max(...del), over60: del.filter(x => x > 60).length } : { n: 0 };
        const cf = H.records.filter(o => o.outcome === 'delayed' || (o.outcome || '').startsWith('failed'));
        out.bufferFreeAtDue = { delayedOrFailed: cf.length, bufferWasFree: cf.filter(o => o.bufferFreeAtDue).length };
        out.dueRoomState = {}; for (const o of cf) { const k = (o.dueRoomState || 'n/a').startsWith('occupied') ? 'occupied by morning firm' : (o.dueRoomState || 'n/a'); out.dueRoomState[k] = (out.dueRoomState[k] || 0) + 1; }
        return out;
      };
    }
    sim.checks = R;
    return R;
  };

  // GD day invariants for one timetable
  PS.checkGdDay = function (sim, d, m, k, V, E) {
    const P = sim.P, x = d[m], eps = 1e-6, byComp = new Map(), byStudent = new Map(), byRoom = new Map();
    const comp = new Map(d.companies.map(c => [c.name, c]));
    for (const g of x.groups) {
      if (!byComp.has(g.comp)) byComp.set(g.comp, []); byComp.get(g.comp).push(g);
      const rk = g.wing * 100 + g.slot; if (!byRoom.has(rk)) byRoom.set(rk, []); byRoom.get(rk).push(g);
      for (const id of g.members) { if (!byStudent.has(id)) byStudent.set(id, []); byStudent.get(id).push(g); }
    }
    const tag = (rule) => 'gd-' + rule + ' (' + m + ')';
    for (const c of d.companies) {
      const gs = byComp.get(c.name) || []; const seen = new Set(); let dup = 0;
      for (const g of gs) for (const id of g.members) { if (seen.has(id)) dup++; seen.add(id); }
      if (dup) V(tag('student-twice-in-company'), { company: c.name, cluster: k }, { dup });
      if (seen.size !== c.invited) V(tag('invitee-not-placed-once'), { company: c.name, cluster: k }, { placed: seen.size, invited: c.invited });
      const wings = new Set(gs.map(g => g.wing)); if (wings.size > 1) V(tag('company-in-two-wings'), { company: c.name, cluster: k }, { wings: [...wings].map(PS.wingLabel) });
      const rooms = new Set(gs.map(g => g.wing * 100 + g.slot)); if (rooms.size > P.gdMaxRooms) V(tag('too-many-panels'), { company: c.name, cluster: k }, { rooms: rooms.size });
      for (const g of gs) {
        if (g.size > c.max) V(tag('group-too-large'), { company: c.name, cluster: k }, { size: g.size, max: c.max });
        if (g.size < c.min) {
          const forced = c.invited < c.min || Math.floor(c.invited / gs.length) < c.min;
          (forced ? E : V)(tag(forced ? 'small-group-forced-by-invitee-count' : 'group-too-small'), { company: c.name, cluster: k }, { size: g.size, min: c.min, invited: c.invited, groups: gs.length });
        }
      }
      const pc = x.perComp.find(q => q.name === c.name);
      // a late (buffer) GD is allowed but undesirable: it must run two panels unless its invitees make a single group
      if (pc && pc.plannedStart != null && pc.plannedStart > P.gdLatestStart) {
        const single = Math.ceil(c.invited / c.max) <= 1 && Math.floor(c.invited / 2) < c.min;
        if (pc.panels >= 2 || single) E(tag(pc.panels >= 2 ? 'late-buffer-gd-two-panels' : 'late-buffer-gd-single-group'), { company: c.name, cluster: k }, { plannedStart: PS.fmtTime(pc.plannedStart), panels: pc.panels });
        else V(tag('late-gd-one-panel'), { company: c.name, cluster: k }, { plannedStart: PS.fmtTime(pc.plannedStart), groups: pc.groups });
      }
      if (pc && pc.start != null && pc.start > P.gdLatestStart && !(pc.plannedStart > P.gdLatestStart)) E(tag('started-after-latest-start-by-overrun'), { company: c.name, cluster: k }, { start: PS.fmtTime(Math.round(pc.start)), plannedStart: PS.fmtTime(pc.plannedStart) });
      if (pc && pc.start != null && pc.plannedStart != null && pc.start < pc.plannedStart - eps) V(tag('block-started-before-timetable'), { company: c.name, cluster: k }, {});
    }
    for (const [id, gs] of byStudent) {
      gs.sort((a, b) => a.start - b.start);
      for (let i = 1; i < gs.length; i++) if (gs[i].start < gs[i - 1].end + P.transit - eps) V(tag('student-clash-or-no-walk'), { student: '#' + id, cluster: k }, { a: gs[i - 1].comp, aEnd: gs[i - 1].end, b: gs[i].comp, bStart: gs[i].start });
    }
    for (const [rk, gs] of byRoom) {
      gs.sort((a, b) => a.start - b.start);
      for (let i = 1; i < gs.length; i++) {
        const gap = gs[i].start - gs[i - 1].end, need = gs[i].comp === gs[i - 1].comp ? P.gdTurnover : P.gdSwitch;
        if (gap < need - eps) V(tag(gs[i].comp === gs[i - 1].comp ? 'group-turnover-short' : 'company-changeover-short'), { room: rk, cluster: k }, { gap: Math.round(gap), need });
      }
    }
  };
})(window.PS);
