/* Placement scheduler simulation engine.
   Time is measured in minutes after 8:00 am (0 = 8:00, 240 = 12:00, 840 = 10:00 pm). */
window.PS = window.PS || {};
(function (PS) {
  'use strict';

  // ------------------------------------------------------------------ defaults
  PS.DEFAULT_PARAMS = {
    seed: 288,
    nStudents: 400,
    pApplyAll: 0.8,
    applyMean: 0.9,
    applySd: 0.0333,
    applyMin: 0.8,
    applyMax: 1,
    prefNoise: 4.5,
    tieShare: 0.3,
    firmNoise: 10,
    confHot: 1,
    confList: 2,
    compHot: 2,
    compList: 5,
    defHot: 4.5,
    defList: 15,
    stratTopPct: 0.1,
    stratBottomPct: 0.4,
    stratLean: 0.6,
    pOfferHot1: 0.9,
    pOfferShort1: 0.3,
    pR2Hot: 0.9,
    pR2Short: 0.5,
    pOfferHot2: 0.95,
    pOfferShort2: 0.8,
    acceptAnchorPct: 0.2,
    acceptAnchorVal: 0.2,
    rejectAnchorPct: 0.8,
    rejectAnchorVal: 0.2,
    holdClock: 120,
    transit: 2,
    dreamShare: 0.33,
    dreamMaxTotal: 3,
    dreamMaxPerCluster: 2,
    roomsPerWingPlanned: 10,
    roomsPerWingBuffer: 4,
    wings: 9,
    turnover: 30,
    reuseCloseBy: 210,
    reuseOpenFrom: 240,
    lateSlotTime: 240,
    openLatest: 480,
    softStop: 840,
    hardStop: 1020,
    planBuffer: 1.25,
    targetWindow: 150,
    laterOpenMid: 30,
    laterOpenLow: 90,
    lookAhead: 15,
    lookAheadPenalty: 0.6,
    prefBeta: 3,
    holdUrgency: 1,
    idleBonus: 0.01,
    extensions: 1,
    maxExtensions: 20,
    finalNoReject: 1,
    targetGross: 1,
    planImprove: 1,
    minimiseWings: 1,
    wingSlack: 0.02,
    earlyPenalty: 10,
    openFromPrefs: 1,
    shortlistWeight: 0.3333,
    gdOn: 1,
    gdSizeMin: 7,
    gdSizeMax: 10,
    gdCv: 0.15,
    gdTurnover: 10,
    gdRoomsPerWing: 2,
    gdMaxRooms: 2,
    gdDayEnd: 930,
    gdBuffer: 180,
    gdNoise: 2,
    gdConfList: 1.5,
    gdInviteMult: 2,
    gdSwitch: 60,
    gdLatestStart: 600,
    gdPopWeight: 2,
    gdRestarts: 12,
    rngMode: 0,
  };


  // repair clock values saved by older versions (times after midnight were read as morning)
  PS.CLOCK_KEYS = ['reuseCloseBy', 'reuseOpenFrom', 'lateSlotTime', 'openLatest', 'softStop', 'hardStop', 'gdDayEnd', 'gdLatestStart'];
  PS.sanitizeParams = function (P) {
    for (const k of PS.CLOCK_KEYS) { if (typeof P[k] !== 'number' || isNaN(P[k])) P[k] = PS.DEFAULT_PARAMS[k]; if (P[k] < 0) P[k] += 1440; }
    if (P.hardStop <= P.softStop) P.hardStop = P.softStop + 180;
    for (const k in PS.DEFAULT_PARAMS) if (typeof P[k] !== 'number' || isNaN(P[k])) P[k] = PS.DEFAULT_PARAMS[k];
    return P;
  };

  // ------------------------------------------------------------------ blocks and floors (blocks A and B on the ground floor, C-E on the first, F-I on the second)
  PS.WING_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  PS.FLOOR_NAMES = ['Ground floor', 'First floor', 'Second floor'];
  PS.wingLabel = (w) => w < PS.WING_LABELS.length ? PS.WING_LABELS[w] : String.fromCharCode(65 + w);
  PS.wingFloor = (w) => (w < 2 ? 0 : w < 5 ? 1 : 2);
  PS.roomName = (r) => r ? 'Block ' + PS.wingLabel(r.wing) + ' · room ' + (r.slot + 1) : 'buffer room';
  PS.roomsText = (rooms, open) => {
    const by = new Map(); let buf = 0;
    for (const r of rooms) { if (!r) { buf++; continue; } if (!by.has(r.wing)) by.set(r.wing, []); by.get(r.wing).push(r); }
    const parts = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([w, sl]) => 'Block ' + PS.wingLabel(w) + ': ' + sl.sort((a, b) => a.slot - b.slot).map(r => (r.slot + 1) + (open != null && r.from != null && r.from > open ? ' from ' + PS.fmtTime(r.from) : '')).join(', '));
    if (buf) parts.push(buf + ' buffer');
    return parts.join(' · ');
  };

  // ------------------------------------------------------------------ rng
  function RNG(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const r = { next };
    r.uni = (lo, hi) => lo + (hi - lo) * next();
    r.normal = () => { let u = 0, v = 0; while (u === 0) u = next(); while (v === 0) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    r.pick = (arr) => arr[Math.floor(next() * arr.length)];
    r.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
    return r;
  }
  PS.RNG = RNG;

  // Event-keyed random numbers (common random numbers). A draw is a hash of (seed, stream tag, entity ids), so the same
  // event gets the same luck in every mode, whatever order events happen in. Stable characteristics (preferences,
  // strength, CV and GD signals, applications, ties, list strategy) are keyed by entity; outcomes that may later depend
  // on scheduling context (interview lengths, round-2 progression, offers, decisions, extension order) are keyed by the
  // (student, firm, round) event. With rngMode = 0 the original single stream is used, so earlier results reproduce exactly.
  const K = { util: 1, strength: 2, apply: 3, share: 4, tie: 5, tie2: 6, strat: 7, cv: 8, ccv: 9, gd: 10, len: 11, r2: 12, offer: 13, dec: 14, ext: 15, gddur: 16 };
  PS.RNG_TAGS = K;
  function mix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16; return h >>> 0; }
  function keyHash(seed, args) { let h = mix32((seed >>> 0) ^ 0x9e3779b9); for (let i = 0; i < args.length; i++) h = mix32(h ^ mix32(((args[i] | 0) + Math.imul(i + 1, 0x632be5ab)) >>> 0)); return h; }
  function keyU(seed, ...args) { return (keyHash(seed, args) + 0.5) / 4294967296; }
  function keyN(seed, ...args) { const u = keyU(seed, ...args, 0x51ed27), v = keyU(seed, ...args, 0x2a9f5b); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function strHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }
  PS.keyU = keyU; PS.keyN = keyN; PS.strHash = strHash;

  // ------------------------------------------------------------------ hungarian (rows <= cols, minimise cost)
  function hungarian(cost) {
    const n = cost.length, m = cost[0].length, INF = 1e18;
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0; const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const ans = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
    return ans;
  }
  PS.hungarian = hungarian;

  // ------------------------------------------------------------------ helpers
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  PS.fmtTime = (t) => { const m = Math.round(t) + 480; const h = Math.floor(m / 60) % 24, mm = m % 60; const ap = h >= 12 ? 'pm' : 'am'; const h12 = ((h + 11) % 12) + 1; return h12 + ':' + String(mm).padStart(2, '0') + ' ' + ap; };
  PS.parseTime = (s) => { if (s === '' || s == null) return null; const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i); if (!m) return null; let h = +m[1]; const mm = +m[2]; if (m[3]) { const pm = m[3].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } let v = h * 60 + mm - 480; if (v < 0) v += 1440; return v; };

  function acceptRejectHold(P, q) {
    const sa = P.acceptAnchorPct / Math.sqrt(-Math.log(P.acceptAnchorVal));
    const sr = (1 - P.rejectAnchorPct) / Math.sqrt(-Math.log(P.rejectAnchorVal));
    const pA = Math.exp(-Math.pow(q / sa, 2));
    const pR = Math.min(Math.exp(-Math.pow((1 - q) / sr, 2)), 1 - pA);
    return { pA, pR, pH: Math.max(0, 1 - pA - pR) };
  }
  PS.acceptRejectHold = acceptRejectHold;

  // ------------------------------------------------------------------ build scenario (roles with overrides, cohort map)
  PS.buildRoles = function (overrides, cohortMap) {
    // overrides: { roleId: {field: value} } edits to listed roles, plus
    //   __added: [role objects] new roles, __removed: [roleIds] dropped roles, __students: student roster edits
    const ov = overrides || {}; const removed = new Set(ov.__removed || []);
    const roles = PS.ROLES.filter(r => !removed.has(r.id)).map(r => Object.assign({}, r, ov[r.id] || {}))
      .concat((ov.__added || []).filter(r => !removed.has(r.id)).map(r => Object.assign({}, r)));
    roles.forEach((role, i) => {
      role.idx = i;
      role.cluster = +role.clusterFix || (cohortMap && cohortMap[role.cohort]) || PS.COHORT_CLUSTER[role.cohort] || 3;
    });
    roles.studentEdits = ov.__students || null;
    return roles;
  };
  PS.isUserKey = (k) => !k.startsWith('__');

  // ------------------------------------------------------------------ the simulation
  class Sim {
    constructor(params, roles, mode) {
      this.P = PS.sanitizeParams(Object.assign({}, PS.DEFAULT_PARAMS, params || {}));
      this.roles = roles; this.mode = mode || 'optimised';
      // a mode fixes the pre-day plan and the live matching separately (2x2 design); the three original modes keep their meaning
      const MODES = { baseline: ['baseline', 'baseline'], optimised: ['optimised', 'optimised'], manual: ['manual', 'optimised'],
        'bplan-omatch': ['baseline', 'optimised'], 'oplan-bmatch': ['optimised', 'baseline'] };
      [this.planMode, this.matchMode] = MODES[this.mode] || MODES.optimised;
      this.rng = RNG(this.P.seed); this.crn = +this.P.rngMode === 1;
      this.log = []; this.bubbles = [];
      this.cluster = 0; this.t = 0; this.dayOver = true; this.finished = false;
      this.metrics = { clusters: {}, dreamConversions: 0 }; this.decisions = {}; this.gdDays = {};
      this.listeners = [];
      this.initStudents();
    }

    emit(text, kind) { this.log.push({ cluster: this.cluster, t: this.t, text, kind: kind || 'info' }); if (this.log.length > 4000) this.log.splice(0, 1000); }

    initStudents() {
      const P = this.P, R = this.roles;
      const E = R.studentEdits || {}; const edits = E.edits || {}; const removed = new Set(E.removed || []); const added = E.added || [];
      const make = (s, key, e) => {
        const util = new Float64Array(R.length); const z = new Float64Array(R.length);
        for (let r = 0; r < R.length; r++) { z[r] = this.rn(K.util, s, r); util[r] = R[r].pop / 10 + z[r] * P.prefNoise; }
        let strength = this.rn(K.strength, s);
        const st = { id: 0, key, name: PS.studentName(s), strength, util, status: 'unplaced', offer: null, offerCluster: 0,
          dreamApps: [], loc: 'seat', moveStart: 0, moveEnd: 0, room: null, holdFirm: null, holdRank: 0, holdClock: 0, finalRankBucket: null, applyShare: null, edited: false };
        if (e) {
          st.edited = true;
          if (e.name != null && String(e.name).trim()) st.name = String(e.name).trim();
          if (typeof e.strength === 'number' && isFinite(e.strength)) st.strength = e.strength;
          const sig = (typeof e.prefNoise === 'number' && isFinite(e.prefNoise)) ? Math.max(0, e.prefNoise) : P.prefNoise;
          const bonus = (typeof e.favBonus === 'number' && isFinite(e.favBonus)) ? e.favBonus : 0;
          for (let r = 0; r < R.length; r++) util[r] = R[r].pop / 10 + z[r] * sig + (e.favCohort && R[r].cohort === e.favCohort ? bonus : 0);
          if (typeof e.applyShare === 'number' && isFinite(e.applyShare)) st.applyShare = clamp(e.applyShare, 0.01, 1);
        }
        return st;
      };
      this.students = [];
      for (let s = 0; s < P.nStudents; s++) { const st = make(s, 'b' + s, edits['b' + s]); if (!removed.has('b' + s)) this.students.push(st); }
      added.forEach((e, j) => { if (!removed.has(e.key)) this.students.push(make(P.nStudents + j, e.key, e)); });
      this.students.forEach((st, i) => { st.id = i; });
    }

    // ---------------------------------------------------------------- cluster setup: applications, preferences, shortlists, plan
    startCluster(k) {
      const P = this.P, rng = this.rng, R = this.roles;
      this.cluster = k; this.t = 0; this.dayOver = false; this.bubbles = [];
      const roleIdx = R.filter(r => r.cluster === k).map(r => r.idx);
      // popularity percentile within cluster
      const pops = roleIdx.map(i => R[i].pop).sort((a, b) => a - b);
      const pct = (v) => { let c = 0; for (const x of pops) if (x < v) c++; return pops.length > 1 ? c / (pops.length - 1) : 1; };

      // firms
      this.firms = roleIdx.map(i => {
        const r = R[i];
        return { idx: i, role: r, name: r.company, hashKey: r.hashKey || r.company, label: r.company + ' – ' + r.role, X: Math.max(1, Math.round(r.X)), popPct: Math.min(1, pct(r.pop)),
          applicants: [], list: [], onList: new Map(), state: 'planned', accepted: 0, held: new Set(), panels: [], r2q: [],
          done: new Set(), interviews: 0, offers: 0, rejectsRecv: 0, holdsReleased: 0, lostHires: 0, lostToDream: 0, idle: 0, extensions: 0,
          planOpen: 0, planPanels: 1, planRooms: [], planClose: 0, actualOpen: null, actualClose: null, bufferRooms: 0 };
      });
      this.firmByRole = new Map(this.firms.map(f => [f.idx, f]));

      // applications and cluster preference lists
      for (const s of this.students) {
        s.cAccepted = false; s.apps = null; s.rank = null; s.nRanked = 0; s.maxRank = Infinity; s.holdFirm = null; s.holdRank = 0; s.holdClock = 0; s.loc = 'seat'; s.room = null; s.busyFirm = null;
        if (s.status === 'unplaced') {
          let chosen;
          const sorted = roleIdx.slice().sort((a, b) => s.util[b] - s.util[a]);
          const uApply = this.ru(K.apply, s.id, k);
          if (s.applyShare != null) chosen = sorted.slice(0, Math.max(1, Math.round(s.applyShare * sorted.length)));
          else if (uApply < P.pApplyAll) chosen = sorted;
          else { const share = clamp(P.applyMean + this.rn(K.share, s.id, k) * P.applySd, P.applyMin, P.applyMax); chosen = sorted.slice(0, Math.max(1, Math.round(share * sorted.length))); }
          // ranks with tied groups of up to 3
          const pStart = P.tieShare / Math.max(0.01, 2.5 - 1.5 * P.tieShare);
          const rank = new Map(); let pos = 0;
          while (pos < chosen.length) {
            let g = 1; if (this.ru(K.tie, s.id, k, pos) < pStart) g = this.ru(K.tie2, s.id, k, pos) < 0.5 ? 2 : 3;
            g = Math.min(g, chosen.length - pos);
            for (let j = 0; j < g; j++) rank.set(chosen[pos + j], pos + 1);
            pos += g;
          }
          s.apps = new Set(chosen); s.rank = rank; s.nRanked = chosen.length; s.active = true;
        } else if (s.status === 'dreaming') {
          const mine = s.dreamApps.filter(i => R[i].cluster === k);
          s.apps = new Set(mine); s.rank = new Map(mine.map(i => [i, 1])); s.nRanked = mine.length; s.active = mine.length > 0;
        } else { s.active = false; s.apps = new Set(); s.rank = new Map(); }
        if (s.active) for (const i of s.apps) this.firmByRole.get(i).applicants.push(s.id);
      }

      // shortlists by each firm's strategy
      for (const f of this.firms) {
        const r = f.role; let hm, lm, strat = r.strategy || 'auto';
        if (strat === 'auto') {
          const u = this.ru(K.strat, f.idx), lean = P.stratLean, other = (1 - lean) / 2;
          if (f.popPct >= 1 - P.stratTopPct) strat = u < lean ? 'confident' : 'competing';
          else if (f.popPct <= P.stratBottomPct) strat = u < lean ? 'defensive' : 'competing';
          else strat = u < lean ? 'competing' : (u < lean + other ? 'confident' : 'defensive');
        }
        f.strategy = strat;
        if (strat === 'confident') { hm = P.confHot; lm = P.confList; } else if (strat === 'competing') { hm = P.compHot; lm = P.compList; } else { hm = P.defHot; lm = P.defList; }
        if (r.hotMult) hm = +r.hotMult; if (r.listMult) lm = +r.listMult;
        const scored = f.applicants.map(id => ({ id, sc: this.students[id].strength + this.rn(K.cv, id, f.idx) * P.firmNoise })).sort((a, b) => b.sc - a.sc);
        const nList = Math.min(scored.length, Math.max(Math.round(hm * f.X), Math.round(lm * f.X)));
        const nHot = Math.min(nList, Math.round(hm * f.X));
        f.list = scored.slice(0, nList).map((x, j) => ({ id: x.id, hot: j < nHot }));
        f.list.forEach(e => f.onList.set(e.id, e));
        f.hotSize = nHot; f.listSize = nList;
      }
      if (k >= 2 && P.gdOn) this.runGd(k);
      // student tracker: who is in this cluster's pool, and as what
      this.poolInfo = this.poolInfo || {};
      const pi = { total: 0, noOffer: 0, dreamers: 0 };
      for (const st of this.students) {
        st.hist = st.hist || []; st.rounds = st.rounds || {};
        if (!st.active) { st.rounds[k] = { pool: 'out' }; continue; }
        let hot = 0, short = 0; for (const f of this.firms) { const e = f.onList.get(st.id); if (e) { if (e.hot) hot++; else short++; } }
        const dreaming = st.status === 'dreaming';
        st.rounds[k] = { pool: dreaming ? 'dreaming' : 'noOffer', apps: st.nRanked, hot, short };
        pi.total++; if (dreaming) pi.dreamers++; else pi.noOffer++;
      }
      this.poolInfo[k] = pi;
      this.makeDecisions();
      this.plan(this.planMode);
      this.emit('Cluster ' + k + ' begins: ' + this.firms.length + ' roles, ' + this.poolInfo[k].total + ' students in the pool (' + this.poolInfo[k].noOffer + ' with no offer yet, ' + this.poolInfo[k].dreamers + ' dreaming in).', 'head');
    }

    // ---------------------------------------------------------------- group discussions (the day before clusters 2 and 3)
    // Firms with a GD invite their whole CV shortlist (one GD process per company, covering all its roles). Attendance is
    // compulsory. After the GD each role becomes one step more confident and rebuilds its preferred list and shortlist from
    // attendees, ranked on a sharper GD signal. Which students are selected does not depend on when their GD was held,
    // so the GD timetable is scheduled separately (its own random stream) and judged on its own metrics.
    runGd(k) {
      const P = this.P, rng = this.rng; const comps = new Map();
      for (const f of this.firms) {
        if (!f.role.gd) continue;
        let c = comps.get(f.name);
        if (!c) { c = { name: f.name, hashKey: f.hashKey || f.name, firms: [], len: 0, min: Infinity, max: Infinity, pop: 0, invitees: [] }; comps.set(f.name, c); }
        c.firms.push(f); c.len = Math.max(c.len, +f.role.gdLen || 30); c.pop = Math.max(c.pop, f.role.pop);
        if (f.role.gdMin) c.min = Math.min(c.min, +f.role.gdMin); if (f.role.gdMax) c.max = Math.min(c.max, +f.role.gdMax);
      }
      const C = [...comps.values()];
      for (const c of C) {
        c.min = isFinite(c.min) ? c.min : P.gdSizeMin; c.max = Math.max(c.min, isFinite(c.max) ? c.max : P.gdSizeMax);
        // One GD shortlist for the whole company: everyone who applied to any of its GD roles is screened once on one CV score.
        // The GD is the first cut, so the company calls gdInviteMult times the shortlists its roles would otherwise draw
        // (and at least one full group); the interview lists are then cut from GD attendees, one step more confident.
        const seen = new Set(), pool = new Set(); let seats = 0;
        for (const f of c.firms) { seats += f.listSize; for (const e of f.list) seen.add(e.id); for (const id of f.applicants) pool.add(id); }
        c.roleListsSum = seats; c.roleListsUnion = seen.size; c.pool = pool.size;
        const ch = strHash(c.hashKey || c.name); const cv = [...pool].map(id => ({ id, sc: this.students[id].strength + this.rn(K.ccv, id, ch) * P.firmNoise })).sort((a, b) => b.sc - a.sc);
        c.invitees = cv.slice(0, Math.min(cv.length, Math.max(Math.round(seats * P.gdInviteMult), Math.round(P.gdSizeMax)))).map(x => x.id); // at least one full group
        const gdScore = new Map(); for (const id of c.invitees) gdScore.set(id, this.students[id].strength + P.firmNoise * P.gdNoise * this.rn(K.gd, id, ch));
        c.gdScore = gdScore;
        for (const f of c.firms) {
          f.cvStrategy = f.strategy; f.cvHot = f.hotSize; f.cvList = f.listSize; f.gd = true; f.gdScore = gdScore;
          const r = f.role; let hm, lm, strat;
          if (f.strategy === 'defensive') { strat = 'competing after GD'; hm = P.compHot; lm = P.compList; }
          else if (f.strategy === 'competing') { strat = 'confident after GD'; hm = P.confHot; lm = P.confList; }
          else { strat = 'confident ' + P.gdConfList + 'X after GD'; hm = P.confHot; lm = P.gdConfList; }
          if (r.hotMult) hm = +r.hotMult; if (r.listMult) lm = Math.min(+r.listMult, lm);
          const att = f.applicants.filter(id => gdScore.has(id)).sort((a, b) => gdScore.get(b) - gdScore.get(a));
          const nList = Math.min(att.length, Math.max(Math.round(hm * f.X), Math.round(lm * f.X)));
          const nHot = Math.min(nList, Math.round(hm * f.X));
          f.list = att.slice(0, nList).map((id, j) => ({ id, hot: j < nHot })); f.onList = new Map(f.list.map(e => [e.id, e]));
          f.hotSize = nHot; f.listSize = nList; f.strategy = strat;
        }
      }
      const live = C.filter(c => c.invitees.length);
      const day = { companies: live.map(c => ({ name: c.name, roles: c.firms.length, invited: c.invitees.length, pool: c.pool, roleListsSum: c.roleListsSum, roleListsUnion: c.roleListsUnion, len: c.len, min: c.min, max: c.max, pop: c.pop,
        after: c.firms.map(f => ({ label: f.label, cv: f.cvStrategy + ' ' + f.cvHot + ' / ' + f.cvList, gd: f.strategy + ' ' + f.hotSize + ' / ' + f.listSize })) })) };
      day.baseline = this.scheduleGd(live, 'baseline', k);
      day.optimised = this.scheduleGd(live, 'optimised', k);
      day.lowerBound = this.gdLowerBound(live);
      this.gdDays[k] = day;
      { // student tracker: each invitee's GD (or a missed one) and which of the company's roles listed them afterwards
        const use = day[this.planMode === 'baseline' && this.matchMode === 'baseline' ? 'baseline' : 'optimised'];
        const where = new Map(); for (const g of use.groups) for (const id of g.members) where.set(g.comp + '|' + id, g);
        for (const c of live) for (const id of c.invitees) {
          const st = this.students[id]; st.hist = st.hist || []; const g = where.get(c.name + '|' + id);
          const lists = c.firms.map(f => { const e = f.onList.get(id); return e ? f.role.role + (e.hot ? ' (preferred list)' : ' (standard list)') : null; }).filter(Boolean);
          st.hist.push({ k, type: 'GD', company: c.name, sent: g ? g.start - P.transit : null, start: g ? g.start : null, end: g ? g.end : null, back: g ? g.end + P.transit : null,
            wing: g ? g.wing : null, slot: g ? g.slot : null, size: g ? g.size : null,
            outcome: !g ? 'Invited, no group formed' : lists.length ? 'Listed for ' + lists.join(', ') : 'Not listed after GD' });
        }
      }
      this.emit('GD day before cluster ' + k + ': ' + live.length + ' companies, ' + live.reduce((a, c) => a + c.invitees.length, 0) + ' GD invitations.', 'head');
    }

    // GD panel decision for one company. Baseline (today): two panels whenever there are two or more groups.
    // Optimised: two panels only if the invitees split into an even number of groups within the size limits, so both
    // panels run the same number of groups and neither panel's members sit idle; otherwise one panel.
    gdPanelPlan(c, mode) {
      const P = this.P, n = c.invitees.length, G1 = Math.max(1, Math.ceil(n / c.max));
      const kMax = Math.max(1, Math.min(P.gdMaxRooms, P.gdRoomsPerWing));
      let G = G1, k = 1;
      if (mode === 'baseline') k = Math.min(kMax, G);
      else if (mode === 'late') { // late buffer GD: two panels whenever the invitees make two or more groups, an even count if the size limits allow
        if (kMax >= 2) { for (let g = Math.max(2, G1); g <= Math.max(2, G1) + 2; g++) if (g % 2 === 0 && Math.floor(n / g) >= Math.min(c.min, n)) { G = g; break; } k = Math.min(2, G); }
      }
      else if (kMax >= 2) for (let g = Math.max(2, G1); g <= G1 + 2; g++) if (g % 2 === 0 && Math.floor(n / g) >= Math.min(c.min, n)) { G = g; k = 2; break; }
      const sizes = []; for (let i = 0; i < G; i++) sizes.push(Math.floor(n / G) + (i < n % G ? 1 : 0));
      return { G, k, sizes, block: Math.ceil(G / k) * (c.len + P.gdTurnover) - P.gdTurnover };
    }

    gdLowerBound(C) {
      const P = this.P, R = P.wings * P.gdRoomsPerWing; let perComp = 0, roomMin = 0; const load = new Map();
      for (const c of C) {
        const pl = this.gdPanelPlan(c, 'optimised'), rounds = Math.ceil(pl.G / pl.k);
        perComp = Math.max(perComp, rounds * c.len + (rounds - 1) * P.gdTurnover);
        roomMin += pl.k * (rounds * c.len + (rounds - 1) * P.gdTurnover);
        for (const id of c.invitees) { const l = load.get(id) || { n: 0, m: 0 }; l.n++; l.m += c.len; load.set(id, l); }
      }
      let perStudent = 0; for (const l of load.values()) perStudent = Math.max(perStudent, l.m + (l.n - 1) * P.transit);
      // every room hosts its companies back to back with the company changeover between them
      const total = (roomMin + Math.max(0, C.length - R) * P.gdSwitch) / R;
      return { value: Math.max(total, perComp, perStudent), byRooms: total, byFirm: perComp, byStudent: perStudent, maxGdsPerStudent: Math.max(0, ...[...load.values()].map(l => l.n)) };
    }

    // Block scheduling of the GD day. A company gets k panels (1 or 2) in ONE block (its the placement committee volunteer cannot move
    // between blocks) and runs its groups there as one sitting. A room is handed to the next company only gdSwitch minutes
    // after the previous company's last group in it; between groups of the same company the room needs gdTurnover.
    // Both modes first build a timetable (which company, which block, when, and who sits in which group), then the day is
    // played out minute by minute with random GD lengths: a group starts once its room is ready and all its members are free.
    scheduleGd(C, mode, k) {
      const P = this.P, rng = RNG((P.seed + 1) * 7919 + k * 104729);
      const R = P.gdRoomsPerWing, wings = []; for (let w = 0; w < P.wings; w++) { wings.push([]); for (let j = 0; j < R; j++) wings[w].push({ wing: w, slot: j, idx: w * R + j }); }
      const S = C.map(c => ({ c, pl: this.gdPanelPlan(c, mode), planned: [], plannedStart: null, plannedEnd: null, wing: null }));
      const roomQ = wings.flat().map(() => []);
      if (mode === 'baseline') {
        // today's practice: company sittings in popularity order, the next company in a room timetabled gdBuffer after the
        // block's planned end; groups made in list order and dealt to the company's panels in turn
        // if the buffer would push a company past the latest start, the placement committee squeezes it in after the one-hour gap instead
        const plan = roomQ.map(() => 0), tight = roomQ.map(() => 0);
        for (const st of S.slice().sort((a, b) => b.c.pop - a.c.pop)) {
          const pick = (arr) => { let best = null; for (const W of wings) { const rs = W.slice().sort((a, b) => arr[a.idx] - arr[b.idx]).slice(0, st.pl.k); if (rs.length < st.pl.k) continue; const t0 = Math.max(...rs.map(r => arr[r.idx])); if (!best || t0 < best.t0) best = { t0, rs }; } return best; };
          let best = pick(plan); if (best.t0 > P.gdLatestStart) { const b2 = pick(tight); if (b2.t0 < best.t0) best = b2; }
          st.plannedStart = best.t0; st.plannedEnd = best.t0 + st.pl.block; st.wing = best.rs[0].wing;
          best.rs.forEach(r => { plan[r.idx] = st.plannedEnd + Math.max(P.gdBuffer, P.gdSwitch); tight[r.idx] = st.plannedEnd + P.gdSwitch; });
          let i = 0; st.pl.sizes.forEach((sz, g) => { const m = st.c.invitees.slice(i, i + sz); i += sz; const r = best.rs[g % st.pl.k]; roomQ[r.idx].push({ st, members: m, at: best.t0 }); });
        }
      } else {
        // optimised timetable, built by a greedy insertion heuristic run from several company orders (multi-start):
        // each company in turn takes the earliest start, in 5-minute steps, at which some block has its panels free AND every
        // invitee can be placed in one of its rounds without clashing with GDs already timetabled (a b-matching of students
        // to rounds, solved by augmenting paths). Rounds are spaced at the GD length plus one standard deviation, plus
        // turnover, so the timetable absorbs most overruns. The order that finishes earliest is kept.
        const load = new Map(); for (const st of S) for (const id of st.c.invitees) load.set(id, (load.get(id) || 0) + 1);
        const prng = RNG((P.seed + 7) * 31337 + k);
        const keys = [st => st.c.invitees.reduce((a, id) => a + load.get(id), 0) / st.c.invitees.length, st => st.c.pop, st => st.c.pop / st.pl.block, st => -st.pl.block, st => st.pl.block, st => st.c.invitees.length];
        const orders = keys.map(f => S.slice().sort((a, b) => f(b) - f(a) || b.c.invitees.length - a.c.invitees.length));
        for (let x = 0; x < P.gdRestarts; x++) { const o = orders[x % 2].slice(); for (let i = o.length - 1; i > 0; i--) { if (prng.next() < 0.35) { const j = Math.floor(prng.next() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } } orders.push(o); }
        const planWith = (seq, margin) => {
          const roomBusy = roomQ.map(() => []), busy = new Map(), Q = roomQ.map(() => []), info = new Map(); let makespan = 0, late = 0, wStart = 0, wSum = 0;
          for (const st of seq) {
            const c = st.c, inv = c.invitees, Lp = Math.ceil(c.len * (1 + margin)), step = Lp + P.gdTurnover;
            const search = (pl) => {
            const k = pl.k, rounds = Math.ceil(pl.G / k);
            const cap = []; for (let r = 0; r < rounds; r++) cap.push(pl.sizes.slice(r * k, r * k + k).reduce((a, b) => a + b, 0));
            let done = null;
            for (let t = 0; t <= 2400 && !done; t += tStep) {
              const opts = [];
              // a room can take this block if it keeps the company changeover gap to every block already in it (gaps can be back-filled)
              const pEnd0 = t + rounds * step - P.gdTurnover;
              const fits = (r) => roomBusy[r.idx].every(([a, b]) => b + P.gdSwitch <= t || pEnd0 + P.gdSwitch <= a);
              const prevEnd = (r) => Math.max(-1e9, ...roomBusy[r.idx].filter(([, b]) => b <= t).map(([, b]) => b));
              for (const W of wings) { const rs = W.filter(fits).sort((a, b) => prevEnd(b) - prevEnd(a)).slice(0, k); if (rs.length === k) opts.push(rs); }
              if (!opts.length) continue;
              const starts = []; for (let r = 0; r < rounds; r++) starts.push(t + r * step);
              const avail = inv.map(id => { const iv = busy.get(id) || []; return starts.map(s0 => iv.every(([a, b]) => !(s0 < b + P.transit && a < s0 + Lp + P.transit))); });
              if (avail.some(v => !v.some(Boolean))) continue;
              const order = inv.map((_, i) => i).sort((a, b) => avail[a].filter(Boolean).length - avail[b].filter(Boolean).length || load.get(inv[b]) - load.get(inv[a])); // students with more GDs go to earlier rounds
              const mem = starts.map(() => []);
              const tryS = (i, seen) => {
                for (let r = 0; r < rounds; r++) { if (!avail[i][r] || seen[r]) continue; seen[r] = 1;
                  if (mem[r].length < cap[r]) { mem[r].push(i); return true; }
                  for (let q = 0; q < mem[r].length; q++) { if (tryS(mem[r][q], seen)) { mem[r][q] = i; return true; } } }
                return false;
              };
              let ok = true; for (const i of order) if (!tryS(i, new Array(rounds).fill(0))) { ok = false; break; }
              if (!ok) continue;
              // best fit: the block whose panels came free most recently, leaving earlier-free blocks for others
              const rs = opts.sort((a, b) => Math.min(...b.map(prevEnd)) - Math.min(...a.map(prevEnd)))[0];
              done = { t, rs, mem, starts };
            }
            return done;
            };
            // a company that cannot start by the latest start time is a late (buffer) GD: allowed, but only with two
            // panels so it is over quickly (one panel only if its invitees make a single group)
            let pl = st.pl, done = search(pl), lateTwo = false;
            if (done && done.t > P.gdLatestStart && pl.k < 2) { const pl2 = this.gdPanelPlan(c, 'late'); if (pl2.k === 2) { const d2 = search(pl2); if (d2) { pl = pl2; done = d2; lateTwo = true; } } }
            if (!done) return null;
            const k = pl.k;
            const { t, rs, mem, starts } = done, pEnd = t + starts.length * step - P.gdTurnover;
            info.set(st, { plannedStart: t, plannedEnd: pEnd, wing: rs[0].wing, pl, lateGd: t > P.gdLatestStart, lateTwo }); makespan = Math.max(makespan, pEnd);
            if (t > P.gdLatestStart) late++; const wp = Math.pow(st.c.pop / 100, 4); wStart += wp * t; wSum += wp;
            rs.forEach(r => { roomBusy[r.idx].push([t, pEnd]); });
            mem.forEach((ids, r) => {
              const sizes = pl.sizes.slice(r * k, r * k + k); let i = 0; ids.sort((a, b) => a - b);
              sizes.forEach((sz, p) => { const m = ids.slice(i, i + sz).map(x => inv[x]); i += sz; if (!m.length) return; Q[rs[p].idx].push({ st, members: m, at: starts[r] });
                m.forEach(id => { if (!busy.has(id)) busy.set(id, []); busy.get(id).push([starts[r], starts[r] + Lp]); }); });
            });
          }
          // cost: no company may start after gdLatestStart (hard, so it dominates), then the finish of the day plus a
          // reputation term: popular companies should open early. The term is the mean start time weighted by
          // (popularity/100)^4, which puts most of the weight on the best-known names, times gdPopWeight.
          return { Q, info, makespan, late, lateSet: [...info].filter(([, v]) => v.plannedStart > P.gdLatestStart).map(([q]) => q), cost: late * 1e6 + makespan + P.gdPopWeight * wStart / Math.max(1e-9, wSum) };
        };
        let best = null; this.gdPlansTried = 0;
        let margin = P.gdCv, tStep = 5;
        const consider = (o) => { const pl = planWith(o, margin); this.gdPlansTried++; if (pl && (!best || pl.cost < best.cost)) { best = pl; best.order = o; best.margin = margin; } };
        const repair = () => { // while some company is timetabled after the latest start, move the late ones to the front and rebuild
          for (let it = 0; it < 8 && best && best.late > 0; it++) { const lateSet = new Set(best.lateSet); consider(best.order.filter(q => lateSet.has(q)).concat(best.order.filter(q => !lateSet.has(q)))); if (best.late > 0) consider(orders[0].filter(q => lateSet.has(q)).concat(orders[0].filter(q => !lateSet.has(q)))); }
        };
        orders.forEach(consider); repair();
        // still infeasible: drop the overrun allowance (rounds spaced at the mean GD length) and try again
        if (best && best.late > 0) { margin = 0; orders.forEach(consider); repair(); }
        if (best && best.late > 0) { tStep = 1; orders.slice(0, 6).forEach(consider); repair(); }
        best.Q.forEach((q, i) => { roomQ[i] = q; });
        for (const [st, v] of best.info) Object.assign(st, v);
        this.gdPlanStarts = orders.length;
      }
      roomQ.forEach(q => q.sort((a, b) => a.at - b.at));
      for (const st of S) st.lateGd = st.plannedStart != null && st.plannedStart > P.gdLatestStart;
      // ---- play the day out
      const free = new Map(); for (const c of C) for (const id of c.invitees) free.set(id, 0);
      const crn = this.crn, gseed = P.seed, gcount = new Map();
      const dur = (c) => { const i = (gcount.get(c.name) || 0); gcount.set(c.name, i + 1); return Math.max(0.5 * c.len, c.len * (1 + P.gdCv * (crn ? keyN(gseed, K.gddur, k, strHash(c.hashKey || c.name), i) : rng.normal()))); };
      const rooms = wings.flat().map(r => ({ ...r, busy: null, readyAt: 0, lastComp: null, lastEnd: -1e9 }));
      const groups = []; let clashWait = 0, clashGroups = 0;
      for (let t = 0; t < 3000; t++) {
        let pending = false;
        for (const r of rooms) {
          if (r.busy && t >= r.busy.end) { r.readyAt = r.busy.end + P.gdTurnover; r.lastEnd = r.busy.end; r.busy = null; }
          if (r.busy) { pending = true; continue; }
          const q = roomQ[r.idx]; if (!q.length) continue; pending = true;
          const g = q[0], st = g.st;
          if (t < r.readyAt || t < (st.plannedStart || 0)) continue;
          if (r.lastComp && r.lastComp !== st && t < r.lastEnd + P.gdSwitch) continue;
          if (t < g.at && mode === 'optimised' && t < (st.firstStart != null ? 0 : g.at)) continue; // a block opens at its timetabled time
          if (g.members.some(id => free.get(id) > t)) { if (t >= g.at) { clashWait++; if (!g.waited) { g.waited = true; clashGroups++; } } continue; }
          q.shift(); const d = dur(st.c), end = t + d;
          g.members.forEach(id => free.set(id, end + P.transit));
          r.busy = { end }; r.lastComp = st; groups.push({ comp: st.c.name, room: r, start: t, end, size: g.members.length, members: g.members.slice(), st });
          if (st.firstStart == null) st.firstStart = t;
        }
        if (!pending) break;
      }
      // panel idle: each panel's members stay until their company's last GD ends
      for (const st of S) {
        const gs = groups.filter(g => g.st === st); st.groups = gs.length; st.start = gs.length ? Math.min(...gs.map(g => g.start)) : null; st.end = gs.length ? Math.max(...gs.map(g => g.end)) : 0;
        const used = new Set(gs.map(g => g.room)); st.idle = 0;
        for (const r of used) { const mine = gs.filter(g => g.room === r); st.idle += Math.max(0, (st.end - st.start) - mine.reduce((a, g) => a + g.end - g.start, 0) - (mine.length - 1) * P.gdTurnover); }
        st.idle += Math.max(0, st.pl.k - used.size) * (st.end - st.start);
        st.left = st.c.invitees.length - gs.reduce((a, g) => a + g.size, 0);
      }
      const end = Math.max(0, ...groups.map(g => g.end));
      return {
        end, groups: groups.map(g => ({ comp: g.comp, wing: g.room.wing, slot: g.room.slot, start: g.start, end: g.end, size: g.size, members: g.members })),
        nGroups: groups.length, clashWait, clashGroups, lateGroups: groups.filter(g => g.end > P.gdDayEnd).length,
        panelIdle: S.reduce((a, st) => a + st.idle, 0), panelTime: S.reduce((a, st) => a + (st.end != null && st.start != null ? st.pl.k * (st.end - st.start) : 0), 0),
        util: (() => { const pt = S.reduce((a, st) => a + (st.end != null && st.start != null ? st.pl.k * (st.end - st.start) : 0), 0); return pt ? 100 * (1 - S.reduce((a, st) => a + st.idle, 0) / pt) : 0; })(), twoPanel: S.filter(st => st.pl.k === 2).length,
        latePlanned: S.filter(st => st.lateGd).length, lateTwoPanel: S.filter(st => st.lateGd && st.pl.k === 2).length, lateOnePanel: S.filter(st => st.lateGd && st.pl.k < 2).length, lateActual: S.filter(st => st.start != null && st.start > P.gdLatestStart).length,
        roomHours: groups.reduce((a, g) => a + (g.end - g.start), 0) / 60,
        perComp: S.map(st => ({ name: st.c.name, start: st.start, end: st.end, groups: st.groups, panels: st.pl.k, wing: st.wing, rooms: st.pl.k, maxRooms: st.pl.k, idle: Math.round(st.idle), left: st.left, plannedStart: st.plannedStart, plannedEnd: st.plannedEnd, late: !!st.lateGd })),
      };
    }

    // ---------------------------------------------------------------- expected interviews and panels (used by optimised plan)
    expectInterviews(f) {
      const P = this.P; let sum = 0, n = 0; const target = f.X * P.planBuffer;
      for (const e of f.list) {
        const s = this.students[e.id];
        const po = f.role.inter === 2 ? (e.hot ? P.pR2Hot * P.pOfferHot2 : P.pR2Short * P.pOfferShort2) : (e.hot ? P.pOfferHot1 : P.pOfferShort1);
        let pah = 1;
        if (s.status === 'unplaced' && !P.targetGross) { const rk = s.rank.get(f.idx) || s.nRanked; const q = s.nRanked > 1 ? (rk - 1) / (s.nRanked - 1) : 0; const d = acceptRejectHold(P, q); pah = d.pA + d.pH; }
        sum += po * pah; n++; if (sum >= target) break;
      }
      return Math.max(1, n);
    }
    meanDuration(f) { const r = f.role; let d = (r.i1min + r.i1max) / 2; if (r.inter === 2) d += 0.6 * (r.i2min + r.i2max) / 2; return d + 2 * this.P.transit; }


    // ---------------------------------------------------------------- opening times from preferences (release dates)
    // A shortlisted student is "ready" for firm f once they are likely to have finished every interview with a firm
    // they rank above f (a release date in scheduling terms). A free preferred candidate counts as 1 and a free
    // shortlisted candidate as shortlistWeight (default 1/3). Firm f opens at the first half-hour by which its free
    // candidates add up to one preferred list-equivalent per planned panel: N panels open on N free preferred candidates,
    // or on 3N free standard-list ones, or any mix worth N.
    computeReleaseTimes() {
      const P = this.P, F = this.firms;
      for (const f of F) {
        f.optK = clamp(Math.ceil(f.expInt * f.meanDur / P.targetWindow), 1, Math.max(1, Math.floor(f.listSize / 3)));
        f.pos = new Map(f.list.map((e, i) => [e.id, i])); f.releaseTime = 0;
      }
      const onLists = new Map();
      for (const g of F) for (const e of g.list) { if (!onLists.has(e.id)) onLists.set(e.id, []); onLists.get(e.id).push(g); }
      for (let iter = 0; iter < 4; iter++) {
        for (const f of F) {
          const ready = [];
          for (const e of f.list) {
            const s = this.students[e.id]; const rf = s.rank.get(f.idx); if (rf == null) continue;
            let seq = 0, last = 0;
            for (const g of onLists.get(e.id) || []) {
              if (g === f) continue; const rg = s.rank.get(g.idx); if (rg == null || rg >= rf) continue;
              const pos = g.pos.get(e.id); if (pos >= g.expInt) continue; // g is likely to fill before reaching this student
              const call = g.releaseTime + Math.floor(pos / g.optK) * g.meanDur;
              seq += g.meanDur; last = Math.max(last, call + g.meanDur);
            }
            ready.push({ t: Math.max(seq, last), w: e.hot ? 1 : P.shortlistWeight, hot: e.hot });
          }
          ready.sort((a, b) => a.t - b.t);
          const total = ready.reduce((a, r) => a + r.w, 0);
          const need = Math.max(Math.min(1, total), Math.min(f.optK, total));
          let acc = 0, t = 0;
          for (const r of ready) { acc += r.w; t = r.t; if (acc >= need - 1e-3) break; } // tolerance: three shortlisted at 0.3333 count as one preferred
          f.releaseTime = clamp(Math.floor(t / 30) * 30, 0, P.openLatest);
          f.releaseNeed = need; f.hotAt8 = ready.filter(r => r.t <= 0 && r.hot).length; f.shortAt8 = ready.filter(r => r.t <= 0 && !r.hot).length;
          f.readyAt8 = f.hotAt8 + P.shortlistWeight * f.shortAt8;
        }
      }
    }

    // ---------------------------------------------------------------- pre-day plan
    plan(mode) {
      mode = mode || this.planMode;
      const P = this.P, F = this.firms, wings = P.wings, pw = P.roomsPerWingPlanned;
      for (const f of F) { f.fixedOpen = false; f.unplaced = false; f.planRooms = []; f.planPanels = 1; f.planOpen = 0; f.planClose = 0; }
      const planned = []; for (let w = 0; w < wings; w++) for (let j = 0; j < pw; j++) planned.push({ wing: w, slot: j, bookings: [] });
      this.plannedRooms = planned;
      for (const f of F) { f.expInt = this.expectInterviews(f); f.meanDur = this.meanDuration(f); f.planWing = null; f.handsOver = false; }
      this.packStats = null;

      if (mode === 'baseline') {
        // today's practice: everyone opens at 8 am with panels in proportion to list size and keeps its rooms until filled.
        // Firms are seated in popularity order, each in the first block with enough free rooms (first fit, one block per role).
        // If no block has that many rooms left, the firm goes to the block with most rooms left and its other panels use
        // that block's buffer rooms on the day.
        const total = F.reduce((a, f) => a + f.listSize, 0) || 1; const cap = planned.length;
        F.forEach(f => { f.planPanels = clamp(Math.round(cap * f.listSize / total), 1, pw); });
        let sum = F.reduce((a, f) => a + f.planPanels, 0);
        const byPanels = F.slice().sort((a, b) => b.planPanels - a.planPanels);
        while (sum > cap && byPanels[0].planPanels > 1) { byPanels.sort((a, b) => b.planPanels - a.planPanels); byPanels[0].planPanels--; sum--; }
        const freeIn = []; for (let w = 0; w < wings; w++) freeIn.push(planned.filter(r => r.wing === w));
        for (const f of F.slice().sort((a, b) => b.role.pop - a.role.pop)) {
          f.planOpen = 0; f.planRooms = [];
          let w = freeIn.findIndex(x => x.length >= f.planPanels);
          if (w < 0) { w = 0; freeIn.forEach((x, i) => { if (x.length > freeIn[w].length) w = i; }); }
          f.planWing = freeIn[w].length ? w : null;
          for (let j = 0; j < f.planPanels; j++) { const r = freeIn[w].shift(); if (r) { f.planRooms.push({ wing: r.wing, slot: r.slot }); r.bookings.push({ firm: f, start: 0, end: 9999 }); } else f.planRooms.push(null); }
          f.planClose = Math.round(f.expInt * f.meanDur / f.planPanels);
        }
        return;
      }
      // optimised (and manual, which starts from it): panels by Little's law, opening times from release dates, then the
      // firms are packed into blocks (one block per role) and the packing is improved
      if (P.openFromPrefs) this.computeReleaseTimes();
      for (const f of F) {
        const flowCap = Math.max(1, Math.floor(f.listSize / 3));
        f.optPanels = clamp(Math.ceil(f.expInt * f.meanDur / P.targetWindow), 1, Math.min(flowCap, pw));
        f.desired = P.openFromPrefs ? f.releaseTime : (f.popPct >= 0.5 ? 0 : (f.popPct >= 0.25 ? P.laterOpenMid : P.laterOpenLow));
        if (f.role.late) f.desired = Math.max(f.desired, P.lateSlotTime);
        if (mode === 'manual') {
          const mo = PS.parseTime(f.role.manualOpen); if (mo != null) { f.desired = clamp(Math.round(mo / 30) * 30, 0, P.openLatest); f.fixedOpen = true; }
          if (f.role.manualPanels) f.optPanels = clamp(Math.round(+f.role.manualPanels), 1, pw);
        }
      }
      // the same cluster and mode always give the same packing (makeDecisions plans every mode, then the run's own mode
      // is planned again), so the result is kept for the cluster
      const ck = this.cluster + ':' + mode + ':' + F.map(f => f.optPanels + '/' + f.desired + '/' + Math.round(f.expInt * f.meanDur) + (f.fixedOpen ? 'f' : '')).join(',');
      let res = this.packCache && this.packCache.key === ck ? this.packCache.res : null;
      if (!res) { res = this.packWings(F, mode); this.packCache = { key: ck, res }; }
      res.snap.apply();
      planned.length = 0; res.snap.rooms.forEach(r => planned.push(r)); this.plannedRooms = planned;
      this.planStats = res.improve; this.packStats = res.stats;
    }

    // ---------------------------------------------------------------- one-block packing of the pre-day plan
    // Two-dimensional bin packing with shelves. A block is a bin: roomsPerWingPlanned rooms (its width) by the day (its
    // height). A firm with k panels for D minutes is a k x D rectangle that must sit inside one block, because its the placement committee
    // volunteer stays in one block. A room holds at most two bookings, a morning one that ends by reuseCloseBy and an
    // afternoon one from reuseOpenFrom, so every block has a morning shelf and an afternoon shelf; an all-day booking
    // takes a room on both shelves. Construction is best-fit decreasing with bottom-left placement: firms are taken in a
    // given order (largest area first, and other orders), and each goes to the (block, panels, start) with the lowest
    // cost, the earliest start at or after its release for every block and panel count; ties go to a block already in use
    // (so new blocks are opened only when needed), then to the block left with the least free room-time (best fit). Each
    // packing is improved inside its blocks (savings for noon handovers, earlier openings, panel moves). The best order is
    // kept, and then the number of blocks is cut one at a time while the plan's cost stays within wingSlack of the best.
    packWings(F, mode) {
      const P = this.P, pw = P.roomsPerWingPlanned, nWings = P.wings;
      const W = f => f.expInt * f.meanDur;
      const durOf = (f, k) => Math.ceil(W(f) / k / 30) * 30;
      const costAt = (f, C, open) => f.X * (C + 10 * Math.max(0, C - P.softStop)) + P.earlyPenalty * f.X * Math.max(0, f.desired - open);
      const fits = (r, t, end) => {
        if (r.bookings.length === 0) return true;
        if (r.bookings.length >= 2) return false;
        const b = r.bookings[0];
        if (b.start < t) return b.end <= P.reuseCloseBy && t >= Math.max(P.reuseOpenFrom, b.end + P.turnover);
        return end <= P.reuseCloseBy && b.start >= Math.max(P.reuseOpenFrom, end + P.turnover);
      };
      const freeTime = (r) => { // room-minutes still bookable before the soft stop
        if (!r.bookings.length) return P.softStop; if (r.bookings.length >= 2) return 0;
        const b = r.bookings[0];
        if (b.end <= P.reuseCloseBy) return Math.max(0, P.softStop - Math.max(P.reuseOpenFrom, b.end + P.turnover));
        if (b.start >= P.reuseOpenFrom) return Math.max(0, Math.min(P.reuseCloseBy, b.start - P.turnover));
        return 0;
      };
      const snapshot = (rooms) => {
        const firms = F.map(f => ({ f, planOpen: f.planOpen, planPanels: f.planPanels, planClose: f.planClose, unplaced: f.unplaced, planWing: f.planWing, handsOver: !!f.handsOver, planRooms: f.planRooms.map(r => r ? Object.assign({}, r) : null) }));
        const rs = rooms.map(r => ({ wing: r.wing, slot: r.slot, bookings: r.bookings.map(b => Object.assign({}, b)) }));
        return { rooms: rs, apply() { for (const x of firms) Object.assign(x.f, { planOpen: x.planOpen, planPanels: x.planPanels, planClose: x.planClose, unplaced: x.unplaced, planWing: x.planWing, handsOver: x.handsOver, planRooms: x.planRooms.map(r => r ? Object.assign({}, r) : null) }); } };
      };
      const morning = f => f.desired < P.reuseOpenFrom;
      // stage 1, block assignment: longest processing time first (Graham's LPT rule for balancing machines). Firms are
      // taken by workload, largest first, and each goes to the least-loaded block that still has a room free for it at the
      // start of its window (at most pw firms open in a block before noon, and at most pw after it). Balancing matters
      // because a block's small morning firms hand their rooms to its large firm at noon.
      const assign = (nW, order) => {
        const load = new Array(nW).fill(0), am = new Array(nW).fill(0), pm = new Array(nW).fill(0), wingOf = new Map();
        for (const f of order) {
          let best = -1;
          for (let w = 0; w < nW; w++) {
            if (morning(f) ? am[w] >= pw : pm[w] >= pw) continue;
            if (best < 0 || load[w] < load[best] - 1e-9) best = w;
          }
          if (best < 0) { // more firms than rooms: with fewer blocks this cut is refused; with every block open the firm joins
            if (nW < nWings) return null; // the least-loaded block and starts in one of its buffer rooms if no room comes free
            best = 0; for (let w = 1; w < nW; w++) if (load[w] < load[best] - 1e-9) best = w;
          }
          wingOf.set(f, best); load[best] += W(f); if (morning(f)) am[best]++; else pm[best]++;
        }
        return { wingOf, load };
      };
      // stage 2, inside each block: one panel per firm at the earliest time at or after its release (bottom-left), then
      // extra panels up to the Little's-law number for the firms with the most interview-minutes per panel, then the
      // improvement moves (noon handovers, earlier openings, panel moves), all inside the block
      const schedule = (wingOf) => {
        const rooms = []; for (let w = 0; w < nWings; w++) for (let j = 0; j < pw; j++) rooms.push({ wing: w, slot: j, bookings: [] });
        let unplaced = 0;
        for (const f of F) { f.planRooms = []; f.unplaced = false; f.handsOver = false; f.planWing = wingOf.get(f); }
        for (const f of F.slice().sort((a, b) => a.desired - b.desired || W(b) - W(a))) {
          const R = rooms.slice(f.planWing * pw, (f.planWing + 1) * pw), dur = durOf(f, 1), tMax = f.fixedOpen ? f.desired : P.openLatest;
          let done = false;
          for (let t = f.desired; t <= tMax && !done; t += 30) {
            const fr = R.filter(r => fits(r, t, t + dur)).sort((a, b) => b.bookings.length - a.bookings.length || a.slot - b.slot);
            if (!fr.length) continue;
            fr[0].bookings.push({ firm: f, start: t, end: t + dur }); fr[0].bookings.sort((x, y) => x.start - y.start);
            f.planOpen = t; f.planPanels = 1; f.planClose = t + dur; f.planRooms = [{ wing: fr[0].wing, slot: fr[0].slot, from: t }]; done = true;
          }
          if (!done) { unplaced++; f.unplaced = true; f.planOpen = f.desired; f.planPanels = 1; f.planRooms = [null]; f.planClose = f.desired + dur; }
        }
        for (let added = true, guard = 0; added && guard < 1000; guard++) {
          added = false;
          const need = F.filter(f => !f.unplaced && f.planPanels < f.optPanels).sort((a, b) => W(b) / b.planPanels - W(a) / a.planPanels);
          for (const f of need) {
            const k = f.planPanels + 1, end = f.planOpen + durOf(f, k);
            const R = rooms.slice(f.planWing * pw, (f.planWing + 1) * pw);
            const ok = (r) => { if (r.bookings.some(b => b.firm === f)) return false; return fits(r, f.planOpen, end); };
            const cand = R.filter(ok).sort((a, b) => b.bookings.length - a.bookings.length);
            if (!cand.length) continue;
            const r = cand[0]; r.bookings.push({ firm: f, start: f.planOpen, end }); r.bookings.sort((x, y) => x.start - y.start);
            R.forEach(rr => rr.bookings.forEach(b => { if (b.firm === f) b.end = end; }));
            f.planRooms.push({ wing: r.wing, slot: r.slot, from: f.planOpen }); f.planPanels = k; f.planClose = end;
            added = true; break;
          }
        }
        return { rooms, unplaced };
      };
      const evaluate = (nW, order) => {
        const A = assign(nW, order); if (!A) return null;
        const { rooms, unplaced } = schedule(A.wingOf);
        const improve = P.planImprove ? this.improvePlan(rooms) : null;
        const z = (improve ? improve.z1 : F.reduce((a, f) => a + (f.unplaced ? 0 : costAt(f, f.planClose, f.planOpen)), 0)) + unplaced * 1e7;
        const wingsUsed = new Set(F.filter(f => !f.unplaced).map(f => f.planWing)).size;
        const lastClose = Math.max(0, ...F.map(f => f.planClose));
        return { z, unplaced, wingsUsed, lastClose, improve, snap: snapshot(rooms), nW, load: A.load };
      };
      const orders = {
        'workload, largest first': F.slice().sort((a, b) => W(b) - W(a) || a.desired - b.desired),
        'hires, most first': F.slice().sort((a, b) => b.X - a.X || W(b) - W(a)),
      };
      const bestAt = (nW) => { let b = null; for (const [name, o] of Object.entries(orders)) { const r = evaluate(nW, o); if (r && (!b || r.z < b.z - 1e-6)) { b = r; b.order = name; } } return b; };
      // lower bounds on blocks: room-minutes (every interview-minute fits in pw rooms before the soft stop) and room count
      // (firms that open before noon need a room each)
      const wingLB = Math.max(1, Math.ceil(F.reduce((a, f) => a + W(f), 0) / (pw * P.softStop)), Math.ceil(F.filter(morning).length / pw), Math.ceil(F.filter(f => !morning(f)).length / pw));
      const full = bestAt(nWings); let chosen = full; const cuts = [];
      if (+P.minimiseWings && full) {
        const ok = (r) => r && r.unplaced <= full.unplaced && r.z <= full.z * (1 + P.wingSlack) + 1e-6;
        for (let nW = nWings - 1; nW >= wingLB; nW--) {
          const b = bestAt(nW); cuts.push({ wings: nW, z: b ? Math.round(b.z) : null, ok: ok(b) });
          if (!ok(b)) break; chosen = b;
        }
      }
      const tried = Object.keys(orders);
      return { snap: chosen.snap, improve: chosen.improve, stats: { order: chosen.order, orders: tried, wingsAvailable: nWings, wingsBest: full.wingsUsed, zBest: Math.round(full.z), wingsUsed: chosen.wingsUsed, z: Math.round(chosen.z), wingLB, cuts, slack: P.wingSlack, load: chosen.load.map(Math.round) } };
    }

    // ---------------------------------------------------------------- improvement phase on the optimised plan
    // A savings heuristic (Clarke-Wright) fills noon-handover rooms with extra afternoon panels; an Or-opt style time
    // move opens small firms earlier so their room can be handed over; an Or-opt style relocation moves single panels
    // between firms whenever the weighted completion of the plan falls. Every move stays inside one block.
    improvePlan(planned) {
      const P = this.P;
      const F = this.firms.filter(f => !f.unplaced && f.planRooms.length && f.planRooms.every(r => r));
      const byKey = new Map(planned.map(r => [r.wing * 100 + r.slot, r]));
      const r30 = t => Math.ceil(t / 30 - 1e-9) * 30;
      const W = f => f.expInt * f.meanDur;
      const cap = f => Math.max(1, Math.floor(f.listSize / 3));
      // completion of workload W with panels starting at the given times
      const comp = (f, starts) => {
        const st = starts.slice().sort((a, b) => a - b); let rem = W(f);
        for (let i = 0; i < st.length; i++) {
          const rate = i + 1, next = i + 1 < st.length ? st[i + 1] : Infinity;
          if (rate * (next - st[i]) >= rem) return st[i] + rem / rate;
          rem -= rate * (next - st[i]);
        }
        return st[st.length - 1];
      };
      const costAt = (f, C, open) => f.X * (C + 10 * Math.max(0, C - P.softStop)) + P.earlyPenalty * f.X * Math.max(0, f.desired - open);
      F.forEach(f => f.planRooms.forEach(r => { if (r.from == null) r.from = f.planOpen; }));
      const exact = new Map(F.map(f => [f, comp(f, f.planRooms.map(r => r.from))]));
      const z = () => F.reduce((a, f) => a + costAt(f, exact.get(f), f.planOpen), 0);
      const setEnd = (f, C) => {
        exact.set(f, C); f.planClose = r30(C); f.planPanels = f.planRooms.length;
        for (const r of f.planRooms) { const b = byKey.get(r.wing * 100 + r.slot).bookings.find(x => x.firm === f); if (b) b.end = f.planClose; }
      };
      const stats = { z0: z(), savings: 0, shifts: 0, relocations: 0 };
      // value of giving firm g an extra panel from time a
      const gain = (g, a) => {
        if (g.planRooms.length >= cap(g) || g.planOpen > a) return null;
        const C0 = exact.get(g); if (C0 <= a + 30) return null;
        const C1 = comp(g, g.planRooms.map(x => x.from).concat([a]));
        return { sav: costAt(g, C0, g.planOpen) - costAt(g, C1, g.planOpen), C1 };
      };
      const handoverSlots = () => {
        const out = [];
        for (const r of planned) if (r.bookings.length === 1 && r.bookings[0].end <= P.reuseCloseBy) {
          const a = r30(Math.max(P.reuseOpenFrom, r.bookings[0].end + P.turnover));
          if (a <= P.openLatest) out.push({ r, a });
        }
        return out;
      };
      // 1. savings list: each handover room goes to the firm with the largest saving, largest first
      const savingsStep = () => {
        for (let guard = 0; guard < 500; guard++) {
          let best = null; const seen = new Set();
          for (const { r, a } of handoverSlots()) {
            const key = a + ':' + r.wing; if (seen.has(key)) continue; seen.add(key);
            for (const g of F) { if (g.planWing !== r.wing) continue; const v = gain(g, a); if (v && (!best || v.sav > best.sav)) best = { ...v, g, r, a }; }
          }
          if (!best || best.sav <= 1e-6) break;
          best.r.bookings.push({ firm: best.g, start: best.a, end: r30(best.C1) }); best.r.bookings.sort((x, y) => x.start - y.start);
          best.r.bookings[0].firm.handsOver = true;
          best.g.planRooms.push({ wing: best.r.wing, slot: best.r.slot, from: best.a }); setEnd(best.g, best.C1); stats.savings++;
        }
      };
      // 2. Or-opt in time: open a small single-panel firm earlier so it finishes by the reuse deadline
      const shiftStep = () => {
        for (const f of F.slice().sort((a, b) => W(a) - W(b))) {
          if (f.planRooms.length !== 1 || f.planOpen === 0 || f.fixedOpen || f.role.late) continue;
          const room = byKey.get(f.planRooms[0].wing * 100 + f.planRooms[0].slot); if (room.bookings.length !== 1) continue;
          const Cn = W(f); if (r30(Cn) > P.reuseCloseBy) continue;
          const a = r30(Math.max(P.reuseOpenFrom, r30(Cn) + P.turnover));
          let bestSav = 0; for (const g of F) { if (g === f || g.planWing !== f.planWing) continue; const v = gain(g, a); if (v && v.sav > bestSav) bestSav = v.sav; }
          const delta = costAt(f, Cn, 0) - costAt(f, exact.get(f), f.planOpen);
          if (bestSav - delta > 1e-6) {
            f.planOpen = 0; f.planRooms[0].from = 0; room.bookings[0].start = 0; setEnd(f, Cn); stats.shifts++;
            savingsStep();
          }
        }
      };
      // 3. Or-opt relocation: move one panel from firm A to firm B when the weighted completion falls
      const relocStep = () => {
        for (let guard = 0; guard < 300; guard++) {
          let best = null;
          for (const A of F) {
            if (A.planRooms.length < 2 || A.handsOver) continue;
            const CA0 = exact.get(A);
            for (let j = 0; j < A.planRooms.length; j++) {
              const pr = A.planRooms[j]; const rest = A.planRooms.filter((_, i) => i !== j).map(x => x.from);
              if (!rest.some(t => t <= A.planOpen)) continue;
              const CA1 = comp(A, rest); const dA = costAt(A, CA1, A.planOpen) - costAt(A, CA0, A.planOpen);
              for (const B of F) {
                if (B === A || B.planWing !== A.planWing || B.planRooms.length >= cap(B)) continue;
                const fromB = Math.max(pr.from, B.planOpen); const CB0 = exact.get(B);
                if (fromB >= CB0 - 30) continue;
                const CB1 = comp(B, B.planRooms.map(x => x.from).concat([fromB]));
                const d = dA + costAt(B, CB1, B.planOpen) - costAt(B, CB0, B.planOpen);
                if (!best || d < best.d) best = { d, A, j, B, fromB, CA1, CB1 };
              }
            }
          }
          if (!best || best.d >= -1e-6) break;
          const pr = best.A.planRooms.splice(best.j, 1)[0];
          const b = byKey.get(pr.wing * 100 + pr.slot).bookings.find(x => x.firm === best.A); b.firm = best.B; b.start = best.fromB;
          best.B.planRooms.push({ wing: pr.wing, slot: pr.slot, from: best.fromB });
          setEnd(best.A, best.CA1); setEnd(best.B, best.CB1); stats.relocations++;
        }
      };
      savingsStep(); shiftStep(); relocStep(); savingsStep();
      stats.z1 = z();
      return stats;
    }

    // ---------------------------------------------------------------- decisions fixed before the cluster: every mode's plan on the same shortlists
    makeDecisions() {
      const k = this.cluster, P = this.P, F = this.firms;
      const modes = ['baseline', 'optimised']; if (this.planMode === 'manual') modes.push('manual');
      const plans = {}, summary = {};
      for (const m of modes) {
        this.plan(m);
        plans[m] = F.map(f => ({ open: f.planOpen, panels: f.planPanels, rooms: f.planRooms.map(r => r ? { wing: r.wing, slot: r.slot, from: r.from != null ? r.from : f.planOpen } : null), close: f.planClose }));
        const improve = this.planStats;
        const pr = plans[m];
        let peak = 0; for (let t = 0; t <= P.softStop; t += 30) { let c = 0; pr.forEach(x => { if (x.open <= t && t < Math.max(x.close, x.open + 30)) c += x.panels; }); peak = Math.max(peak, c); }
        const openTimes = new Map(); pr.forEach(x => openTimes.set(x.open, (openTimes.get(x.open) || 0) + 1));
        summary[m] = {
          at8: pr.filter(x => x.open === 0).length, later: pr.filter(x => x.open > 0).length,
          panels: pr.reduce((a, x) => a + x.panels, 0), peak,
          roomsUsed: this.plannedRooms.filter(r => r.bookings.length).length, reused: this.plannedRooms.filter(r => r.bookings.length >= 2).length,
          noRoom: pr.filter(x => x.rooms.some(r => !r)).length, lastClose: Math.max(0, ...pr.map(x => x.close)),
          openTimes: [...openTimes.entries()].sort((a, b) => a[0] - b[0]),
          cost: F.reduce((a, f, i) => a + f.X * (pr[i].close + 10 * Math.max(0, pr[i].close - P.softStop)) + P.earlyPenalty * f.X * Math.max(0, this.desiredOpen(f) - pr[i].open), 0),
          improve,
          afternoonPanels: pr.reduce((a, x) => a + x.rooms.filter(r => r && r.from > x.open).length, 0),
          wingsUsed: new Set(pr.flatMap(x => x.rooms.filter(Boolean).map(r => r.wing))).size,
          splitFirms: pr.filter(x => new Set(x.rooms.filter(Boolean).map(r => r.wing)).size > 1).length,
          packing: m === 'baseline' ? null : this.packStats,
        };
      }
      // lower bound: drop the room-capacity constraints (each firm runs its maximum panels from its desired time)
      // each firm runs its most panels from the best opening time up to its release date d. The cost is piecewise linear in
      // the opening time, with breakpoints at 0, d and the time at which the firm would end exactly at the soft stop, so the
      // minimum over [0, d] is at one of those three points (it is at d unless the soft stop binds)
      const lb = F.reduce((a, f) => {
        const d = this.desiredOpen(f), run = f.expInt * f.meanDur / Math.max(1, Math.min(Math.floor(f.listSize / 3), P.roomsPerWingPlanned));
        const g = (o) => { const c = o + run; return f.X * (c + 10 * Math.max(0, c - P.softStop)) + P.earlyPenalty * f.X * Math.max(0, d - o); };
        return a + Math.min(g(0), g(d), g(clamp(P.softStop - run, 0, d)));
      }, 0);
      this.decisions[k] = { lowerBound: lb,
        cluster: k, mode: this.mode, pool: this.students.filter(s => s.active).length, poolNoOffer: this.poolInfo && this.poolInfo[k] ? this.poolInfo[k].noOffer : null, poolDreamers: this.poolInfo && this.poolInfo[k] ? this.poolInfo[k].dreamers : null, plannedRooms: P.wings * P.roomsPerWingPlanned, bufferRooms: P.wings * P.roomsPerWingBuffer,
        cohorts: [...new Set(F.map(f => f.role.cohort))], hires: F.reduce((a, f) => a + f.X, 0), modes, summary,
        firms: F.map((f, i) => ({ id: f.role.id, label: f.label, company: f.name, role: f.role.role, cohort: f.role.cohort, pop: f.role.pop, popPct: f.popPct, strategy: f.strategy, X: f.X,
          hot: f.hotSize, list: f.listSize, applicants: f.applicants.length, expInt: f.expInt, meanDur: Math.round(f.meanDur), inter: f.role.inter, release: f.releaseTime, need: f.releaseNeed, readyAt8: f.readyAt8, hotAt8: f.hotAt8, shortAt8: f.shortAt8,
          plans: Object.fromEntries(modes.map(m => [m, plans[m][i]])) })),
      };
    }

    desiredOpen(f) { const P = this.P; let d = (P.openFromPrefs && f.releaseTime != null) ? f.releaseTime : (f.popPct >= 0.5 ? 0 : (f.popPct >= 0.25 ? P.laterOpenMid : P.laterOpenLow)); if (f.role.late) d = Math.max(d, P.lateSlotTime); return d; }

    // ---------------------------------------------------------------- live day
    roomKey(w, j) { return w * 100 + j; }
    openFirm(f) {
      f.state = 'open'; f.actualOpen = this.t; f.pendingRooms = [];
      for (const pr of f.planRooms) {
        if (pr && pr.from != null && pr.from > this.t) { f.pendingRooms.push(pr); continue; }
        if (!this.takeRoom(f, pr) && f.panels.length) f.pendingRooms.push(Object.assign({}, pr || {}, { from: this.t, retry: true })); // no room in its block yet: keep trying
      }
      if (f.panels.length === 0) { f.state = 'planned'; f.waitingRoom = true; return; }
      this.emit(f.label + ' opens with ' + f.panels.length + ' panel' + (f.panels.length > 1 ? 's' : '') + '.', 'open');
    }
    // One block per role on the day as well: every panel of a firm sits in the block of its first panel (its the placement committee
    // volunteer stays there). A busy planned room is replaced by a buffer room, then by a free unbooked room, in that same
    // block. Only a firm with no panel yet may be moved, as a whole, to the nearest block with a free room.
    takeRoom(f, pr, waitForPlanned) {
      const P = this.P;
      let room = pr ? this.physRooms.get(this.roomKey(pr.wing, pr.slot)) : null;
      const home = f.panels.length ? f.panels[0].room.wing : null;
      if (room && home != null && room.wing !== home) room = null;
      if (waitForPlanned && room && (room.firm || this.t < room.freeAt)) return false; // an afternoon panel waits for its own room
      if (!room || room.firm || this.t < room.freeAt) {
        const inWing = (w) => {
          for (let j = P.roomsPerWingPlanned; j < P.roomsPerWingPlanned + P.roomsPerWingBuffer; j++) { const r = this.physRooms.get(this.roomKey(w, j)); if (!r.firm && this.t >= r.freeAt) return r; }
          for (let j = 0; j < P.roomsPerWingPlanned; j++) { const r = this.physRooms.get(this.roomKey(w, j)); if (!r.firm && this.t >= r.freeAt && !this.bookedLater(r)) return r; }
          return null;
        };
        const prefW = home != null ? home : (pr && pr.wing != null ? pr.wing : (f.planWing != null ? f.planWing : 0)); room = inWing(prefW);
        if (!room && home == null) for (let d = 1; d < P.wings && !room; d++) for (const w of [prefW + d, prefW - d]) { if (w < 0 || w >= P.wings || room) continue; room = inWing(w); }
        if (!room) return false;
        if (room.buffer) { f.bufferRooms++; this.dayStats.bufferOpenings++; }
      }
      room.firm = f; room.used = true;
      f.panels.push({ room, student: null, phase: null, endAt: 0, idleSince: this.t, round: 0, hot: false });
      return true;
    }
    // a planned room another firm still expects later in the day is not lent out
    bookedLater(r) { const b = this.planBook && this.planBook.get(this.roomKey(r.wing, r.slot)); return !!(b && b.some(x => x.start >= this.t && x.firm.state === 'planned')); }

    // progress towards the role's target X. Gross (default): offers made, whether or not the student keeps them.
    // Net (targetGross = 0, the earlier model): offers accepted or currently held.
    count(f) { return this.P.targetGross ? f.offers : f.accepted + f.held.size; }
    hires(f) { return f.accepted + f.held.size; }

    eligible(f, s) {
      if (!s.active || s.status === 'final' || s.cAccepted) return false;
      if (!f.onList.has(s.id) || f.done.has(s.id)) return false;
      const rk = s.rank.get(f.idx); if (rk == null) return false;
      if (rk > s.maxRank) return false;
      if (s.holdFirm != null && !(rk < s.holdRank)) return false;
      return true;
    }
    // a student in a role's round 2 queue may be called only while they would still take that role: not placed, and the
    // role ranked above any offer they hold or have rejected (maxRank). Once that fails it never holds again, because
    // maxRank only falls, so the student is struck off the queue for good and the placement committee tells the firm he has a better offer.
    round2Ok(f, s) {
      if (!s.active || s.status === 'final' || s.cAccepted) return false;
      const rk = s.rank.get(f.idx); if (rk == null || rk > s.maxRank) return false;
      if (s.holdFirm != null && !(rk < s.holdRank)) return false;
      return true;
    }
    pruneRound2(f) {
      if (!f.r2q.length) return;
      f.r2q = f.r2q.filter(id => {
        const s = this.students[id]; if (this.round2Ok(f, s)) return true;
        if (!(s.cAccepted || s.status === 'final' || !s.active)) { f.r2Dropped = (f.r2Dropped || 0) + 1; this.dayStats.r2Dropped = (this.dayStats.r2Dropped || 0) + 1;
          (s.hist = s.hist || []).push({ k: this.cluster, type: 'event', t: this.t, text: 'Dropped from round 2 of ' + f.label + ': already holds or has turned down a role ranked higher' });
          this.emit(s.name + ' is dropped from round 2 at ' + f.label + ': a better-ranked offer is already in hand.', 'info'); }
        return false;
      });
    }
    // after a hold or a rejection lowers maxRank, strike the student off every round 2 queue they no longer qualify for
    dropDominated(s) { for (const g of this.firms) if (g.r2q.length && g.r2q.includes(s.id) && !this.round2Ok(g, s)) this.pruneRound2(g); }
    expectedRemaining(f) {
      let e = 0;
      const stick = (s) => this.P.targetGross ? 1 : this.pStick(s, f);
      for (const id of f.r2q) { const s = this.students[id]; if (this.round2Ok(f, s)) e += (f.onList.get(id).hot ? this.P.pOfferHot2 : this.P.pOfferShort2) * stick(s); }
      for (const en of f.list) { const s = this.students[en.id]; if (this.eligible(f, s)) e += this.pOffer(f, en, 1) * stick(s); }
      for (const p of f.panels) if (p.student) e += 0.5;
      return e;
    }
    hasPotential(f) {
      if (f.r2q.some(id => this.round2Ok(f, this.students[id]))) return true;
      for (const e of f.list) { const s = this.students[e.id]; if (this.eligible(f, s)) return true; }
      return false;
    }

    pOffer(f, e, round) {
      const P = this.P;
      if (f.role.inter === 2) return round === 2 ? (e.hot ? P.pOfferHot2 : P.pOfferShort2) : (e.hot ? P.pR2Hot * P.pOfferHot2 : P.pR2Short * P.pOfferShort2);
      return e.hot ? P.pOfferHot1 : P.pOfferShort1;
    }
    // random draws: keyed by event in CRN mode, otherwise the next number of the original stream (same call order as before)
    ru(tag, a, b, c, d) { return this.crn ? keyU(this.P.seed, tag, a, b, c, d) : this.rng.next(); }
    rn(tag, a, b, c, d) { return this.crn ? keyN(this.P.seed, tag, a, b, c, d) : this.rng.normal(); }

    pStick(s, f) {
      if (s.status === 'dreaming') return 1;
      const rk = s.rank.get(f.idx) || s.nRanked; const q = s.nRanked > 1 ? (rk - 1) / (s.nRanked - 1) : 0;
      const d = acceptRejectHold(this.P, q); return d.pA + d.pH;
    }
    drawDuration(f, hot, round, sid) {
      const r = f.role; const lo = round === 2 ? r.i2min : r.i1min, hi = round === 2 ? r.i2max : r.i1max, span = hi - lo;
      const u = this.ru(K.len, sid, f.idx, round);
      return hot ? lo + (span * 2 / 3) * u : (lo + span / 3) + (hi - (lo + span / 3)) * u;
    }

    sendTo(s, f, panel, round) {
      const P = this.P; const e = f.onList.get(s.id);
      s.loc = 'walkTo'; s.moveStart = this.t; s.moveEnd = this.t + P.transit; s.room = panel.room; s.busyFirm = f;
      panel.student = s; panel.round = round; panel.hot = e.hot; panel.startAt = this.t + P.transit;
      panel.endAt = panel.startAt + this.drawDuration(f, e.hot, round, s.id);
      if (round === 1) f.done.add(s.id);
      s.hist = s.hist || [];
      panel.rec = { k: this.cluster, type: 'PI', firm: f.label, company: f.name, roleIdx: f.idx, round, list: e.hot ? 'preferred list' : 'standard list', sent: this.t, start: panel.startAt, end: null, back: null,
        wing: panel.room.wing, slot: panel.room.slot, buffer: !!panel.room.buffer, rank: s.rank.get(f.idx), outcome: 'In interview' };
      s.hist.push(panel.rec);
      f.interviews++; this.dayStats.interviews++;
      if (this.t - panel.idleSince > 0) panel.idleSince = this.t;
    }

    bubble(s, text, color) { this.bubbles.push({ sid: s.id, text, color, t0: this.t }); }

    finishInterview(f, panel) {
      const rec = panel.rec, s0 = panel.student, wasClosed = f.state === 'closing' || f.state === 'closed', offers0 = f.offers, r20 = f.r2q.length;
      this.finishInterviewCore(f, panel);
      if (!rec) return; panel.rec = null;
      rec.end = this.t; rec.back = this.t + this.P.transit;
      if (f.offers > offers0) rec.outcome = s0.cAccepted && s0.offer === f.idx ? (s0.finalHow === 'dream' ? 'Dream offer, accepted' : 'Offer, accepted') : s0.holdFirm === f.idx ? 'Offer, held' : 'Offer, rejected';
      else if (f.r2q.length > r20) rec.outcome = 'Through to round 2';
      else if (wasClosed) rec.outcome = 'Role had closed, no offer';
      else if (s0.status === 'final' || s0.cAccepted) rec.outcome = 'Already placed, no offer';
      else rec.outcome = rec.round === 1 && f.role.inter === 2 ? 'Not through to round 2' : 'No offer';
    }
    finishInterviewCore(f, panel) {
      const P = this.P, s = panel.student, rng = this.rng, e = f.onList.get(s.id);
      panel.student = null; panel.idleSince = this.t;
      s.loc = 'walkBack'; s.moveStart = this.t; s.moveEnd = this.t + P.transit; s.busyFirm = null;
      if (f.state === 'closing' || f.state === 'closed' || s.status === 'final' || s.cAccepted) { this.bubble(s, 'Process closed', '#8a8f98'); return; }
      if (f.role.inter === 2 && panel.round === 1) {
        if (this.ru(K.r2, s.id, f.idx) < (e.hot ? P.pR2Hot : P.pR2Short)) { f.r2q.push(s.id); this.bubble(s, 'Next round', '#5b8def'); this.emit(s.name + ' moves to round 2 at ' + f.label + '.', 'r2'); }
        else this.bubble(s, 'No offer', '#8a8f98');
        return;
      }
      const po = f.role.inter === 2 ? (e.hot ? P.pOfferHot2 : P.pOfferShort2) : (e.hot ? P.pOfferHot1 : P.pOfferShort1);
      if (this.ru(K.offer, s.id, f.idx) >= po) { this.bubble(s, 'No offer', '#8a8f98'); return; }
      f.offers++; this.dayStats.offers++;
      if (this.P.targetGross) this.checkFull(f);
      this.decide(s, f);
    }

    releaseHold(s, why) {
      const g = s.holdFirm; if (g == null) return;
      const f = this.firmByRole.get(g); s.holdFirm = null; s.holdRank = 0;
      if (!f) return;
      f.held.delete(s.id); f.holdsReleased++; this.dayStats.wasted++; this.dayStats.holdLoss++;
      (s.hist = s.hist || []).push({ k: this.cluster, type: 'event', t: this.t, text: 'Released the held offer of ' + f.label });
      if (f.state === 'closed') { f.lostHires++; this.dayStats.lostHires++; this.emit(f.label + ' loses a hire: ' + s.name + ' released a hold after it left.', 'lost'); }
      else if (this.P.targetGross) { f.lostHires++; this.dayStats.lostHires++; this.emit(f.label + ' loses a hire: ' + s.name + ' released a hold (the offer already counts towards its ' + f.X + ').', 'lost'); }
      else if (f.state === 'closing') { f.state = 'open'; this.emit(f.label + ' reopens: ' + s.name + ' released a hold.', 'info'); }
    }

    accept(s, f, how) {
      if (s.holdFirm != null && s.holdFirm !== f.idx) this.releaseHold(s);
      if (s.holdFirm === f.idx) { f.held.delete(s.id); s.holdFirm = null; }
      f.accepted++; s.cAccepted = true; s.offerRank = s.rank.get(f.idx);
      if (how === 'auto') (s.hist = s.hist || []).push({ k: this.cluster, type: 'event', t: this.t, text: 'Held offer of ' + f.label + ' became an acceptance' + (this.dayOver ? ' at the end of the day' : ' (hold clock ran out)') });
      if (s.status === 'dreaming') {
        const old = s.offer != null ? this.oldFirmInfo[s.offer] : null;
        s.status = 'final'; this.metrics.dreamConversions++; this.dayStats.dreamConversions++;
        if (old) old.lostToDream++; this.dayStats.dreamLoss++;
        this.emit(s.name + ' converts a dream at ' + f.label + ' and leaves placement.', 'dream');
        this.bubble(s, 'Dream offer!', '#9b5de5');
        s.offer = f.idx; s.offerCluster = this.cluster; s.finalHow = 'dream';
      } else {
        s.offer = f.idx; s.offerCluster = this.cluster; s.status = 'placedToday'; s.finalHow = how;
        this.bubble(s, how === 'auto' ? 'Auto-accepted' : 'Accepted', '#2fa36b');
        this.emit(s.name + (how === 'auto' ? ' auto-accepts ' : ' accepts ') + f.label + ' (rank ' + s.offerRank + ').', 'accept');
      }
      this.dayStats.placements++;
      this.checkFull(f);
    }

    decide(s, f) {
      const P = this.P, rng = this.rng;
      if (s.status === 'dreaming') { this.accept(s, f, 'dream'); return; }
      const rk = s.rank.get(f.idx); const q = s.nRanked > 1 ? (rk - 1) / (s.nRanked - 1) : 0;
      const d = acceptRejectHold(P, q); const u = this.ru(K.dec, s.id, f.idx);
      if (P.finalNoReject && this.cluster === 3) { d.pH += d.pR; d.pR = 0; }
      if (u < d.pA) { this.accept(s, f, 'accept'); return; }
      if (u < d.pA + d.pH) {
        if (s.holdFirm != null) this.releaseHold(s);
        s.holdFirm = f.idx; s.holdRank = rk; s.holdClock = P.holdClock; f.held.add(s.id);
        s.maxRank = Math.min(s.maxRank, rk - 1); this.dropDominated(s);
        this.bubble(s, 'Holding offer', '#e0a526'); this.emit(s.name + ' holds ' + f.label + ' (rank ' + rk + ') and waits for higher choices.', 'hold');
        this.checkFull(f); return;
      }
      f.rejectsRecv++; this.dayStats.wasted++; this.dayStats.rejected++; s.maxRank = Math.min(s.maxRank, rk); this.dropDominated(s);
      this.bubble(s, 'Rejected offer', '#d0555b'); this.emit(s.name + ' rejects ' + f.label + ' (rank ' + rk + ' of ' + s.nRanked + ').', 'reject');
    }

    checkFull(f) { if (f.state === 'open' && this.count(f) >= f.X) { f.state = 'closing'; this.emit(f.label + (this.P.targetGross ? ' makes its ' + f.X + ' offer' + (f.X > 1 ? 's' : '') : ' reaches its ' + f.X + ' hire' + (f.X > 1 ? 's' : '')) + ' and shuts shop.', 'close'); } }

    closeFirm(f, why) {
      f.state = 'closed'; f.actualClose = this.t; f.closeWhy = why;
      for (const p of f.panels) { p.room.firm = null; p.room.freeAt = (this.t <= this.P.reuseCloseBy && !p.room.buffer) ? Math.max(this.P.reuseOpenFrom, this.t + this.P.turnover) : this.t + this.P.turnover; }
      if (why === 'unfilled') this.emit(f.label + ' leaves with ' + this.count(f) + ' of ' + f.X + (this.P.targetGross ? ' offers made.' : ' hires.'), 'lost');
    }

    extend(f) {
      if (!this.P.extensions || f.extensions >= this.P.maxExtensions) return false;
      const pool = f.applicants.filter(id => !f.onList.has(id)).map(id => this.students[id]).filter(s => s.active && !s.cAccepted && s.status !== 'final' && (s.rank.get(f.idx) || 99999) <= s.maxRank && (s.holdFirm == null || s.rank.get(f.idx) < s.holdRank));
      if (f.gd) { // a GD firm extends only to students who sat its GD, best GD performance first
        const g = pool.filter(s => f.gdScore.has(s.id)).sort((a, b) => f.gdScore.get(b.id) - f.gdScore.get(a.id));
        pool.length = 0; pool.push(...g);
      }
      if (!pool.length) return false;
      if (!f.gd) { if (this.crn) { const ky = new Map(pool.map(x => [x.id, keyU(this.P.seed, K.ext, f.idx, x.id)])); pool.sort((a, b) => ky.get(a.id) - ky.get(b.id)); } else this.rng.shuffle(pool); }
      const add = pool.slice(0, f.X);
      add.forEach(s => { const e = { id: s.id, hot: false }; f.list.push(e); f.onList.set(s.id, e); (s.hist = s.hist || []).push({ k: this.cluster, type: 'event', t: this.t, text: 'Added to the shortlist of ' + f.label + ' (extension)' }); });
      f.extensions++; this.emit(f.label + ' extends its shortlist by ' + add.length + '.', 'info'); return true;
    }

    startDay() {
      const P = this.P;
      this.physRooms = new Map();
      for (let w = 0; w < P.wings; w++) for (let j = 0; j < P.roomsPerWingPlanned + P.roomsPerWingBuffer; j++) this.physRooms.set(this.roomKey(w, j), { wing: w, slot: j, buffer: j >= P.roomsPerWingPlanned, firm: null, freeAt: 0, used: false });
      this.dayStats = { interviews: 0, offers: 0, placements: 0, wasted: 0, lostHires: 0, dreamConversions: 0, bufferOpenings: 0, peakRooms: 0, idle: 0, r2Dropped: 0, rejected: 0, holdLoss: 0, dreamLoss: 0, panelMin: 0 };
      // which planned rooms each firm expects, and from when (so a free room is not lent to a firm that is not its own)
      this.planBook = new Map();
      for (const f of this.firms || []) for (const pr of f.planRooms || []) if (pr) { const key = this.roomKey(pr.wing, pr.slot); if (!this.planBook.has(key)) this.planBook.set(key, []); this.planBook.get(key).push({ firm: f, start: pr.from != null ? pr.from : f.planOpen }); }
      this.t = 0; this.dayOver = false;
    }

    step() {
      if (this.dayOver) return;
      const P = this.P, t = this.t;
      // arrivals and returns
      for (const s of this.students) {
        if (s.loc === 'walkTo' && t >= s.moveEnd) s.loc = 'room';
        else if (s.loc === 'walkBack' && t >= s.moveEnd) { s.loc = 'seat'; s.room = null; }
      }
      // interviews ending
      for (const f of this.firms) for (const p of f.panels) if (p.student && t >= p.endAt) this.finishInterview(f, p);
      // hold clocks run only while the student sits in the auditorium
      for (const s of this.students) if (s.holdFirm != null && !s.cAccepted && s.loc === 'seat') {
        s.holdClock -= 1;
        if (s.holdClock <= 0) { const f = this.firmByRole.get(s.holdFirm); this.accept(s, f, 'auto'); }
      }
      // openings
      for (const f of this.firms) if (f.state === 'planned' && t >= f.planOpen) this.openFirm(f);
      // afternoon panels planned into noon-handover rooms
      for (const f of this.firms) if (f.pendingRooms && f.pendingRooms.length) {
        if (f.state !== 'open') { if (f.state === 'closed' || f.state === 'closing') f.pendingRooms = []; continue; }
        f.pendingRooms = f.pendingRooms.filter(pr => { if (t < pr.from) return true; if (!this.takeRoom(f, pr, !pr.retry)) return true; this.emit(f.label + ' adds a panel in Block ' + PS.wingLabel(f.panels[f.panels.length - 1].room.wing) + (pr.retry ? ' (a room in its block came free).' : ' (noon handover).'), 'open'); return false; });
      }
      // closings and extensions
      for (const f of this.firms) {
        if (f.state === 'closing' && f.panels.every(p => !p.student)) this.closeFirm(f, 'filled');
        else if (f.state === 'open' && t >= P.softStop && f.panels.every(p => !p.student)) this.closeFirm(f, 'unfilled');
        else if (f.state === 'planned' && t >= P.softStop) this.closeFirm(f, 'unfilled');
        else if (f.state === 'open' && f.panels.every(p => !p.student) && !this.hasPotential(f)) {
          if (!this.extend(f)) this.closeFirm(f, 'unfilled');
        }
        else if (f.state === 'open' && f.panels.some(p => !p.student) && t % 10 === 0 && this.expectedRemaining(f) < (f.X - this.count(f))) this.extend(f);
      }
      // assignment
      this.assign();
      // stats
      let busyRooms = 0; for (const r of this.physRooms.values()) if (r.firm) busyRooms++;
      this.dayStats.peakRooms = Math.max(this.dayStats.peakRooms, busyRooms);
      for (const f of this.firms) if (f.state === 'open') for (const p of f.panels) { f.panelMin = (f.panelMin || 0) + 1; this.dayStats.panelMin++; if (!p.student) { f.idle++; this.dayStats.idle++; } }
      this.t++;
      const allClosed = this.firms.every(f => f.state === 'closed');
      const nobodyMoving = this.students.every(s => s.loc === 'seat');
      if ((allClosed && nobodyMoving) || this.t >= P.hardStop) this.endDay();
    }

    candidateScore(f, s, panel, round) {
      const P = this.P, e = f.onList.get(s.id);
      const w = (round === 2 ? (f.role.inter === 2 ? (e.hot ? P.pOfferHot2 : P.pOfferShort2) : 1) : this.pOffer(f, e, 1)) * this.pStick(s, f);
      const p = round === 2 ? (f.role.i2min + f.role.i2max) / 2 : this.meanDuration(f);
      let score = w / p * 60;
      if (s.status !== 'dreaming') { const rk = s.rank.get(f.idx) || s.nRanked; const q = s.nRanked > 1 ? (rk - 1) / (s.nRanked - 1) : 0; score *= Math.exp(-P.prefBeta * q); }
      if (round === 2) score += 5;
      if (s.holdFirm != null) score *= 1 + P.holdUrgency * (1 - s.holdClock / P.holdClock);
      // look-ahead: a firm the student ranks strictly higher frees a panel soon and wants them
      if (s.status !== 'dreaming') {
        const myRank = s.rank.get(f.idx);
        for (const g of (this.soonFirms || [])) {
          if (g === f) continue;
          const rg = s.rank.get(g.idx); if (rg == null || rg >= myRank) continue;
          if (!this.eligible(g, s)) continue;
          score *= (1 - P.lookAheadPenalty); break;
        }
      }
      score += P.idleBonus * (this.t - panel.idleSince);
      return score;
    }

    assign() {
      if (this.t >= this.P.softStop) return;
      const free = [];
      for (const f of this.firms) if (f.state === 'open') for (const p of f.panels) if (!p.student) free.push({ f, p });
      if (!free.length) return;
      this.soonFirms = this.firms.filter(g => g.state === 'open' && g.panels.some(q => q.student && q.endAt - this.t <= this.P.lookAhead));
      const avail = (s) => s.loc === 'seat' && !s.cAccepted && s.status !== 'final';
      if (this.matchMode === 'baseline') {
        for (const { f, p } of free) {
          let pick = null, round = 1;
          this.pruneRound2(f);
          if (f.r2q.length) { const s = this.students[f.r2q[0]]; if (avail(s)) { pick = s; round = 2; f.r2q.shift(); } }
          if (!pick) for (const e of f.list) { const s = this.students[e.id]; if (avail(s) && this.eligible(f, s)) { pick = s; break; } }
          if (pick) this.sendTo(pick, f, p, round);
        }
        return;
      }
      // optimised / manual: Hungarian assignment over the top candidates of each free panel
      const K = 8; const cols = new Map(); const rows = [];
      for (const { f, p } of free) {
        const cands = [];
        this.pruneRound2(f);
        for (const id of f.r2q) { const s = this.students[id]; if (avail(s)) cands.push({ s, round: 2 }); }
        for (const e of f.list) { const s = this.students[e.id]; if (avail(s) && this.eligible(f, s)) cands.push({ s, round: 1 }); }
        const scored = cands.map(c => ({ ...c, sc: this.candidateScore(f, c.s, p, c.round) })).sort((a, b) => b.sc - a.sc).slice(0, K);
        rows.push({ f, p, scored });
        scored.forEach(c => { if (!cols.has(c.s.id)) cols.set(c.s.id, cols.size); });
      }
      if (!cols.size) return;
      const colIds = [...cols.keys()];
      const n = rows.length, m = Math.max(colIds.length, n);
      const BIG = 1e6; const cost = rows.map(() => new Array(m).fill(BIG));
      rows.forEach((r, i) => r.scored.forEach(c => { cost[i][cols.get(c.s.id)] = 100 - c.sc; }));
      const ans = hungarian(cost);
      ans.forEach((j, i) => {
        if (j < 0 || j >= colIds.length || cost[i][j] >= BIG) return;
        const r = rows[i]; const c = r.scored.find(x => x.s.id === colIds[j]); if (!c) return;
        if (c.round === 2) r.f.r2q = r.f.r2q.filter(id => id !== c.s.id);
        this.sendTo(c.s, r.f, r.p, c.round);
      });
    }

    endDay() {
      this.dayOver = true;
      for (const f of this.firms) if (f.state !== 'closed') this.closeFirm(f, this.count(f) >= f.X ? 'filled' : 'unfilled');
      for (const s of this.students) { if (s.holdFirm != null && !s.cAccepted) { const f = this.firmByRole.get(s.holdFirm); this.accept(s, f, 'auto'); } s.loc = 'seat'; s.room = null; }
      // cluster metrics
      const k = this.cluster, F = this.firms;
      const placedToday = this.students.filter(s => s.offerCluster === k && s.cAccepted);
      const ranks = { r1: 0, top10: 0, top25: 0, top50: 0, rest: 0, dream: 0 };
      for (const s of placedToday) {
        if (s.finalHow === 'dream') { ranks.dream++; continue; }
        const r = s.offerRank || 1; const q = s.nRanked > 1 ? (r - 1) / (s.nRanked - 1) : 0;
        if (r === 1) ranks.r1++; else if (q <= 0.10) ranks.top10++; else if (q <= 0.25) ranks.top25++; else if (q <= 0.5) ranks.top50++; else ranks.rest++;
      }
      this.metrics.clusters[k] = {
        roles: F.length, grossOffers: placedToday.length, hiresTarget: F.reduce((a, f) => a + f.X, 0),
        pool: this.poolInfo && this.poolInfo[k] ? this.poolInfo[k].total : null, poolNoOffer: this.poolInfo && this.poolInfo[k] ? this.poolInfo[k].noOffer : null, poolDreamers: this.poolInfo && this.poolInfo[k] ? this.poolInfo[k].dreamers : null,
        filled: F.filter(f => this.count(f) >= f.X).length, hires: F.reduce((a, f) => a + this.hires(f), 0), targetGross: +!!this.P.targetGross,
        interviews: this.dayStats.interviews, offersMade: this.dayStats.offers, wasted: this.dayStats.wasted,
        lostHolds: this.dayStats.lostHires, dreamConversions: this.dayStats.dreamConversions,
        // offers that did not become a hire, by cause: turned down at once, held and later released, or accepted and then
        // left behind when the student converted a dream offer in this cluster
        rejected: this.dayStats.rejected, holdLoss: this.dayStats.holdLoss, dreamLoss: this.dayStats.dreamLoss,
        totalLoss: this.dayStats.rejected + this.dayStats.holdLoss + this.dayStats.dreamLoss,
        // panel utilisation: share of open panel-minutes in which a panel had a student; idle minutes per role
        util: this.dayStats.panelMin ? 100 * (1 - this.dayStats.idle / this.dayStats.panelMin) : 0, idleMinPerRole: F.length ? this.dayStats.idle / F.length : 0,
        idleHours: Math.round(this.dayStats.idle / 60), idleMin: this.dayStats.idle, panelMin: this.dayStats.panelMin, peakRooms: this.dayStats.peakRooms, bufferOpenings: this.dayStats.bufferOpenings,
        endTime: Math.max(0, ...F.map(f => f.actualClose || 0)), ranks,
        extensions: F.reduce((a, f) => a + f.extensions, 0), r2Dropped: this.dayStats.r2Dropped || 0,
        wingsPlanned: this.decisions[k] && this.decisions[k].summary[this.planMode] ? this.decisions[k].summary[this.planMode].wingsUsed : null,
      };
      // remember firms for dream-loss accounting
      this.oldFirmInfo = this.oldFirmInfo || {};
      for (const f of F) this.oldFirmInfo[f.idx] = f;
      this.allFirms = (this.allFirms || []).concat(F);
      this.emit('Cluster ' + k + ' ends at ' + PS.fmtTime(this.metrics.clusters[k].endTime) + ': ' + placedToday.length + ' students placed.', 'head');
    }

    // ---------------------------------------------------------------- end of cluster: opt out or dream
    endCluster() {
      const P = this.P, k = this.cluster, R = this.roles;
      for (const s of this.students) s.cAccepted = false;
      const placed = this.students.filter(s => s.status === 'placedToday');
      const later = R.filter(r => r.cluster > k).map(r => r.idx);
      const cand = [];
      for (const s of placed) {
        s.status = 'final';
        if (!later.length) continue;
        const cur = s.util[s.offer];
        const better = later.filter(i => s.util[i] > cur).sort((a, b) => s.util[b] - s.util[a]);
        if (better.length) cand.push({ s, appeal: s.util[better[0]] - cur, better });
      }
      cand.sort((a, b) => b.appeal - a.appeal);
      const nDream = Math.round(P.dreamShare * placed.length);
      let made = 0;
      for (const c of cand.slice(0, nDream)) {
        const per = {}; const apps = [];
        for (const i of c.better) { const cl = R[i].cluster; if ((per[cl] || 0) >= P.dreamMaxPerCluster) continue; if (apps.length >= P.dreamMaxTotal) break; per[cl] = (per[cl] || 0) + 1; apps.push(i); }
        c.s.dreamApps = apps; c.s.status = 'dreaming'; made++;
        (c.s.hist = c.s.hist || []).push({ k, type: 'event', t: this.metrics.clusters[k].endTime, text: 'Dreams into later clusters: ' + apps.map(i => R[i].company + ' – ' + R[i].role).join('; ') });
      }
      // dreamers from earlier clusters with no apps left become final
      for (const s of this.students) if (s.status === 'dreaming' && !s.dreamApps.some(i => R[i].cluster > k)) s.status = 'final';
      this.metrics.clusters[k].dreamers = made;
      this.emit(made + ' of ' + placed.length + ' placed students dream into later clusters.', 'dream');
    }

    // ---------------------------------------------------------------- whole run without animation
    runToEnd() {
      while (!this.finished) this.advance();
    }
    // advance one unit: if day running, step; if day over, move to next cluster or finish
    advance() {
      if (!this.dayOver) { this.step(); return; }
      if (this.cluster > 0 && !this.clusterEnded) { this.endCluster(); this.clusterEnded = true; }
      if (this.cluster >= 3) { this.finish(); return; }
      this.startCluster(this.cluster + 1); this.startDay(); this.clusterEnded = false;
    }
    finish() {
      if (this.finished) return; this.finished = true;
      const st = this.students;
      const net = { 1: 0, 2: 0, 3: 0 }; st.forEach(s => { if (s.offer != null) net[this.roles[s.offer].cluster]++; });
      this.metrics.net = net;
      this.metrics.unplaced = st.filter(s => s.offer == null).length;
      this.metrics.lostToDream = (this.allFirms || []).reduce((a, f) => a + f.lostToDream, 0);
      this.metrics.lostHolds = (this.allFirms || []).reduce((a, f) => a + f.lostHires, 0);
      this.emit('Placement complete: ' + (st.length - this.metrics.unplaced) + ' of ' + st.length + ' placed.', 'head');
    }
  }
  PS.Sim = Sim;

  // ------------------------------------------------------------------ Stage 1: cohort-to-cluster allocation as a 0-1 programme
  // maximise  sum_c sum_k (4 - k) * pop_c * roles_c * y_ck   (preferred cohorts earlier, weighted by size)
  // s.t.      sum_k y_ck = 1 for every cohort;  sum_c roles_c y_ck <= maxRoles_k;  sum_c hires_c y_ck <= maxHires_k;  y binary
  // Solved by LP-based branch and bound (simplex for each relaxation, depth-first, y = 1 branch first).
  function simplexMax(c, A, b) { // max c.x  s.t. A x <= b, x >= 0, b >= 0  (Bland's rule)
    const m = A.length, n = c.length, T = [];
    for (let i = 0; i < m; i++) { const row = A[i].slice(); for (let j = 0; j < m; j++) row.push(i === j ? 1 : 0); row.push(b[i]); T.push(row); }
    const obj = c.map(v => -v); for (let j = 0; j < m; j++) obj.push(0); obj.push(0);
    const basis = []; for (let i = 0; i < m; i++) basis.push(n + i);
    for (let it = 0; it < 5000; it++) {
      let e = -1; for (let j = 0; j < n + m; j++) if (obj[j] < -1e-9) { e = j; break; }
      if (e < 0) break;
      let r = -1, best = Infinity;
      for (let i = 0; i < m; i++) if (T[i][e] > 1e-9) { const q = T[i][n + m] / T[i][e]; if (q < best - 1e-12 || (Math.abs(q - best) < 1e-12 && basis[i] < basis[r])) { best = q; r = i; } }
      if (r < 0) return null;
      const pv = T[r][e]; for (let j = 0; j <= n + m; j++) T[r][j] /= pv;
      for (let i = 0; i < m; i++) if (i !== r && Math.abs(T[i][e]) > 1e-12) { const f = T[i][e]; for (let j = 0; j <= n + m; j++) T[i][j] -= f * T[r][j]; }
      if (Math.abs(obj[e]) > 1e-12) { const f = obj[e]; for (let j = 0; j <= n + m; j++) obj[j] -= f * T[r][j]; }
      basis[r] = e;
    }
    const x = new Array(n).fill(0); for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][n + m];
    return { z: obj[n + m], x };
  }
  PS.solveCohortIP = function (roles, opts) {
    const by = {};
    roles.forEach(r => { const c = by[r.cohort] = by[r.cohort] || { cohort: r.cohort, roles: 0, hires: 0, pop: 0 }; c.roles++; c.hires += +r.X; c.pop += +r.pop; });
    const C = Object.values(by).map(c => Object.assign(c, { pop: c.pop / c.roles })).sort((a, b) => b.pop - a.pop);
    const K = [1, 2, 3], maxR = opts.maxRoles || Infinity, maxH = opts.maxHires || Infinity;
    const val = (c, k) => (4 - k) * c.pop * c.roles / 100;
    const M = 1000;
    const stats = { nodes: 0, byBound: 0, byIntegrality: 0, infeasible: 0, incumbents: [], rootBound: null };
    let best = null;
    const solveNode = (fixed, banned) => { // fixed: Map ci -> k ; banned: Set 'ci,k'
      const vars = []; const capR = { 1: maxR, 2: maxR, 3: maxR }, capH = { 1: maxH, 2: maxH, 3: maxH }; let base = 0;
      for (const [ci, k] of fixed) { capR[k] -= C[ci].roles; capH[k] -= C[ci].hires; base += val(C[ci], k); }
      if (K.some(k => capR[k] < -1e-9 || capH[k] < -1e-9)) return null;
      C.forEach((c, ci) => { if (fixed.has(ci)) return; K.forEach(k => { if (!banned.has(ci + ',' + k) && c.roles <= capR[k] && c.hires <= capH[k]) vars.push({ ci, k }); }); });
      const free = C.map((_, ci) => ci).filter(ci => !fixed.has(ci));
      if (free.some(ci => !vars.some(v => v.ci === ci))) return null;
      if (!vars.length) return { z: base, x: [], vars, base, free };
      const A = [], b = [];
      free.forEach(ci => { A.push(vars.map(v => v.ci === ci ? 1 : 0)); b.push(1); });
      K.forEach(k => { if (isFinite(capR[k])) { A.push(vars.map(v => v.k === k ? C[v.ci].roles : 0)); b.push(capR[k]); } if (isFinite(capH[k])) { A.push(vars.map(v => v.k === k ? C[v.ci].hires : 0)); b.push(capH[k]); } });
      const lp = simplexMax(vars.map(v => M + val(C[v.ci], v.k)), A, b); if (!lp) return null;
      const assigned = free.map(ci => vars.reduce((a, v, j) => a + (v.ci === ci ? lp.x[j] : 0), 0));
      if (assigned.some(a => a < 1 - 1e-6)) return null; // some cohort cannot be placed within the caps
      return { z: base + lp.z - M * free.length, x: lp.x, vars, base, free };
    };
    const stack = [{ fixed: new Map(), banned: new Set(), depth: 0 }];
    while (stack.length && stats.nodes < 20000) {
      const nd = stack.pop(); stats.nodes++;
      const r = solveNode(nd.fixed, nd.banned);
      if (!r) { stats.infeasible++; continue; }
      if (stats.rootBound == null) stats.rootBound = r.z;
      if (best && r.z <= best.z + 1e-7) { stats.byBound++; continue; }
      let frac = -1, fv = 0;
      r.vars.forEach((v, j) => { const d = Math.abs(r.x[j] - Math.round(r.x[j])); if (d > 1e-6 && d > fv) { fv = d; frac = j; } });
      if (frac < 0) { // integral: a new incumbent
        const map = new Map(nd.fixed); r.vars.forEach((v, j) => { if (r.x[j] > 0.5) map.set(v.ci, v.k); });
        best = { z: r.z, map }; stats.byIntegrality++; stats.incumbents.push({ node: stats.nodes, z: r.z }); continue;
      }
      const v = r.vars[frac];
      const banned = new Set(nd.banned); banned.add(v.ci + ',' + v.k);
      stack.push({ fixed: nd.fixed, banned, depth: nd.depth + 1 });                                   // y = 0 branch, explored second
      const fixed = new Map(nd.fixed); fixed.set(v.ci, v.k); stack.push({ fixed, banned: nd.banned, depth: nd.depth + 1 }); // y = 1 branch first
    }
    if (!best) return { feasible: false, stats };
    const alloc = {}; C.forEach((c, ci) => { alloc[c.cohort] = best.map.get(ci); });
    const score = (map) => C.reduce((a, c) => a + val(c, map[c.cohort]), 0);
    return { feasible: true, alloc, objective: best.z, stats, cohorts: C, score, optimal: stack.length === 0 };
  };

  // one-line summary of a finished run (used by comparisons and the sensitivity sweep)
  PS.summarize = function (sim) {
    const M = sim.metrics, C = [1, 2, 3].map(k => M.clusters[k]).filter(Boolean);
    const sum = (fn) => C.reduce((a, c) => a + fn(c), 0);
    return {
      placed: sim.students.length - (M.unplaced || 0), unplaced: M.unplaced || 0,
      filledPct: 100 * sum(c => c.filled) / Math.max(1, sum(c => c.roles)),
      gross1: C[0] ? C[0].grossOffers : 0, gross2: C[1] ? C[1].grossOffers : 0, gross3: C[2] ? C[2].grossOffers : 0,
      interviews: sum(c => c.interviews), wasted: sum(c => c.wasted), lost: (M.lostHolds || 0) + (M.lostToDream || 0), lostHolds: M.lostHolds || 0,
      dreamConv: M.dreamConversions || 0, rank1: sum(c => c.ranks.r1), top10: sum(c => c.ranks.r1 + c.ranks.top10), below50: sum(c => c.ranks.rest),
      rejected: sum(c => c.rejected || 0), holdLoss: sum(c => c.holdLoss || 0), dreamLoss: sum(c => c.dreamLoss || 0), totalLoss: sum(c => c.totalLoss || 0),
      util: (() => { const pm = sum(c => c.panelMin || 0), id = sum(c => c.idleMin || 0); return pm ? 100 * (1 - id / pm) : 0; })(), idleMinPerRole: sum(c => (c.idleMinPerRole || 0) * c.roles) / Math.max(1, sum(c => c.roles)),
      idle: sum(c => c.idleHours), buffer: sum(c => c.bufferOpenings), r2Dropped: sum(c => c.r2Dropped || 0), wings: sum(c => c.wingsPlanned || 0) / Math.max(1, C.length), peakRooms: Math.max(0, ...C.map(c => c.peakRooms)), extensions: sum(c => c.extensions),
      endAvg: sum(c => c.endTime) / Math.max(1, C.length),
      gdEnd: (() => { const d = Object.values(sim.gdDays || {}); return d.length ? d.reduce((a, x) => a + x[sim.planMode === 'baseline' && sim.matchMode === 'baseline' ? 'baseline' : 'optimised'].end, 0) / d.length : 0; })(),
      gdWait: Object.values(sim.gdDays || {}).reduce((a, x) => a + x[sim.planMode === 'baseline' && sim.matchMode === 'baseline' ? 'baseline' : 'optimised'].clashWait, 0),
    };
  };

  // ------------------------------------------------------------------ names
  const FIRST = ['Aarav','Diya','Kabir','Ananya','Vihaan','Isha','Arjun','Meera','Rohan','Tara','Aditya','Kavya','Ishaan','Riya','Siddharth','Nisha','Varun','Pooja','Karan','Sneha','Rahul','Aditi','Nikhil','Shreya','Aman','Priya','Dev','Naina','Yash','Zoya','Harsh','Neha','Om','Sara','Vivek','Tanvi','Kunal','Ira','Manav','Leela'];
  const LAST = ['Sharma','Iyer','Khan','Reddy','Patel','Nair','Gupta','Das','Mehta','Bose','Rao','Singh','Kapoor','Joshi','Menon','Shah','Verma','Pillai','Chopra','Sen'];
  PS.studentName = (i) => FIRST[i % FIRST.length] + ' ' + LAST[Math.floor(i / FIRST.length) % LAST.length];
})(window.PS);
