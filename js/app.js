/* App wiring: tabs, playback, side panel, plan vs actual, results, assumptions, firms, cohorts. */
(function (PS) {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    load() { try { return JSON.parse(localStorage.getItem('ps-state-v5') || '{}'); } catch (e) { return {}; } },
    save(st) { try { localStorage.setItem('ps-state-v5', JSON.stringify(st)); } catch (e) { /* storage unavailable */ } },
  };
  const saved = store.load();
  const state = {
    params: PS.sanitizeParams(Object.assign({}, PS.DEFAULT_PARAMS, saved.params || {})),
    overrides: saved.overrides || {},
    cohortMap: Object.assign({}, PS.COHORT_CLUSTER, saved.cohortMap || {}),
    mode: saved.mode || 'optimised',
    speed: 6, playing: false, acc: 0, pre: false,
  };
  const persist = () => store.save({ params: state.params, overrides: state.overrides, cohortMap: state.cohortMap, mode: state.mode });

  // ------------------------------------------------------------------ tabs
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    const t = b.dataset.tab;
    if (t === 'decisions') renderDecisions(); if (t === 'gd') renderGd(); if (t === 'plan') renderPlan(); if (t === 'students') renderStudents(); if (t === 'results') renderResults(); if (t === 'firms') renderFirms(); if (t === 'cohorts') renderCohorts(); if (t === 'assumptions') renderParams();
  }));

  // ------------------------------------------------------------------ simulation lifecycle
  let sim, renderer; const canvas = $('#canvas');
  function newSim() {
    sim = new PS.Sim(state.params, PS.buildRoles(state.overrides, state.cohortMap), state.mode);
    sim.advance(); // starts cluster 1
    state.gd = null; state.acc = 0; state.playing = false; $('#btnPlay').textContent = 'Play';
    $('#overlay').classList.add('hidden');
    $('#modeLabel').textContent = { optimised: 'Optimised', baseline: 'Baseline', manual: 'Manual' }[state.mode];
    logRendered = 0; $('#log').innerHTML = ''; stuSel = null;
    updateSide(); showPreCluster();
  }
  renderer = new PS.Renderer(canvas);

  let last = performance.now();
  let drawError = false;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(100, now - last); last = now;
    if (state.gd) {
      const g = state.gd;
      if (state.playing) { g.t = Math.min(g.end, g.t + dt / 1000 * state.speed); if (g.t >= g.end) { state.playing = false; $('#btnPlay').textContent = 'Play'; showGdSummary(); } updateSide(); }
      try { renderer.draw(sim, g.t, g); drawError = false; } catch (err) { if (!drawError) console.error('Drawing failed:', err); drawError = true; }
      return;
    }
    if (state.playing && !sim.dayOver) {
      state.acc += dt / 1000 * state.speed;
      let guard = 0;
      while (state.acc >= 1 && !sim.dayOver && guard++ < 200) { sim.step(); state.acc -= 1; }
      if (sim.dayOver) { state.playing = false; $('#btnPlay').textContent = 'Play'; state.acc = 0; showClusterSummary(); }
      updateSide();
    }
    if (now - stuLast > 1200 && $('#tab-students').classList.contains('active')) { // the tracker follows the run
      const key = sim.cluster + ':' + sim.t + ':' + sim.finished + ':' + sim.dayOver; stuLast = now; if (key !== stuKey) { stuKey = key; renderStudents(); } }
    try { renderer.draw(sim, sim.t - 1 + Math.min(1, state.acc)); drawError = false; }
    catch (err) { if (!drawError) console.error('Drawing failed:', err); drawError = true; }
  }

  $('#btnPlay').addEventListener('click', () => {
    if (sim.finished) return;
    if (state.gd) { if (state.gd.t >= state.gd.end) { showGdSummary(); return; } hideOverlay(); state.playing = !state.playing; $('#btnPlay').textContent = state.playing ? 'Pause' : 'Play'; return; }
    if (sim.dayOver) { continueCluster(); return; }
    if (state.pre) { hideOverlay(); state.playing = true; $('#btnPlay').textContent = 'Pause'; return; }
    state.playing = !state.playing; $('#btnPlay').textContent = state.playing ? 'Pause' : 'Play';
  });
  $('#btnSkipDay').addEventListener('click', () => {
    if (sim.finished) return;
    if (state.gd) { state.gd.t = state.gd.end; state.playing = false; $('#btnPlay').textContent = 'Play'; updateSide(); showGdSummary(); return; }
    if (sim.dayOver) { continueCluster(); }
    hideOverlay();
    while (!sim.dayOver) sim.step();
    state.playing = false; $('#btnPlay').textContent = 'Play'; updateSide(); showClusterSummary();
  });
  $('#btnReset').addEventListener('click', newSim);
  $('#selMode').value = state.mode;
  $('#selMode').addEventListener('change', (e) => { state.mode = e.target.value; persist(); newSim(); });
  $('#selSpeed').addEventListener('change', (e) => { state.speed = +e.target.value; });

  function hideOverlay() { $('#overlay').classList.add('hidden'); state.pre = false; }
  function continueCluster() {
    hideOverlay();
    sim.advance(); // end of cluster processing
    if (sim.cluster < 3 || !sim.finished) { if (!sim.finished && sim.dayOver) sim.advance(); }
    if (sim.finished) { showFinal(); } else if (sim.gdDays && sim.gdDays[sim.cluster]) startGdDay(sim.cluster); else showPreCluster();
    updateSide();
  }
  // ---------------- GD day: replayed from the GD timetable of the mode in use, before the cluster's decisions
  function gdModeOf() { return sim.mode === 'baseline' ? 'baseline' : 'optimised'; }
  function startGdDay(k) {
    const day = sim.gdDays[k], mode = gdModeOf(), x = day[mode];
    state.gd = { k, day, mode, t: 0, end: Math.ceil(x.end + sim.P.transit + 1) };
    const inv = day.companies.reduce((a, c) => a + c.invited, 0);
    $('#overlay').innerHTML = '<div class="box"><h3>GD day before cluster ' + k + '</h3>' +
      '<p class="muted">Cluster ' + (k - 1) + ' is over. Tomorrow\'s cluster ' + k + ' firms have screened CVs, and ' + day.companies.length + ' companies call students to a group discussion today, one GD per company across all its roles: ' + inv + ' invitations, ' + x.nGroups + ' groups, in the syndicate rooms either side of each wing entrance (' + (sim.P.wings * sim.P.gdRoomsPerWing) + ' rooms). A company with two panels gets both syndicate rooms of one wing, since its Placecom volunteer stays in that wing, and the next company can use a room only ' + sim.P.gdSwitch + ' minutes after the last one leaves.</p>' +
      '<p class="muted">This run follows the <b>' + (mode === 'baseline' ? 'baseline fixed-block' : 'optimised') + '</b> GD timetable. Blue dots are students in a GD, white are walking via the central tracker, grey are waiting in the auditorium; dim dots have no GD today.</p>' +
      '<div class="btnrow"><button class="primary" id="btnGdPlay">Watch the GD day</button><button id="btnGdSkip">Skip to the end of the GD day</button></div></div>';
    $('#overlay').classList.remove('hidden'); state.pre = false;
    $('#btnGdPlay').addEventListener('click', () => { hideOverlay(); state.playing = true; $('#btnPlay').textContent = 'Pause'; });
    $('#btnGdSkip').addEventListener('click', () => { state.gd.t = state.gd.end; updateSide(); showGdSummary(); });
    updateSide();
  }
  function showGdSummary() {
    const g = state.gd; if (!g) return; const d = g.day, b = d.baseline, o = d.optimised, lb = d.lowerBound, P = sim.P;
    const rows = [
      ['Groups held', b.nGroups, o.nGroups],
      ['Last GD finished', PS.fmtTime(Math.round(b.end)), PS.fmtTime(Math.round(o.end))],
      ['Lower bound on the last finish', PS.fmtTime(Math.ceil(lb.value)), PS.fmtTime(Math.ceil(lb.value))],
      ['Companies given two panels', b.twoPanel, o.twoPanel],
      ['Panelist idle hours (panels waiting while their company is still running)', Math.round(b.panelIdle / 60), Math.round(o.panelIdle / 60)],
      ['Late (buffer) GDs timetabled after ' + PS.fmtTime(P.gdLatestStart) + ' · with two panels', b.latePlanned + ' · ' + (b.lateTwoPanel || 0), o.latePlanned + ' · ' + (o.lateTwoPanel || 0)],
      ['Companies actually starting after ' + PS.fmtTime(P.gdLatestStart), b.lateActual, o.lateActual],
      ['Groups held up by a member still in another GD', b.clashGroups, o.clashGroups],
      ['Groups running past ' + PS.fmtTime(P.gdDayEnd), b.lateGroups, o.lateGroups],
      ['Most GDs for one student', lb.maxGdsPerStudent, lb.maxGdsPerStudent],
    ];
    $('#overlay').innerHTML = '<div class="box"><h3>GD day before cluster ' + g.k + ' is over</h3><table><thead><tr><th>Measure</th><th class="' + (g.mode === 'baseline' ? 'activecol' : '') + '">Baseline (fixed blocks)</th><th class="' + (g.mode === 'optimised' ? 'activecol' : '') + '">Optimised</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('') + '</tbody></table>' +
      '<p class="muted">Each GD firm has now cut its list one step: defensive to competing, competing to confident, confident from 2X to ' + P.gdConfList + 'X.</p>' +
      '<div class="btnrow"><button class="primary" id="btnGdDone">Continue to cluster ' + g.k + ' decisions</button><button id="btnGdTab">Open the GD days tab</button></div></div>';
    $('#overlay').classList.remove('hidden');
    $('#btnGdDone').addEventListener('click', () => { state.gd = null; state.playing = false; $('#btnPlay').textContent = 'Play'; hideOverlay(); updateSide(); showPreCluster(); });
    $('#btnGdTab').addEventListener('click', () => { $('#gdCluster').dataset.want = g.k; document.querySelector('#tabs button[data-tab=gd]').click(); });
  }
  const MODE_NAME = { optimised: 'Optimised', baseline: 'Baseline', manual: 'Manual', 'bplan-omatch': 'Baseline plan + optimised matching', 'oplan-bmatch': 'Optimised plan + baseline matching' };
  const fmtFinish = (t) => PS.fmtTime(t) + (t >= 960 ? ' (next day)' : '');
  function decisionRows(d) {
    const P = sim.P;
    return [
      ['Firms opening at 8:00 am', s => s.at8],
      ['Firms opening later', s => s.later ? s.later + ' (' + s.openTimes.filter(x => x[0] > 0).map(x => x[1] + ' at ' + PS.fmtTime(x[0])).join(', ') + ')' : '0'],
      ['Panels planned', s => s.panels],
      ['Wings used (of ' + P.wings + ') · roles split across wings', s => (s.wingsUsed != null ? s.wingsUsed : '–') + ' · ' + (s.splitFirms || 0)],
      ['Planned rooms used (of ' + d.plannedRooms + ')', s => s.roomsUsed],
      ['Rooms handed over at noon', s => s.reused],
      ['Firms starting in a buffer room', s => s.noRoom],
      ['Firms planned to run past ' + PS.fmtTime(P.softStop), (s, m) => d.firms.filter(f => f.plans[m].close > P.softStop).length],
      ['Last planned finish', s => fmtFinish(s.lastClose)],
      ['Afternoon panels in handed-over rooms', s => s.afternoonPanels || 0],
      ['Plan cost: Σ hires × planned finish (hire-hours)', s => Math.round(s.cost / 60).toLocaleString('en-IN')],
      ['Gap to the lower bound (rooms relaxed)', s => Math.round(100 * (s.cost - d.lowerBound) / s.cost) + '%'],
      ['Improvement moves: savings, earlier openings, relocations', s => s.improve ? s.improve.savings + ', ' + s.improve.shifts + ', ' + s.improve.relocations : '–'],
      ['Wing packing: lower bound on wings · cost (exact finishes) with all wings → with the wings kept', s => s.packing ? s.packing.wingLB + ' · ' + Math.round(s.packing.zBest / 60).toLocaleString('en-IN') + ' → ' + Math.round(s.packing.z / 60).toLocaleString('en-IN') + ' hire-hours (' + s.packing.wingsUsed + ' wings)' : '–'],
    ];
  }
  function showPreCluster() {
    const d = sim.decisions && sim.decisions[sim.cluster]; if (!d || sim.dayOver || sim.t > 0) return;
    const rows = decisionRows(d);
    $('#overlay').innerHTML = '<div class="box"><h3>Cluster ' + d.cluster + ' · decisions made before the day</h3>' +
      '<p class="muted">' + d.pool + ' students in the pool' + (d.poolNoOffer != null ? ' (' + d.poolNoOffer + ' with no offer yet, ' + d.poolDreamers + ' placed earlier and dreaming in)' : '') + ', ' + d.firms.length + ' roles with ' + d.hires + ' hires, from ' + d.cohorts.length + ' cohorts. Shortlists are drawn; these are the scheduling decisions for tomorrow. This run follows the <b>' + MODE_NAME[sim.mode] + '</b> plan.</p>' +
      gdLine(d.cluster) +
      '<table><thead><tr><th>Decision</th>' + d.modes.map(m => '<th class="' + (m === sim.mode ? 'activecol' : '') + '">' + MODE_NAME[m] + (m === sim.mode ? ' (in use)' : '') + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(([lab, fn]) => '<tr><td>' + lab + '</td>' + d.modes.map(m => '<td>' + fn(d.summary[m], m) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' +
      '<div class="btnrow"><button class="primary" id="btnStartDay">Start the day</button><button id="btnSeeDecisions">See every firm\'s decision</button>' + (sim.gdDays && sim.gdDays[d.cluster] ? '<button id="btnSeeGd">See the GD day</button>' : '') + '</div></div>';
    $('#overlay').classList.remove('hidden'); state.pre = true;
    $('#btnStartDay').addEventListener('click', () => { hideOverlay(); state.playing = true; $('#btnPlay').textContent = 'Pause'; });
    $('#btnSeeDecisions').addEventListener('click', () => { $('#decCluster').dataset.want = d.cluster; document.querySelector('#tabs button[data-tab=decisions]').click(); });
    if ($('#btnSeeGd')) $('#btnSeeGd').addEventListener('click', () => { $('#gdCluster').dataset.want = d.cluster; document.querySelector('#tabs button[data-tab=gd]').click(); });
  }
  function gdLine(k) {
    const g = sim.gdDays && sim.gdDays[k]; if (!g) return '';
    const inv = g.companies.reduce((a, c) => a + c.invited, 0), o = g.optimised, b = g.baseline, use = sim.mode === 'baseline' ? b : o;
    return '<p class="muted"><b>GD day (yesterday):</b> ' + g.companies.length + ' companies held GDs for ' + inv + ' invitations in ' + use.nGroups + ' groups. The ' + (sim.mode === 'baseline' ? 'baseline block timetable' : 'optimised timetable') +
      ' finished at ' + PS.fmtTime(use.end) + ' (' + (sim.mode === 'baseline' ? 'optimised ' + PS.fmtTime(o.end) : 'baseline blocks ' + PS.fmtTime(b.end)) + '; lower bound ' + PS.fmtTime(Math.ceil(g.lowerBound.value)) + '). ' +
      'The GD firms below have already cut their lists one step after the GD.</p>';
  }

  function showClusterSummary() {
    const k = sim.cluster, c = sim.metrics.clusters[k]; if (!c) return;
    const rows = [
      ['Students in the pool', c.pool != null ? c.pool + ' (' + c.poolNoOffer + ' with no offer yet, ' + c.poolDreamers + ' dreaming in)' : '–'],
      ['Students placed this cluster', c.grossOffers + (c.targetGross ? ' (offers made ' + c.offersMade + ' of a target ' + c.hiresTarget + ')' : ' (target hires ' + c.hiresTarget + ')')],
      [c.targetGross ? 'Firms that made all their offers' : 'Firms that left with all their hires', c.filled + ' of ' + c.roles],
      ['Interviews held', c.interviews],
      ['Wasted interviews (rejected or dropped holds)', c.wasted],
      [c.targetGross ? 'Hires lost to released holds' : 'Hires lost after a firm left', c.lostHolds],
      ['Dream conversions into this cluster', c.dreamConversions],
      ['Panel idle hours', c.idleHours],
      ['Peak rooms in use · buffer openings', c.peakRooms + ' · ' + c.bufferOpenings],
      ['Last firm left at', PS.fmtTime(c.endTime)],
    ];
    const next = k < 3 ? 'Continue to cluster ' + (k + 1) : 'Finish placement';
    $('#overlay').innerHTML = '<div class="box"><h3>Cluster ' + k + ' complete</h3><table>' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>' +
      '<p class="muted">' + (k < 3 ? 'At the end of the cluster, holds become accepted and about ' + Math.round(sim.P.dreamShare * 100) + '% of placed students dream into later clusters.' : '') + '</p>' +
      '<button class="primary" id="btnNext">' + next + '</button></div>';
    $('#overlay').classList.remove('hidden');
    $('#btnNext').addEventListener('click', () => { continueCluster(); });
  }
  function showFinal() {
    const M = sim.metrics; const placed = sim.students.length - M.unplaced;
    $('#overlay').innerHTML = '<div class="box"><h3>Placement complete</h3><table>' +
      '<tr><td>Students placed</td><td>' + placed + ' of ' + sim.students.length + '</td></tr>' +
      '<tr><td>Net placements by cluster</td><td>' + M.net[1] + ' / ' + M.net[2] + ' / ' + M.net[3] + '</td></tr>' +
      '<tr><td>Dream conversions</td><td>' + M.dreamConversions + '</td></tr>' +
      '<tr><td>Hires lost (holds after leaving + dreams)</td><td>' + (M.lostHolds + M.lostToDream) + '</td></tr>' +
      '</table><button class="primary" id="btnSeeResults">See full results</button></div>';
    $('#overlay').classList.remove('hidden');
    $('#btnSeeResults').addEventListener('click', () => document.querySelector('#tabs button[data-tab=results]').click());
  }

  // ------------------------------------------------------------------ side panel
  let logRendered = 0;
  function updateSide() {
    if (state.gd) {
      const g = state.gd, t = g.t, G = g.day[g.mode].groups;
      $('#clusterLabel').textContent = 'GD day · before cluster ' + g.k; $('#clock').textContent = PS.fmtTime(Math.floor(Math.max(0, t)));
      const now = G.filter(x => t >= x.start && t < x.end), done = G.filter(x => x.end <= t);
      const left = new Set(); G.forEach(x => { if (x.end > t) x.members.forEach(id => left.add(id)); });
      const comps = new Set(G.map(x => x.comp)), fin = [...comps].filter(c => G.every(x => x.comp !== c || x.end <= t)).length;
      const C = [['GD rooms in use', now.length + ' / ' + (sim.P.wings * sim.P.gdRoomsPerWing)], ['Students in a GD', now.reduce((a, x) => a + x.size, 0)], ['Groups finished', done.length + ' / ' + G.length], ['Companies finished', fin + ' / ' + comps.size],
        ['Students with GDs left', left.size], ['GD day ends', PS.fmtTime(sim.P.gdDayEnd)]];
      $('#counters').innerHTML = C.map(c => '<div class="counter"><div class="v">' + c[1] + '</div><div class="k">' + c[0] + '</div></div>').join('');
      // GD event log (the normal log is rebuilt when the GD day ends)
      const ev = [];
      G.forEach(x => { const where = 'wing ' + PS.wingLabel(x.wing) + ', syndicate ' + (x.slot + 1);
        if (x.start <= t) ev.push([x.start, 1, 'open', esc(x.comp) + ' GD starts in ' + where + ' with ' + x.size + ' students.']);
        if (x.end <= t) ev.push([x.end, 2, 'accept', esc(x.comp) + ' GD ends in ' + where + '.']); });
      ev.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      $('#log').innerHTML = ev.slice(0, 120).map(e => '<div class="k-' + e[2] + '"><span class="tm">GD ' + PS.fmtTime(Math.round(e[0])) + '</span>' + e[3] + '</div>').join('');
      logRendered = 1e9; return;
    }
    $('#clusterLabel').textContent = 'Cluster ' + Math.max(1, sim.cluster);
    $('#clock').textContent = PS.fmtTime(Math.max(0, sim.t));
    const F = sim.firms || []; const st = sim.students;
    const open = F.filter(f => f.state === 'open' || f.state === 'closing').length, closed = F.filter(f => f.state === 'closed').length;
    const inInt = st.filter(s => s.loc === 'room').length, holding = st.filter(s => s.holdFirm != null && !s.cAccepted).length;
    const placedToday = st.filter(s => s.cAccepted && s.offerCluster === sim.cluster).length;
    const totalPlaced = st.filter(s => s.offer != null && (s.status === 'final' || s.cAccepted || s.status === 'dreaming')).length;
    const ds = sim.dayStats || {};
    const C = [['Firms open', open], ['Firms left', closed + ' / ' + F.length], ['In interviews', inInt], ['Holding offers', holding], ['Placed this cluster', placedToday], ['Placed overall', totalPlaced + ' / ' + st.length], ['Interviews', ds.interviews || 0], ['Buffer rooms used', ds.bufferOpenings || 0]];
    $('#counters').innerHTML = C.map(c => '<div class="counter"><div class="v">' + c[1] + '</div><div class="k">' + c[0] + '</div></div>').join('');
    const L = sim.log; const box = $('#log');
    if (logRendered > L.length) { box.innerHTML = ''; logRendered = 0; }
    const frag = [];
    for (let i = logRendered; i < L.length; i++) { const e = L[i]; frag.push('<div class="k-' + e.kind + '"><span class="tm">C' + e.cluster + ' ' + PS.fmtTime(e.t) + '</span>' + esc(e.text) + '</div>'); }
    if (frag.length) { box.insertAdjacentHTML('afterbegin', frag.reverse().join('')); logRendered = L.length; while (box.childNodes.length > 400) box.removeChild(box.lastChild); }
  }

  // ------------------------------------------------------------------ tooltip
  canvas.addEventListener('mousemove', (ev) => {
    const r = canvas.getBoundingClientRect(); const x = (ev.clientX - r.left) * PS.CANVAS_W / r.width, y = (ev.clientY - r.top) * PS.CANVAS_H / r.height;
    const h = state.gd ? renderer.hit(sim, state.gd.t, x, y, state.gd) : renderer.hit(sim, sim.t, x, y); const tip = $('#tooltip');
    if (!h) { tip.classList.add('hidden'); return; }
    let html = '';
    if (h.type === 'tracker') {
      html = '<b>Central tracker</b><br>Every student checks in here on the way to a wing and on the way back: about ' + (sim.P.transit / 2) + ' min to reach it and check in, then ' + (sim.P.transit / 2) + ' min on to the wing.';
    } else if (h.type === 'gdroom') {
      html = '<b>Wing ' + PS.wingLabel(h.wing) + ', syndicate room ' + (h.slot + 1) + '</b><br>Beside the Placecom desk at the wing entrance. Used for group discussions on GD days.';
      if (h.group) html += '<br>Now: ' + esc(h.group.comp) + ' GD, ' + h.group.size + ' students, until ' + PS.fmtTime(Math.round(h.group.end));
    } else if (h.type === 'gdstudent') {
      const s = h.s, q = h.q, segs = (renderer.gdPrep(state.gd).segs.get(s.id) || []);
      html = '<b>' + esc(s.name) + '</b><br>' + ({ gd: 'In a GD', walk: 'Walking', wait: 'Waiting for the next GD', done: 'Done with GDs for today', none: 'No GD today' })[q.kind];
      if (q.seg) html += ' with ' + esc(q.seg.g.comp);
      if (segs.length) html += '<br>GDs today: ' + segs.map(x => esc(x.g.comp) + ' ' + PS.fmtTime(x.g.start)).join(', ');
    } else if (h.type === 'student') {
      const s = h.s; const st = s.cAccepted ? 'Placed (accepted, waiting)' : s.holdFirm != null ? 'Holding an offer, clock ' + Math.round(s.holdClock) + ' min' : s.status === 'dreaming' ? 'Dreaming' : !s.active ? 'Not in this cluster' : s.loc === 'room' ? 'In interview' : 'Waiting';
      html = '<b>' + esc(s.name) + '</b><br>' + st;
      if (s.busyFirm) html += '<br>With ' + esc(s.busyFirm.label);
      if (s.offer != null) html += '<br>Offer: ' + esc(sim.roles[s.offer].company);
      if (s.active && s.nRanked) html += '<br>' + s.nRanked + ' roles ranked this cluster';
    } else {
      const rm = h.r; const f = rm.firm; html = '<b>Wing ' + PS.wingLabel(rm.wing) + ', room ' + (rm.slot + 1) + '</b> · ' + PS.FLOOR_NAMES[PS.wingFloor(rm.wing)].toLowerCase() + (rm.buffer ? ' (buffer)' : '');
      if (f) { html += '<br>' + esc(f.label) + '<br>' + (sim.P.targetGross ? 'Offers ' + sim.count(f) + ' of ' + f.X + ' · hires ' + sim.hires(f) : 'Hires ' + sim.count(f) + ' of ' + f.X) + ' · ' + f.interviews + ' interviews<br>' + (f.role.inter === 2 ? 'Two interactions' : 'One interaction') + ' · ' + f.strategy + ' list (' + f.hotSize + ' hot / ' + f.listSize + ')'; const p = f.panels.find(q => q.room === rm); if (p && p.student) html += '<br>Now: ' + esc(p.student.name) + ' (round ' + p.round + ', until ' + PS.fmtTime(p.endAt) + ')'; }
      else html += '<br>Empty';
    }
    tip.innerHTML = html; tip.classList.remove('hidden');
    const sr = canvas.parentElement.getBoundingClientRect();
    tip.style.left = Math.min(ev.clientX - sr.left + 14, sr.width - 290) + 'px'; tip.style.top = (ev.clientY - sr.top + 14) + 'px';
  });
  canvas.addEventListener('mouseleave', () => $('#tooltip').classList.add('hidden'));

  // ------------------------------------------------------------------ plan vs actual
  // every cluster and GD day already run stays viewable: finished clusters keep their roles in sim.allFirms
  let planChoice = null, planSim = null;
  const planFirmsOf = (k) => { const done = (sim.allFirms || []).filter(f => f.role.cluster === k); if (done.length) return done; return sim.cluster === k && sim.firms ? sim.firms : []; };
  const planGdMode = () => (sim.planMode === 'baseline' && sim.matchMode === 'baseline') ? 'baseline' : 'optimised';
  function planViews() {
    const v = [];
    for (const k of [1, 2, 3]) {
      if (k > 1 && sim.gdDays && sim.gdDays[k]) v.push(['g' + k, 'GD day before cluster ' + k]);
      if (planFirmsOf(k).length) v.push(['c' + k, 'Cluster ' + k + (sim.cluster === k && !sim.dayOver ? ' (running)' : '')]);
    }
    return v;
  }
  function drawGantt(rows, tMax, lines, nowT) {
    const g = $('#gantt'); const rowH = 16, top = 30, left = 250, width = 1180;
    const dpr = window.devicePixelRatio || 1; const height = top + rows.length * rowH + 20;
    g.width = width * dpr; g.height = height * dpr; g.style.width = width + 'px'; g.style.height = height + 'px';
    const ctx = g.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const X = (t) => left + (t / tMax) * (width - left - 20);
    ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (let h = 0; h <= tMax; h += 60) { ctx.strokeStyle = '#eee9df'; ctx.beginPath(); ctx.moveTo(X(h), top - 8); ctx.lineTo(X(h), height - 10); ctx.stroke(); ctx.fillStyle = '#6b7380'; ctx.textAlign = 'center'; ctx.fillText(PS.fmtTime(h).replace(':00', ''), X(h), 12); }
    for (const t of lines) { ctx.strokeStyle = '#d0555b'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(t), top - 8); ctx.lineTo(X(t), height - 10); ctx.stroke(); ctx.setLineDash([]); }
    if (nowT != null) { ctx.strokeStyle = '#1f5fbf'; ctx.beginPath(); ctx.moveTo(X(nowT), top - 8); ctx.lineTo(X(nowT), height - 10); ctx.stroke(); }
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = '#1d232b'; ctx.textAlign = 'right'; ctx.fillText((r.label.length > 38 ? r.label.slice(0, 37) + '…' : r.label), left - 8, y + rowH / 2);
      if (r.pOpen != null) { ctx.strokeStyle = r.color; ctx.lineWidth = 1.2; ctx.strokeRect(X(r.pOpen), y + 2, Math.max(2, X(r.pClose) - X(r.pOpen)), rowH - 4); ctx.lineWidth = 1; }
      if (r.aOpen != null) { ctx.fillStyle = r.color; ctx.globalAlpha = 0.75; ctx.fillRect(X(r.aOpen), y + 5, Math.max(2, X(r.aClose) - X(r.aOpen)), rowH - 10); ctx.globalAlpha = 1; }
    });
  }
  const median = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  function renderPlan() {
    if (planSim !== sim) { planSim = sim; planChoice = null; }
    const views = planViews(); const sel = $('#planView');
    if (!views.length) { sel.innerHTML = ''; $('#planSummary').textContent = 'Nothing has run yet. Start a day to see its plan against what happened.'; drawGantt([], sim.P.hardStop, [], null); $('#planTable').innerHTML = ''; return; }
    const view = planChoice && views.some(v => v[0] === planChoice) ? planChoice : views[views.length - 1][0];
    sel.innerHTML = views.map(([v, lab]) => '<option value="' + v + '"' + (v === view ? ' selected' : '') + '>' + lab + '</option>').join('');
    const k = +view.slice(1);
    if (view[0] === 'g') { renderPlanGd(k); return; }
    const F = planFirmsOf(k).slice().sort((a, b) => a.planOpen - b.planOpen || b.role.pop - a.role.pop);
    const live = sim.cluster === k && !sim.dayOver;
    drawGantt(F.map(f => ({ label: f.label, color: PS.firmColor(f.name), pOpen: f.planOpen, pClose: f.planClose, aOpen: f.actualOpen, aClose: f.actualClose != null ? f.actualClose : sim.t })), sim.P.hardStop, [sim.P.softStop], live ? sim.t : null);
    const opened = F.filter(f => f.actualOpen != null), lateOpen = opened.filter(f => f.actualOpen > f.planOpen), closed = F.filter(f => f.actualClose != null), lateClose = closed.filter(f => f.actualClose > f.planClose);
    $('#planSummary').textContent = F.length + ' roles' + (live ? ' (cluster still running)' : '') + ' · opened later than planned: ' + lateOpen.length + (lateOpen.length ? ' (median ' + median(lateOpen.map(f => f.actualOpen - f.planOpen)) + ' min)' : '') +
      ' · left after the planned close: ' + lateClose.length + ' of ' + closed.length + ' · reached target X: ' + F.filter(f => sim.count(f) >= f.X).length;
    const rows = F.map(f => {
      const rooms = PS.roomsText(f.planRooms, f.planOpen);
      return '<tr><td><span class="swatch" style="background:' + PS.firmColor(f.name) + '"></span>' + esc(f.label) + '</td><td>' + esc(f.role.cohort) + '</td><td class="num">' + Math.round(f.popPct * 100) + '%</td><td>' + f.strategy + '</td><td class="num">' + f.X + '</td><td class="num">' + f.hotSize + ' / ' + f.listSize + '</td><td class="num">' + PS.fmtTime(f.planOpen) + '</td><td class="num">' + f.planPanels + '</td><td>' + rooms + '</td><td class="num">' + PS.fmtTime(f.planClose) + '</td><td class="num">' + (f.actualOpen != null ? PS.fmtTime(f.actualOpen) : '–') + '</td><td class="num">' + (f.actualClose != null ? PS.fmtTime(f.actualClose) : '–') + '</td><td class="num">' + (sim.P.targetGross ? sim.count(f) + ' · ' + sim.hires(f) : sim.count(f)) + '</td><td class="num">' + f.interviews + '</td><td class="num">' + Math.round(f.idle / 60 * 10) / 10 + '</td><td class="num">' + f.extensions + '</td></tr>';
    }).join('');
    $('#planTable').innerHTML = '<thead><tr><th>Firm and role</th><th>Cohort</th><th class="num">Popularity in cluster</th><th>List strategy</th><th class="num">Target X</th><th class="num">Hot / list</th><th class="num">Planned open</th><th class="num">Panels</th><th>Rooms</th><th class="num">Planned close</th><th class="num">Opened</th><th class="num">Left</th><th class="num">' + (sim.P.targetGross ? 'Offers made · hires' : 'Hires made') + '</th><th class="num">Interviews</th><th class="num">Idle panel hours</th><th class="num">Extensions</th></tr></thead><tbody>' + rows + '</tbody>';
  }
  function renderPlanGd(k) {
    const mode = planGdMode(), d = sim.gdDays[k][mode], P = sim.P;
    const C = d.perComp.slice().sort((a, b) => (a.plannedStart ?? 1e9) - (b.plannedStart ?? 1e9));
    const tMax = Math.ceil(Math.max(P.gdDayEnd, d.end || 0, ...C.map(c => c.plannedEnd || 0)) / 60) * 60 + 60;
    drawGantt(C.map(c => ({ label: c.name, color: PS.firmColor(c.name), pOpen: c.plannedStart, pClose: c.plannedEnd, aOpen: c.start, aClose: c.end })), tMax, [P.gdLatestStart, P.gdDayEnd], null);
    const st = C.filter(c => c.start != null && c.plannedStart != null), lateS = st.filter(c => c.start > c.plannedStart), lateE = st.filter(c => c.end > c.plannedEnd);
    $('#planSummary').textContent = C.length + ' companies, ' + (mode === 'baseline' ? 'baseline' : 'optimised') + ' timetable (the one this mode uses) · started later than planned: ' + lateS.length + (lateS.length ? ' (median ' + Math.round(median(lateS.map(c => c.start - c.plannedStart))) + ' min)' : '') +
      ' · ended after the planned end: ' + lateE.length + ' · last GD ends ' + PS.fmtTime(Math.round(d.end)) + '. Dashed lines: latest normal start (later starts are late buffer GDs) and end of the GD day.';
    const f = (t) => t != null ? PS.fmtTime(Math.round(t)) : '–';
    $('#planTable').innerHTML = '<thead><tr><th>Company</th><th class="num">Panels</th><th class="num">Wing</th><th class="num">Groups</th><th class="num">Planned start</th><th class="num">Planned end</th><th class="num">Started</th><th class="num">Ended</th><th class="num">Start delay (min)</th><th class="num">Panelist idle (min)</th><th class="num">Invitees not grouped</th></tr></thead><tbody>' +
      C.map(c => '<tr><td><span class="swatch" style="background:' + PS.firmColor(c.name) + '"></span>' + esc(c.name) + (c.late ? ' <span class="tag late">late buffer</span>' : '') + '</td><td class="num">' + c.panels + '</td><td class="num">' + (c.wing != null ? PS.wingLabel(c.wing) : '–') + '</td><td class="num">' + (Array.isArray(c.groups) ? c.groups.length : c.groups) + '</td><td class="num">' + f(c.plannedStart) + '</td><td class="num">' + f(c.plannedEnd) + '</td><td class="num">' + f(c.start) + '</td><td class="num">' + f(c.end) + '</td><td class="num">' + (c.start != null && c.plannedStart != null ? Math.max(0, Math.round(c.start - c.plannedStart)) : '–') + '</td><td class="num">' + c.idle + '</td><td class="num">' + (c.left || 0) + '</td></tr>').join('') + '</tbody>';
  }
  $('#planView').addEventListener('change', () => { planChoice = $('#planView').value; renderPlan(); });

  // ------------------------------------------------------------------ students: the central tracker, student by student
  const STU_ROUNDS = { c1pi: [1, 'PI', 'Cluster 1'], c2gd: [2, 'GD', 'Cluster 2 GD'], c2pi: [2, 'PI', 'Cluster 2 PI'], c3gd: [3, 'GD', 'Cluster 3 GD'], c3pi: [3, 'PI', 'Cluster 3 PI'] };
  let stuSel = null;
  const tm = (x) => x != null ? PS.fmtTime(Math.round(x)) : '–';
  const roomOf = (h) => h.wing != null ? 'Wing ' + PS.wingLabel(h.wing) + ' · ' + (h.slot + 1) + (h.buffer ? ' (buffer)' : '') : '–';
  const roleName = (i) => sim.roles[i] ? sim.roles[i].company + ' – ' + sim.roles[i].role : '';
  function stuState(s) {
    const C = (k, text) => ({ key: k, color: 'var(--c-' + ({ free: 'free', walk: 'walk', int: 'int', hold: 'hold', placed: 'placed', dream: 'dream', out: 'out' })[k] + ')', text });
    if (sim.finished) return s.offer != null ? C('placed', 'Placed: ' + roleName(s.offer) + ' (cluster ' + s.offerCluster + (s.offerRank ? ', rank ' + s.offerRank : '') + (s.finalHow === 'dream' ? ', dream' : '') + ')') : C('free', 'Unplaced');
    if (s.loc === 'walkTo') return C('walk', 'Walking to ' + (s.busyFirm ? s.busyFirm.label : 'an interview'));
    if (s.loc === 'walkBack') return C('walk', 'Walking back to the auditorium');
    if (s.loc === 'room') return C('int', 'In interview: ' + (s.busyFirm ? s.busyFirm.label : ''));
    if (s.status === 'dreaming' && s.active) return C('dream', 'Dreaming in (' + s.nRanked + ' dream application' + (s.nRanked === 1 ? '' : 's') + ')');
    if (s.cAccepted) return C('placed', 'Placed this cluster: ' + roleName(s.offer));
    if (s.holdFirm != null) return C('hold', 'Holding ' + roleName(s.holdFirm) + ' (' + Math.max(0, Math.round(s.holdClock)) + ' min left on the clock)');
    if (!s.active) return s.status === 'dreaming' ? C('dream', 'Dreaming (no applications in this cluster)') : s.offer != null ? C('out', 'Placed in cluster ' + s.offerCluster + ': ' + roleName(s.offer)) : C('out', 'Out of this cluster');
    return C('free', 'Waiting');
  }
  const recsOf = (s, round) => (s.hist || []).filter(h => h.type !== 'event' && (round === 'all' || (h.k === STU_ROUNDS[round][0] && h.type === STU_ROUNDS[round][1])));
  const outClass = (o) => /accepted/.test(o) ? 'o-acc' : /held/.test(o) ? 'o-hold' : /rejected/.test(o) ? 'o-rej' : /round 2|Listed/.test(o) ? 'o-r2' : /In interview/.test(o) ? 'o-now' : 'o-no';
  const OUT_RANK = ['Dream offer, accepted', 'Offer, accepted', 'Offer, held', 'Offer, rejected', 'Through to round 2', 'In interview'];
  function cellSummary(s, round) {
    const [k, type] = STU_ROUNDS[round]; const r = s.rounds && s.rounds[k]; const recs = recsOf(s, round);
    if (!r && !recs.length) return '<span class="muted">–</span>';
    if (type === 'GD') {
      if (!recs.length) return '<span class="muted">no GD</span>';
      const listed = recs.filter(h => /^Listed/.test(h.outcome)).length;
      return recs.length + ' GD' + (recs.length > 1 ? 's' : '') + ' · <span class="' + (listed ? 'o-r2' : 'o-no') + '">listed by ' + listed + '</span>';
    }
    const tag = r && r.pool === 'dreaming' ? '<span class="chip c-dream">dreaming in</span> ' : r && r.pool === 'out' ? '<span class="muted">out</span> ' : '';
    if (!recs.length) return tag + (r && r.pool !== 'out' ? '<span class="muted">no interview</span>' : '');
    // the last word from each role (round 2 supersedes round 1), then the best of those
    const last = new Map(); for (const h of recs) last.set(h.roleIdx, h);
    const fin = [...last.values()].sort((a, b) => (OUT_RANK.indexOf(a.outcome) + 99) % 99 - (OUT_RANK.indexOf(b.outcome) + 99) % 99)[0];
    let txt = OUT_RANK.indexOf(fin.outcome) < 0 ? 'no offer' : fin.outcome.replace('Offer, ', 'offer ').toLowerCase();
    if (fin.outcome === 'Offer, held') { const ev = (s.hist || []).filter(e => e.type === 'event' && e.k === k);
      txt += ev.some(e => e.text.startsWith('Held offer of ' + fin.firm + ' became')) ? ', then accepted' : ev.some(e => e.text === 'Released the held offer of ' + fin.firm) ? ', then released' : (s.offer === fin.roleIdx ? ', then accepted' : ''); }
    return tag + recs.length + ' PI · ' + last.size + ' role' + (last.size === 1 ? '' : 's') + ' · <span class="' + outClass(fin.outcome) + '">' + esc(txt) + '</span>';
  }
  function poolText(s, k) {
    const r = s.rounds && s.rounds[k]; if (!r) return '<span class="muted">not started</span>';
    if (r.pool === 'out') return '<span class="muted">out</span>';
    if (r.pool === 'dreaming') return '<span class="chip c-dream">dreaming in</span> ' + r.apps + ' dream application' + (r.apps === 1 ? '' : 's');
    return 'No offer yet · ' + r.apps + ' applications · on ' + r.hot + ' hotlist' + (r.hot === 1 ? '' : 's') + ', ' + r.short + ' shortlist' + (r.short === 1 ? '' : 's');
  }
  function roundStats() {
    const rows = [];
    for (const [key, [k, type, lab]] of Object.entries(STU_ROUNDS)) {
      const recs = [].concat(...sim.students.map(s => recsOf(s, key).map(h => ({ h, s }))));
      if (!recs.length && !(sim.poolInfo && sim.poolInfo[k])) continue;
      const pi = sim.poolInfo && sim.poolInfo[k]; const who = new Set(recs.map(x => x.s.id));
      const o = (re) => recs.filter(x => re.test(x.h.outcome)).length;
      rows.push('<tr><td>' + lab + '</td><td class="num">' + (pi ? pi.total : '–') + '</td><td class="num">' + (pi ? pi.noOffer : '–') + '</td><td class="num">' + (pi ? pi.dreamers : '–') + '</td><td class="num">' + who.size + '</td><td class="num">' + recs.length + '</td><td>' +
        (type === 'GD' ? 'listed after GD ' + o(/^Listed/) + ' · not listed ' + o(/^Not listed/) + ' · no group formed ' + o(/no group/)
          : 'offers ' + o(/^(Dream offer|Offer)/) + ' (accepted ' + o(/accepted/) + ', held ' + o(/held/) + ', rejected ' + o(/rejected/) + ') · to round 2 ' + o(/Through to round 2/) + ' · no offer ' + o(/No offer|Not through|no offer/) + (o(/In interview/) ? ' · in interview now ' + o(/In interview/) : '')) + '</td></tr>');
    }
    return rows.length ? '<div class="card"><h3>Rounds so far</h3><div class="tablewrap"><table class="data"><thead><tr><th>Round</th><th class="num">Pool</th><th class="num">No offer yet</th><th class="num">Dreaming in</th><th class="num">Students sent</th><th class="num">' + 'Sends' + '</th><th>Outcomes</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div><p class="muted">The pool counts students active in that cluster: those with no offer yet and those placed earlier who dream into it. GD rounds use the same pool as the cluster that follows.</p></div>' : '';
  }
  function renderStudents() {
    if (!sim) return;
    const round = $('#stuRound').value, view = $('#stuView').value, stf = $('#stuStatus').value, q = $('#stuFind').value.trim().toLowerCase();
    $('#stuSummary').innerHTML = roundStats();
    const match = (s) => {
      const st = stuState(s); if (stf !== 'all' && !(stf === st.key || (stf === 'busy' && (st.key === 'walk' || st.key === 'int')))) return false;
      if (!q) return true; if (s.name.toLowerCase().includes(q)) return true;
      return (s.hist || []).some(h => ((h.firm || h.company || h.text || '') + '').toLowerCase().includes(q));
    };
    let html = '';
    if (view === 'log') {
      const rows = [].concat(...sim.students.filter(match).map(s => recsOf(s, round).map(h => ({ h, s }))));
      rows.sort((a, b) => a.h.k - b.h.k || (a.h.sent ?? 1e9) - (b.h.sent ?? 1e9) || (a.h.type === 'GD') - (b.h.type === 'GD'));
      html = '<thead><tr><th>Round</th><th class="num">Sent</th><th>Student</th><th>To</th><th>Stage</th><th>Room</th><th class="num">Started</th><th class="num">Ended</th><th class="num">Back at seat</th><th>Outcome</th></tr></thead><tbody>' +
        rows.map(({ h, s }) => '<tr><td>Cluster ' + h.k + ' ' + h.type + '</td><td class="num">' + tm(h.sent) + '</td><td><a href="#" class="stulink" data-sid="' + s.id + '">' + esc(s.name) + '</a></td><td class="to">' + esc(h.firm || h.company) + '</td><td>' + (h.type === 'GD' ? 'GD' + (h.size ? ', group of ' + h.size : '') : 'Round ' + h.round + ', ' + h.list + (h.rank ? ', rank ' + h.rank : '')) + '</td><td>' + roomOf(h) + '</td><td class="num">' + tm(h.start) + '</td><td class="num">' + tm(h.end) + '</td><td class="num">' + tm(h.back) + '</td><td class="' + outClass(h.outcome) + '">' + esc(h.outcome) + '</td></tr>').join('') + '</tbody>';
      $('#stuCount').textContent = rows.length + ' send' + (rows.length === 1 ? '' : 's') + ' shown.';
    } else if (round === 'all') {
      const S = sim.students.filter(match);
      html = '<thead><tr><th>Student</th><th>Now</th>' + Object.values(STU_ROUNDS).map(r => '<th>' + r[2] + '</th>').join('') + '</tr></thead><tbody>' +
        S.map(s => { const st = stuState(s); return '<tr><td><a href="#" class="stulink" data-sid="' + s.id + '">' + esc(s.name) + '</a></td><td class="now"><i class="dot" style="background:' + st.color + '"></i>' + esc(st.text) + '</td>' + Object.keys(STU_ROUNDS).map(r => '<td>' + cellSummary(s, r) + '</td>').join('') + '</tr>'; }).join('') + '</tbody>';
      $('#stuCount').textContent = S.length + ' of ' + sim.students.length + ' students shown.';
    } else {
      const [k] = STU_ROUNDS[round];
      const S = sim.students.filter(s => match(s) && (recsOf(s, round).length || (s.rounds && s.rounds[k] && s.rounds[k].pool !== 'out') || stf === 'out'));
      const first = (s) => { const r = recsOf(s, round).map(h => h.sent ?? 1e9); return r.length ? Math.min(...r) : 1e9; };
      S.sort((a, b) => first(a) - first(b) || a.id - b.id);
      html = '<thead><tr><th>Student</th><th>In the pool as</th><th>Now</th><th class="num">Sends</th><th>Schedule (sent → back at seat, where, outcome)</th></tr></thead><tbody>' +
        S.map(s => { const st = stuState(s), recs = recsOf(s, round).sort((a, b) => (a.sent ?? 1e9) - (b.sent ?? 1e9));
          return '<tr><td><a href="#" class="stulink" data-sid="' + s.id + '">' + esc(s.name) + '</a></td><td class="pool">' + poolText(s, k) + '</td><td class="now"><i class="dot" style="background:' + st.color + '"></i>' + esc(st.text) + '</td><td class="num">' + recs.length + '</td><td class="sched">' +
            (recs.length ? recs.map(h => '<div><b>' + tm(h.sent) + '–' + tm(h.back) + '</b> ' + esc(h.firm || h.company) + (h.type === 'PI' ? ' <span class="muted">(R' + h.round + ', ' + h.list + ')</span>' : '') + ' · ' + roomOf(h) + ' · <span class="' + outClass(h.outcome) + '">' + esc(h.outcome) + '</span></div>').join('') : '<span class="muted">nothing scheduled</span>') + '</td></tr>'; }).join('') + '</tbody>';
      $('#stuCount').textContent = S.length + ' student' + (S.length === 1 ? '' : 's') + ' shown.';
    }
    $('#stuTable').innerHTML = html;
    renderStudentDetail();
  }
  function renderStudentDetail() {
    const s = stuSel != null ? sim.students[stuSel] : null; if (!s) { $('#stuDetail').innerHTML = ''; return; }
    const st = stuState(s); const H = (s.hist || []).slice().sort((a, b) => a.k - b.k || (a.type === 'GD' ? 0 : 1) - (b.type === 'GD' ? 0 : 1) || ((a.sent ?? a.t ?? 1e9) - (b.sent ?? b.t ?? 1e9)));
    const pools = [1, 2, 3].map(k => '<span>Cluster ' + k + ': ' + poolText(s, k) + '</span>').join('<br>');
    $('#stuDetail').innerHTML = '<div class="card"><div class="row-inline" style="justify-content:space-between;margin-top:0"><h3 style="margin:0">' + esc(s.name) + '</h3><button id="stuClose">Close</button></div>' +
      '<p><i class="dot" style="background:' + st.color + '"></i>' + esc(st.text) + (s.offer != null && !sim.finished ? ' · current offer: ' + esc(roleName(s.offer)) : '') + '</p><p class="muted">' + pools + '</p>' +
      '<div class="tablewrap"><table class="data"><thead><tr><th>Round</th><th class="num">Sent</th><th>What</th><th>Room</th><th class="num">Started</th><th class="num">Ended</th><th class="num">Back at seat</th><th>Outcome</th></tr></thead><tbody>' +
      (H.length ? H.map(h => h.type === 'event'
        ? '<tr class="evrow"><td>Cluster ' + h.k + '</td><td class="num">' + tm(h.t) + '</td><td colspan="6">' + esc(h.text) + '</td></tr>'
        : '<tr><td>Cluster ' + h.k + ' ' + h.type + '</td><td class="num">' + tm(h.sent) + '</td><td>' + esc(h.firm || h.company) + (h.type === 'PI' ? ' <span class="muted">(round ' + h.round + ', ' + h.list + (h.rank ? ', ranked ' + h.rank : '') + ')</span>' : h.size ? ' <span class="muted">(group of ' + h.size + ')</span>' : '') + '</td><td>' + roomOf(h) + '</td><td class="num">' + tm(h.start) + '</td><td class="num">' + tm(h.end) + '</td><td class="num">' + tm(h.back) + '</td><td class="' + outClass(h.outcome) + '">' + esc(h.outcome) + '</td></tr>').join('')
        : '<tr><td colspan="8" class="muted">Nothing yet.</td></tr>') + '</tbody></table></div></div>';
  }
  ['#stuRound', '#stuView', '#stuStatus'].forEach(id => $(id).addEventListener('change', renderStudents));
  $('#stuFind').addEventListener('input', renderStudents);
  $('#tab-students').addEventListener('click', (e) => {
    const a = e.target.closest('.stulink'); if (a) { e.preventDefault(); stuSel = +a.dataset.sid; renderStudentDetail(); $('#stuDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    if (e.target.id === 'stuClose') { stuSel = null; renderStudentDetail(); }
  });
  let stuLast = 0, stuKey = '';

  // ------------------------------------------------------------------ results
  function clusterTable(M) {
    const K = [1, 2, 3].filter(k => M.clusters[k]);
    if (!K.length) return '<p class="muted">No cluster has finished yet. Play or skip a day to see results.</p>';
    const r = (lab, fn) => '<tr><td>' + lab + '</td>' + K.map(k => '<td class="num">' + fn(M.clusters[k], k) + '</td>').join('') + '</tr>';
    const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
    return '<table class="data"><thead><tr><th>Metric</th>' + K.map(k => '<th class="num">Cluster ' + k + '</th>').join('') + '</tr></thead><tbody>' +
      r('Students in the pool', c => c.pool != null ? c.pool : '–') + r('&nbsp;&nbsp;with no offer yet', c => c.poolNoOffer != null ? c.poolNoOffer : '–') + r('&nbsp;&nbsp;placed earlier, dreaming in', c => c.poolDreamers != null ? c.poolDreamers : '–') +
      r('Roles', c => c.roles) + r(sim.P.targetGross ? 'Target offers (sum of X, gross)' : 'Target hires (sum of X)', c => c.hiresTarget) + r('Students placed (net)', c => c.grossOffers) +
      r(sim.P.targetGross ? 'Firms that made all X offers' : 'Firms that filled X', c => c.filled + ' (' + pct(c.filled, c.roles) + ')') + r('Interviews held', c => c.interviews) + r('Offers made', c => c.offersMade) +
      r('Wasted interviews', c => c.wasted) + r(sim.P.targetGross ? 'Hires lost to released holds' : 'Hires lost after firm left', c => c.lostHolds) + r('Dream conversions into cluster', c => c.dreamConversions) + r('Students who dreamed onwards', c => c.dreamers != null ? c.dreamers : '–') +
      r('Placed at rank 1', c => c.ranks.r1) + r('Placed in top 10% of list', c => c.ranks.top10) + r('Placed in 10–25%', c => c.ranks.top25) + r('Placed in 25–50%', c => c.ranks.top50) + r('Placed below 50%', c => c.ranks.rest) +
      r('Panel idle hours', c => c.idleHours) + r('Peak rooms in use', c => c.peakRooms) + r('Buffer room openings', c => c.bufferOpenings) + r('Shortlist extensions', c => c.extensions) + r('Last firm left', c => PS.fmtTime(c.endTime)) +
      '</tbody></table>';
  }
  function renderResults() {
    const M = sim.metrics;
    let html = '<div class="card"><h3>Current run · ' + $('#modeLabel').textContent + ' mode, seed ' + sim.P.seed + '</h3>' + clusterTable(M);
    if (sim.finished) html += '<p>Placed overall: <b>' + (sim.students.length - M.unplaced) + ' of ' + sim.students.length + '</b>. Net placements by cluster: ' + M.net[1] + ' / ' + M.net[2] + ' / ' + M.net[3] + '. Hires lost: ' + M.lostHolds + ' to released holds, ' + M.lostToDream + ' to dreams.</p>';
    html += '</div>'; $('#resultsCurrent').innerHTML = html;
  }
  // ------------------------------------------------------------------ compare modes (every run kept, so each cluster and GD day can be viewed)
  let cmpData = null;
  const fillViews = (sel, runs, keep) => {
    const views = PS.viewsAvailable(runs); const cur = keep && views.some(v => v[0] === keep) ? keep : (views[0] ? views[0][0] : 'season');
    sel.innerHTML = views.map(([v, lab]) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + lab + '</option>').join(''); sel.disabled = views.length < 2; return cur;
  };
  const cmpFmt = (m, v) => typeof v !== 'number' || !isFinite(v) ? '–' : PS.isClockMetric(m) ? PS.fmtTime(Math.round(v)) : (Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));
  function cmpRender() {
    if (!cmpData) return; const { modes, runs } = cmpData; const view = $('#cmpView').value || 'season';
    const M = PS.metricsFor(view); const mean = (m, md) => PS.stats.mean(runs[md].map(r => r.metrics[m]).filter(x => x != null));
    const head = '<tr><th>Metric</th>' + modes.map(m => '<th class="num">' + MODE_NAME[m] + '</th>').join('') + '</tr>';
    const body = M.map(([m, lab, prim]) => {
      const vals = modes.map(md => mean(m, md)); const dir = PS.betterDir(m); let best = -1;
      if (dir && vals.every(isFinite) && new Set(vals.map(v => v.toFixed(3))).size > 1) best = vals.indexOf(dir === 'high' ? Math.max(...vals) : Math.min(...vals));
      return '<tr><td>' + (prim ? '<b>' + esc(lab) + '</b>' : esc(lab)) + '</td>' + vals.map((v, i) => '<td class="num' + (i === best ? ' best' : '') + '">' + cmpFmt(m, v) + '</td>').join('') + '</tr>';
    }).join('');
    $('#cmpResults').innerHTML = '<table class="data" style="margin-top:10px"><thead>' + head + '</thead><tbody>' + body + '</tbody></table><p class="muted">Averages over ' + cmpData.n + ' run' + (cmpData.n > 1 ? 's' : '') + ' per mode. Green marks the better value. For each seed, all modes start from the same students, preferences and cluster 1 shortlists; later random draws differ once the schedules diverge, which is why several runs are averaged. GD days show the timetable each mode uses.</p>';
  }
  $('#cmpView').addEventListener('change', cmpRender);
  $('#btnCompare').addEventListener('click', async () => {
    const n = Math.max(1, Math.min(50, +$('#cmpRuns').value || 5));
    const modes = ['baseline', 'optimised'].concat($('#cmpManual').checked ? ['manual'] : []);
    const roles = PS.buildRoles(state.overrides, state.cohortMap); const runs = {}; let done = 0;
    for (const m of modes) {
      runs[m] = [];
      for (let i = 0; i < n; i++) {
        await new Promise(r => setTimeout(r, 0));
        runs[m].push(PS.runOne(Object.assign({}, state.params, { seed: state.params.seed + i }), roles, m, { scope: 'season' }));
        done++; $('#cmpProgress').textContent = 'Running ' + done + ' of ' + n * modes.length + '…';
      }
    }
    $('#cmpProgress').textContent = 'Average over ' + n + ' run' + (n > 1 ? 's' : '') + ' per mode, seeds ' + state.params.seed + '–' + (state.params.seed + n - 1) + '.';
    cmpData = { modes, runs, n }; fillViews($('#cmpView'), [].concat(...modes.map(m => runs[m])), $('#cmpView').value); cmpRender();
  });

  // ------------------------------------------------------------------ 2x2 experiment: planning x matching
  let x2Runs = [], x2Worker = null, x2Meta = null;
  const x2Fmt = (m, v) => PS.isClockMetric(m) ? PS.fmtTime(Math.round(v)) : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  const x2FmtD = (m, v) => PS.isClockMetric(m) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + ' min' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1);
  const x2MetricsOf = (meta) => meta && meta.view ? PS.metricsFor(meta.view) : ((meta && meta.scope) === 'c1' ? PS.METRICS_C1 : PS.METRICS_SEASON);
  const x2ViewText = (meta) => { const v = meta && meta.view; const lab = v ? (PS.VIEWS.find(x => x[0] === v) || [, v])[1] : null;
    return ((meta && meta.scope) === 'c1' ? 'cluster 1 only' : 'full season') + (lab && v !== 'season' ? ', showing ' + lab.toLowerCase() : ''); };
  function x2Render(res, meta) {
    const scope = (meta && meta.scope) || (res.config && res.config.scope) || 'season';
    meta = Object.assign({ scope }, meta);
    const rg = Object.keys(res.rng)[0]; const R = res.rng[rg]; const A = R ? PS.ARMS_2X2.filter(a => R.cells[a.id]) : [];
    if (!R || A.length < 4) { $('#x2Results').innerHTML = '<p class="muted">Results need all four cells on the same seeds.</p>'; return; }
    const M = x2MetricsOf(meta).filter(([m]) => R.cells[A[0].id][m]);
    let h = '<p class="muted">' + R.seeds + ' seeds (' + R.seedRange[0] + '–' + R.seedRange[1] + '), ' + x2ViewText(meta) + ', ' + (+rg ? 'event-keyed random numbers' : 'legacy stream') + '. Cells show mean ± 95% half-width; effects are paired differences averaged over seeds with 95% t intervals and d<sub>z</sub> = mean difference / SD of differences.</p>';
    h += '<div class="tablewrap"><table class="data"><thead><tr><th>Metric</th>' + A.map(a => '<th class="num">' + a.label.replace(' + ', '<br>+ ') + '</th>').join('') + '</tr></thead><tbody>' +
      M.map(([m, lab, prim]) => '<tr><td>' + (prim ? '<b>' + esc(lab) + '</b>' : esc(lab)) + '</td>' + A.map(a => { const c = R.cells[a.id][m]; return '<td class="num">' + x2Fmt(m, c.mean) + ' <span class="muted">± ' + (PS.isClockMetric(m) ? c.halfWidth.toFixed(0) + ' min' : c.halfWidth.toFixed(1)) + '</span></td>'; }).join('') + '</tr>').join('') + '</tbody></table></div>';
    if (R.effects) {
      const cell = (e, m) => { const x = R.effects[e][m]; const sig = x.lo > 0 || x.hi < 0; return '<td class="num' + (sig ? '' : ' muted') + '">' + x2FmtD(m, x.mean) + ' <span class="muted">[' + x2FmtD(m, x.lo) + ', ' + x2FmtD(m, x.hi) + ']</span><br><span class="muted">d<sub>z</sub> ' + (isFinite(x.dz) ? x.dz.toFixed(2) : '–') + '</span></td>'; };
      h += '<h4>Effects</h4><div class="tablewrap"><table class="data"><thead><tr><th>Metric</th><th class="num">Planning (optimised − baseline plan)</th><th class="num">Matching (optimised − baseline matching)</th><th class="num">Interaction</th></tr></thead><tbody>' +
        M.map(([m, lab, prim]) => '<tr><td>' + (prim ? '<b>' + esc(lab) + '</b>' : esc(lab)) + '</td>' + cell('planning', m) + cell('matching', m) + cell('interaction', m) + '</tr>').join('') + '</tbody></table></div>' +
        '<p class="muted">Planning effect = ½[(optimised plan − baseline plan) under baseline matching + the same under optimised matching]; matching effect likewise; interaction = (matching gain under the optimised plan) − (matching gain under the baseline plan). Greyed cells have intervals that include zero.</p>';
    }
    h += '<h4>Runtime per run (ms)</h4><div class="tablewrap"><table class="data"><thead><tr><th></th>' + A.map(a => '<th class="num">' + a.label.replace(' + ', '<br>+ ') + '</th>').join('') + '</tr></thead><tbody>' +
      [['totalMs', 'Whole run'], ['planMs', 'Pre-day plan of this cell'], ['decisionsMs', 'Decision summaries (all modes, for display)'], ['matchMs', 'Live matching'], ['gdMs', 'GD timetables']].map(([k, lab]) => '<tr><td>' + lab + '</td>' + A.map(a => '<td class="num">' + (R.runtime[a.id][k] ? R.runtime[a.id][k].mean.toFixed(0) : '–') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    $('#x2Results').innerHTML = h;
  }
  function x2Analyse() {
    x2Meta.view = fillViews($('#x2View'), x2Runs, $('#x2View').value || x2Meta.view);
    const scope = x2Meta.scope; const res = PS.analyse(x2Runs, { metrics: PS.metricsFor(x2Meta.view), ref: 'baseline', scope, view: x2Meta.view });
    x2Render(res, x2Meta); return res;
  }
  $('#btnX2').addEventListener('click', () => {
    if (x2Worker) return;
    const n = Math.max(2, Math.min(200, +$('#x2Runs').value || 10)), s0 = +$('#x2Seed').value || 1001;
    const seeds = Array.from({ length: n }, (_, i) => s0 + i), arms = PS.ARMS_2X2.map(a => a.id), scope = $('#x2Scope').value, rngMode = +$('#x2Rng').value;
    x2Runs = []; x2Meta = { scope, rngMode, seeds: [s0, s0 + n - 1] }; $('#x2Results').innerHTML = '';
    const start = Date.now();
    try { x2Worker = new Worker('js/exp-worker.js'); } catch (err) { x2Worker = null; }
    if (!x2Worker) { $('#x2Progress').textContent = 'Background workers are not available here; run tools/experiment.js and import the results.'; return; }
    x2Worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'run') { x2Runs.push(d.run); $('#x2Progress').textContent = 'Running ' + d.done + ' of ' + d.total + ' (' + ((Date.now() - start) / 1000).toFixed(0) + ' s)…'; if (d.done % 4 === 0 && x2Runs.length >= 8) x2Analyse(); }
      else { x2Worker.terminate(); x2Worker = null; const ok = x2Runs.length >= 8; if (ok) x2Analyse(); $('#x2Progress').textContent = (d.type === 'stopped' ? 'Stopped after ' : 'Done: ') + x2Runs.length + ' runs in ' + ((Date.now() - start) / 1000).toFixed(0) + ' s.'; }
    };
    x2Worker.onerror = (err) => { $('#x2Progress').textContent = 'The worker failed: ' + err.message; if (x2Worker) x2Worker.terminate(); x2Worker = null; };
    x2Worker.postMessage({ params: readParamsSafe(), overrides: state.overrides, cohortMap: state.cohortMap, seeds, arms, scope, rngMode });
  });
  $('#x2View').addEventListener('change', () => { if (x2Runs.length >= 8) x2Analyse(); });
  $('#btnX2Stop').addEventListener('click', () => { if (x2Worker) { x2Worker.terminate(); x2Worker = null; if (x2Runs.length >= 8) x2Analyse(); $('#x2Progress').textContent = 'Stopped after ' + x2Runs.length + ' runs.'; } });
  $('#btnX2Export').addEventListener('click', () => {
    if (!x2Runs.length) { $('#x2Progress').textContent = 'Nothing to download yet.'; return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(x2Runs)], { type: 'application/json' })); a.download = '2x2-runs.json'; a.click();
  });
  $('#x2Import').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return; const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        if (Array.isArray(j)) { // runs.json from tools/experiment.js or this panel
          const rgs = [...new Set(j.map(r => r.rngMode))]; const keep = j.filter(r => r.rngMode === (rgs.includes(1) ? 1 : rgs[0]));
          const scope = keep[0] && keep[0].metrics && 'endTime' in keep[0].metrics ? 'c1' : 'season';
          if (scope === 'c1') keep.forEach(r => { for (const k of Object.keys(r.metrics)) if (!/^[cg]\d_/.test(k) && r.metrics['c1_' + k] == null) r.metrics['c1_' + k] = r.metrics[k]; });
          x2Runs = keep; x2Meta = { scope }; x2Analyse(); $('#x2Progress').textContent = 'Imported ' + keep.length + ' runs.';
        } else if (j.rng) { x2Runs = []; $('#x2View').innerHTML = '<option>As saved</option>'; $('#x2View').disabled = true; x2Meta = { scope: j.config && j.config.scope, view: j.config && j.config.view }; x2Render({ rng: { [Object.keys(j.rng).includes('1') ? '1' : Object.keys(j.rng)[0]]: j.rng[Object.keys(j.rng).includes('1') ? '1' : Object.keys(j.rng)[0]] }, config: j.config }, x2Meta); $('#x2Progress').textContent = 'Imported summary.'; }
        else throw new Error('unrecognised file');
      } catch (err) { $('#x2Progress').textContent = 'That file could not be read as experiment results.'; }
      e.target.value = '';
    };
    rd.readAsText(file);
  });

  // ------------------------------------------------------------------ assumptions
  const PARAMS = [
    ['Population and preferences', [
      ['nStudents', 'Students in the batch', 'num', 1], ['seed', 'Random seed', 'num', 1],
      ['prefNoise', 'Preference spread between students', 'num', 0.1, 'Higher means students disagree more on which roles are best'],
      ['tieShare', 'Share of roles in tied groups', 'pct'], ['firmNoise', 'How differently firms judge students', 'num', 0.1, 'Higher spreads shortlists across more students'],
    ]],
    ['Applications', [
      ['pApplyAll', 'Students who apply to every role', 'pct'], ['applyMean', 'Others: mean share of roles applied to', 'pct'],
      ['applySd', 'Others: standard deviation of the share', 'pct'], ['applyMin', 'Others: minimum share', 'pct'], ['applyMax', 'Others: maximum share', 'pct'],
    ]],
    ['Firm list strategy', [
      ['confHot', 'Confident: hotlist (× X)', 'num', 0.5], ['confList', 'Confident: total list (× X)', 'num', 0.5],
      ['compHot', 'Competing: hotlist (× X)', 'num', 0.5], ['compList', 'Competing: total list (× X)', 'num', 0.5],
      ['defHot', 'Defensive: hotlist (× X)', 'num', 0.5], ['defList', 'Defensive: total list (× X)', 'num', 0.5],
      ['stratTopPct', 'Top share of firms that lean confident', 'pct'], ['stratBottomPct', 'Bottom share that lean defensive', 'pct'], ['stratLean', 'Chance a firm follows its lean', 'pct'],
      ['targetGross', 'Target X counts offers made (1 = gross offers; 0 = net: accepted or held)', 'num', 1, 'Gross: a role stops once it has made X offers, whether or not students keep them; a released hold is not replaced. Net (earlier model): rejections and released holds are replaced until X are accepted or held'],
      ['extensions', 'Shortlist extensions allowed (1 = yes)', 'num', 1], ['maxExtensions', 'Maximum extensions per role', 'num', 1],
    ]],
    ['Offers', [
      ['pOfferHot1', 'One interaction: offer to hotlist', 'pct'], ['pOfferShort1', 'One interaction: offer to shortlist', 'pct'],
      ['pR2Hot', 'Two interactions: hotlist reaches round 2', 'pct'], ['pR2Short', 'Two interactions: shortlist reaches round 2', 'pct'],
      ['pOfferHot2', 'Offer after round 2: hotlist', 'pct'], ['pOfferShort2', 'Offer after round 2: shortlist', 'pct'],
    ]],
    ['Student decisions', [
      ['acceptAnchorPct', 'Accept anchor: list position', 'pct'], ['acceptAnchorVal', 'Accept anchor: probability', 'pct'],
      ['rejectAnchorPct', 'Reject anchor: list position', 'pct'], ['rejectAnchorVal', 'Reject anchor: probability', 'pct'],
      ['holdClock', 'Hold clock before auto-accept (min)', 'num', 5], ['finalNoReject', 'Cluster 3: no outright rejections (1 = on)', 'num', 1],
      ['transit', 'Walk each way via the central tracker (min)', 'num', 1, 'Half to reach and check in at the central tracker, half from there to the wing'],
    ]],
    ['Dreams', [
      ['dreamShare', 'Placed students who dream', 'pct'], ['dreamMaxTotal', 'Dream applications in total', 'num', 1], ['dreamMaxPerCluster', 'Dream applications per cluster', 'num', 1],
    ]],
    ['Rooms and time', [
      ['wings', 'Wings', 'num', 1], ['roomsPerWingPlanned', 'Planned rooms per wing', 'num', 1], ['roomsPerWingBuffer', 'Buffer rooms per wing', 'num', 1],
      ['turnover', 'Room turnover (min)', 'num', 5], ['reuseCloseBy', 'Room reuse: firm must close by', 'clock'], ['reuseOpenFrom', 'Room reuse: next firm opens from', 'clock'],
      ['lateSlotTime', 'Late-slot requests open from', 'clock'], ['openLatest', 'Latest open time', 'clock'], ['softStop', 'Soft stop (no new interviews)', 'clock'], ['hardStop', 'Hard stop', 'clock'],
    ]],
    ['Group discussions (day before clusters 2 and 3)', [
      ['gdOn', 'Hold GD days (1 = on)', 'num', 1, 'GD firms are ticked on the Firms tab'],
      ['gdSizeMin', 'Smallest GD group', 'num', 1], ['gdSizeMax', 'Largest GD group', 'num', 1],
      ['gdCv', 'GD length variability (standard deviation as a share of the mean)', 'pct', null, 'Mean length is set per firm on the Firms tab: 30 min, 75 min for TAS'],
      ['gdTurnover', 'Changeover between groups in a GD room (min)', 'num', 1],
      ['gdRoomsPerWing', 'GD rooms per wing', 'num', 1], ['gdMaxRooms', 'Most GD panels for one company (both in the same wing)', 'num', 1],
      ['gdSwitch', 'Gap before the next company can use a GD room (min)', 'num', 5, 'A company finishing at 9:00 am frees the room for the next company from 10:00 am'],
      ['gdLatestStart', 'Latest normal start for a company\'s GDs', 'clock', null, 'Starting later is allowed but kept to a minimum, like a buffer room; such a late GD runs two panels so it ends quickly'],
      ['gdPopWeight', 'Reputation weight: popular companies start GDs early', 'num', 0.5, 'Minutes of a later finish the optimiser accepts to bring the popularity-weighted mean start one minute earlier; 0 ignores popularity'],
      ['gdRestarts', 'Optimised GD timetable: extra shuffled company orders tried', 'num', 1],
      ['gdDayEnd', 'GD day ends', 'clock'], ['gdBuffer', 'Baseline timetable: gap after a block\'s planned end before the next company (min)', 'num', 15],
      ['gdNoise', 'GD signal noise relative to CV screening', 'num', 0.1, 'Below 1 means the GD judges students more sharply than the CV shortlist did'],
      ['gdConfList', 'Confident firm list after GD (× X)', 'num', 0.5],
      ['gdInviteMult', 'GD invitations (× the roles\' usual shortlists added together)', 'num', 0.5, 'One GD per company: everyone who applied to any of its roles is screened once; at least one full group is always called'],
    ]],
    ['Experiments', [
      ['rngMode', 'Random numbers (0 = original stream, as in the report; 1 = event-keyed common random numbers)', 'num', 1, 'Event-keyed draws give every mode the same luck for the same event, for fairer paired comparisons'],
    ]],
    ['Optimiser', [
      ['planBuffer', 'Interview buffer on expected need (×)', 'num', 0.05], ['targetWindow', 'Target interviewing window (min)', 'num', 10],
      ['openFromPrefs', 'Opening time from preferences (1 = on, 0 = tier rule)', 'num', 1, 'A firm opens once its candidates who are free of interviews with firms they rank higher are worth one hotlisted candidate per panel'],
      ['shortlistWeight', 'Opening rule: a shortlisted candidate counts as this share of a hotlisted one', 'pct', null, 'At 33%, N panels open on N free hotlisted candidates or 3N free shortlisted ones'],
      ['laterOpenMid', 'Tier rule only: middle-preference firms open after (min)', 'num', 10], ['laterOpenLow', 'Tier rule only: low-preference firms open after (min)', 'num', 10],
      ['prefBeta', 'Weight on student preference in matching', 'num', 0.5], ['lookAhead', 'Look-ahead window (min)', 'num', 1], ['lookAheadPenalty', 'Look-ahead penalty', 'pct'],
      ['holdUrgency', 'Hold urgency weight', 'num', 0.1], ['idleBonus', 'Idle panel bonus per minute', 'num', 0.005],
      ['planImprove', 'Improvement phase on the plan (1 = on)', 'num', 1, 'Savings for noon handovers, earlier openings and panel relocations after the greedy plan, all inside each wing'],
      ['minimiseWings', 'Free whole wings when the plan allows (1 = on)', 'num', 1, 'Each role stays in one wing; the optimised plan then drops wings one at a time while its cost stays within the slack below'],
      ['wingSlack', 'Extra plan cost accepted to free a wing', 'pct', null, 'Share of the plan cost with every wing in use; 2% by default'],
      ['earlyPenalty', 'Cost of opening a firm before its tier time (per hire-minute)', 'num', 1, 'Higher values make the improvement phase reluctant to open less-preferred firms early'],
    ]],
  ];
  const fmtVal = (v, type) => type === 'pct' ? Math.round(v * 10000) / 100 : type === 'clock' ? PS.fmtTime(v) : v;
  function renderParams() {
    const P = state.params, D = PS.DEFAULT_PARAMS;
    $('#paramForm').innerHTML = PARAMS.map(([g, items]) => '<div class="pgroup"><h4>' + g + '</h4>' + items.map(([k, lab, type, step, help]) =>
      '<div class="prow' + (P[k] !== D[k] ? ' changed' : '') + '"><div><div class="lab">' + lab + (type === 'pct' ? ' (%)' : '') + '</div>' + (help ? '<div class="help">' + help + '</div>' : '') + '</div>' +
      '<input data-k="' + k + '" data-type="' + type + '" ' + (type === 'clock' ? 'type="text"' : 'type="number" step="' + (type === 'pct' ? 1 : (step || 1)) + '"') + ' value="' + fmtVal(P[k], type) + '"><button class="sweep" data-sweep="' + k + '" title="Plot sensitivity for this input">&#8599;</button></div>').join('') + '</div>').join('');
    renderCurve();
  }
  function readParams() {
    const P = Object.assign({}, state.params);
    document.querySelectorAll('#paramForm input').forEach(inp => {
      const k = inp.dataset.k, type = inp.dataset.type;
      if (type === 'clock') { const v = PS.parseTime(inp.value); if (v != null) P[k] = v; }
      else { const v = parseFloat(inp.value); if (!isNaN(v)) P[k] = type === 'pct' ? v / 100 : v; }
    });
    return P;
  }
  function renderCurve() {
    const P = readParamsSafe(); const qs = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1];
    $('#curveTable').innerHTML = '<table class="data"><thead><tr><th>Position on list</th>' + qs.map(q => '<th class="num">' + (q === 0 ? 'Top' : Math.round(q * 100) + '%') + '</th>').join('') + '</tr></thead><tbody>' +
      ['pA', 'pH', 'pR'].map((key, i) => '<tr><td>' + ['Accept', 'Hold', 'Reject'][i] + '</td>' + qs.map(q => '<td class="num">' + Math.round(PS.acceptRejectHold(P, q)[key] * 100) + '%</td>').join('') + '</tr>').join('') + '</tbody></table>';
  }
  function readParamsSafe() { try { return document.querySelector('#paramForm input') ? readParams() : state.params; } catch (e) { return state.params; } }
  $('#paramForm').addEventListener('input', renderCurve);
  $('#btnApplyParams').addEventListener('click', () => { state.params = PS.sanitizeParams(readParams()); persist(); newSim(); renderParams(); goSim(); });
  $('#btnResetParams').addEventListener('click', () => { state.params = Object.assign({}, PS.DEFAULT_PARAMS); persist(); renderParams(); newSim(); });
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ params: state.params, overrides: state.overrides, cohortMap: state.cohortMap, mode: state.mode }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'placement-sim-settings.json'; a.click();
  });
  $('#fileImport').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return; const rd = new FileReader();
    rd.onload = () => { try { const j = JSON.parse(rd.result); state.params = PS.sanitizeParams(Object.assign({}, PS.DEFAULT_PARAMS, j.params || {})); state.overrides = j.overrides || {}; state.cohortMap = Object.assign({}, PS.COHORT_CLUSTER, j.cohortMap || {}); state.mode = j.mode || state.mode; $('#selMode').value = state.mode; persist(); renderParams(); newSim(); } catch (err) { alert('That file could not be read as settings.'); } };
    rd.readAsText(f);
  });
  function goSim() { document.querySelector('#tabs button[data-tab=sim]').click(); }

  // ------------------------------------------------------------------ decisions before each cluster
  function renderDecisions() {
    const ks = Object.keys(sim.decisions || {}).map(Number).sort();
    const selC = $('#decCluster'); const want = +(selC.dataset.want || selC.value || sim.cluster || 1); delete selC.dataset.want;
    selC.innerHTML = ks.map(k => '<option value="' + k + '"' + (k === want ? ' selected' : '') + '>Cluster ' + k + '</option>').join('');
    const k = ks.includes(want) ? want : ks[ks.length - 1]; const d = sim.decisions[k];
    if (!d) { $('#decSummary').innerHTML = '<p class="muted">No cluster has been set up yet.</p>'; return; }
    const selM = $('#decMode'); const mWant = selM.value || sim.mode;
    selM.innerHTML = d.modes.map(m => '<option value="' + m + '"' + (m === mWant ? ' selected' : '') + '>' + MODE_NAME[m] + (m === sim.mode ? ' (in use)' : '') + '</option>').join('');
    const mode = d.modes.includes(mWant) ? mWant : d.modes[0];
    const P = sim.P, q = $('#decSearch').value.toLowerCase();
    // summary: the cluster-level decisions and the room budget
    const rows = decisionRows(d);
    const wantPanels = d.firms.reduce((a, f) => a + Math.max(1, Math.ceil(f.expInt * (f.meanDur) / P.targetWindow)), 0);
    let html = '<div class="totals">' +
      [['Cluster ' + k, d.firms.length + ' roles · ' + d.hires + ' hires'], ['Student pool', d.pool + ' students' + (d.poolNoOffer != null ? ' (' + d.poolNoOffer + ' with no offer yet, ' + d.poolDreamers + ' dreaming in)' : '')], ['Rooms', d.plannedRooms + ' planned + ' + d.bufferRooms + ' buffer in ' + P.wings + ' wings'], ['Run uses', MODE_NAME[sim.mode] + ' plan']]
        .map(c => '<div class="counter"><div class="v">' + c[0] + '</div><div class="k">' + c[1] + '</div></div>').join('') + '</div>';
    html += '<div class="card"><h3>Cluster decisions</h3><p class="muted">Stage 1 put these cohorts in cluster ' + k + ': ' + d.cohorts.map(esc).join(', ') + '.</p>' +
      '<table class="data" style="max-width:980px"><thead><tr><th>Decision</th>' + d.modes.map(m => '<th class="num">' + MODE_NAME[m] + (m === sim.mode ? ' (in use)' : '') + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(([lab, fn]) => '<tr><td>' + lab + '</td>' + d.modes.map(m => '<td class="num">' + fn(d.summary[m], m) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    html += '<p class="muted" style="margin-top:8px">Plan cost weights each firm\'s planned finish by its hires (the objective of Smith\'s rule). The lower bound relaxes the room constraints: every firm runs its maximum panels (a third of its list, at most one wing) from its best opening time up to its release date, so no feasible plan can cost less. Lower bound for this cluster: ' + Math.round(d.lowerBound / 60).toLocaleString('en-IN') + ' hire-hours.</p>';
    if (wantPanels > d.plannedRooms) html += '<div class="note">Rooms are the binding constraint in this cluster. To finish each firm within the ' + P.targetWindow + '-minute target window the firms would need about <b>' + wantPanels + ' panels</b>, but there are ' + d.plannedRooms + ' planned rooms, so most firms get a single panel and the largest ones run into the evening. More wings or planned rooms, or a longer target window, relax this (try it on the Assumptions tab).</div>';
    html += '</div>';
    $('#decSummary').innerHTML = html;
    // opening schedule for the chosen mode
    const match = (f) => !q || (f.company + ' ' + f.role).toLowerCase().includes(q);
    const F = d.firms.filter(match).slice().sort((a, b) => a.plans[mode].open - b.plans[mode].open || b.pop - a.pop);
    const groups = new Map(); F.forEach(f => { const t = f.plans[mode].open; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(f); });
    $('#decScheduleNote').textContent = MODE_NAME[mode] + ' plan for cluster ' + k + ': who opens when, with how many panels and in which rooms. ' + (P.openFromPrefs ? 'A student is free for a firm once they are likely to have finished every interview with a firm they rank higher. A free hotlisted candidate counts 1 and a free shortlisted candidate ' + Math.round(P.shortlistWeight * 100) + '% of that; a firm opens at the first half-hour by which its free candidates add up to one hotlist-equivalent per panel.' : '') + ' Room numbers count from 1 within each wing; rooms ' + (P.roomsPerWingPlanned + 1) + '–' + (P.roomsPerWingPlanned + P.roomsPerWingBuffer) + ' are the buffer.';
    const why = (f, p) => {
      if (mode === 'baseline') return 'Everyone opens at 8:00 am';
      if (f.release == null) return 'Tier rule by popularity';
      if (p.open > f.release) return 'Free from ' + PS.fmtTime(f.release) + '; first free room at ' + PS.fmtTime(p.open);
      const r1 = (x) => Math.round(x * 10) / 10;
      if (f.release === 0) return 'Free at 8:00: ' + f.hotAt8 + ' hotlisted + ' + f.shortAt8 + ' shortlisted = ' + r1(f.readyAt8) + ' hotlist-equivalents; needs ' + r1(f.need);
      return 'Free at 8:00: ' + f.hotAt8 + ' hotlisted + ' + f.shortAt8 + ' shortlisted = ' + r1(f.readyAt8) + '; needs ' + r1(f.need) + ', reached by ' + PS.fmtTime(f.release);
    };
    let sch = '<thead><tr><th>Opens</th><th>Firm and role</th><th class="num">Target X</th><th>Shortlist</th><th class="num">Expected interviews</th><th class="num">Panels</th><th>Rooms</th><th class="num">Planned finish</th><th>Why this opening time</th></tr></thead><tbody>';
    for (const [t, list] of groups) {
      sch += '<tr class="grp"><td colspan="9">' + PS.fmtTime(t) + ' · ' + list.length + ' firm' + (list.length > 1 ? 's' : '') + ' · ' + list.reduce((a, f) => a + f.plans[mode].panels, 0) + ' panels</td></tr>';
      sch += list.map(f => { const p = f.plans[mode]; return '<tr><td class="num">' + PS.fmtTime(p.open) + '</td><td><span class="swatch" style="background:' + PS.firmColor(f.company) + '"></span>' + esc(f.label) + '</td><td class="num">' + f.X + '</td><td>' + f.strategy + ' · ' + f.hot + ' hot / ' + f.list + '</td><td class="num">' + f.expInt + '</td><td class="num">' + p.panels + '</td><td>' + PS.roomsText(p.rooms, p.open) + '</td><td class="num' + (p.close > P.softStop ? ' warn' : '') + '">' + fmtFinish(p.close) + '</td><td class="muted">' + why(f, p) + '</td></tr>'; }).join('');
    }
    $('#decSchedule').innerHTML = sch + '</tbody>';
    // firm-by-firm comparison
    const B = 'baseline', O = 'optimised', hasMan = d.modes.includes('manual');
    const change = (f) => {
      const b = f.plans[B], o = f.plans[O], out = [];
      const dt = o.open - b.open; if (dt) out.push('opens ' + (dt > 0 ? Math.floor(dt / 60) + ':' + String(dt % 60).padStart(2, '0') + ' later' : 'earlier'));
      const dp = o.panels - b.panels; if (dp) out.push((dp > 0 ? '+' : '') + dp + ' panel' + (Math.abs(dp) > 1 ? 's' : ''));
      return out.join(' · ') || 'same';
    };
    const cell = (p) => '<td class="num sep">' + PS.fmtTime(p.open) + '</td><td class="num">' + p.panels + '</td><td>' + PS.roomsText(p.rooms, p.open) + '</td><td class="num' + (p.close > P.softStop ? ' warn' : '') + '">' + fmtFinish(p.close) + '</td>';
    const all = d.firms.filter(match).slice().sort((a, b) => b.pop - a.pop);
    $('#decTable').innerHTML = '<thead><tr><th>Firm and role</th><th>Cohort</th><th class="num">Popularity</th><th>List strategy</th><th class="num">Target X</th><th class="num">Hot / list</th><th class="num">Applicants</th><th class="num">Expected interviews</th>' +
      ['Baseline'].concat(['Optimised']).concat(hasMan ? ['Manual'] : []).map(n => '<th class="num sep">' + n + ' opens</th><th class="num">Panels</th><th>Rooms</th><th class="num">Finish</th>').join('') + '<th>Optimised vs baseline</th></tr></thead><tbody>' +
      all.map(f => '<tr><td><span class="swatch" style="background:' + PS.firmColor(f.company) + '"></span>' + esc(f.label) + '</td><td>' + esc(f.cohort) + '</td><td class="num">' + f.pop + '</td><td>' + f.strategy + '</td><td class="num">' + f.X + '</td><td class="num">' + f.hot + ' / ' + f.list + '</td><td class="num">' + f.applicants + '</td><td class="num">' + f.expInt + '</td>' +
        cell(f.plans[B]) + cell(f.plans[O]) + (hasMan ? cell(f.plans.manual) : '') + '<td class="chg">' + change(f) + '</td></tr>').join('') + '</tbody>';
  }
  $('#decCluster').addEventListener('change', renderDecisions);
  $('#decMode').addEventListener('change', renderDecisions);
  $('#decSearch').addEventListener('input', renderDecisions);
  $('#btnDecCsv').addEventListener('click', () => {
    const lines = [];
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    lines.push(['Cluster', 'Company', 'Role', 'Cohort', 'Popularity', 'List strategy', 'Target X', 'Hotlist', 'List', 'Applicants', 'Expected interviews', 'Mode', 'Opens', 'Panels', 'Rooms', 'Planned finish'].map(q).join(','));
    for (const k of Object.keys(sim.decisions)) { const d = sim.decisions[k]; for (const f of d.firms) for (const m of d.modes) { const p = f.plans[m]; lines.push([k, f.company, f.role, f.cohort, f.pop, f.strategy, f.X, f.hot, f.list, f.applicants, f.expInt, MODE_NAME[m], PS.fmtTime(p.open), p.panels, PS.roomsText(p.rooms, p.open), fmtFinish(p.close)].map(q).join(',')); } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'pre-cluster-decisions.csv'; a.click();
  });

  // ------------------------------------------------------------------ sensitivity analysis
  const SENS_OUT = [
    ['filledPct', 'Firms that filled X (%)', 1, true], ['top10', 'Placed at rank 1 or top 10% of list', 0, true], ['below50', 'Placed below 50% of list', 0, true],
    ['wasted', 'Wasted interviews', 0, true], ['lost', 'Hires lost (released holds + dreams)', 0, true], ['idle', 'Panel idle hours', 0, true],
    ['buffer', 'Buffer room openings', 0, true], ['endAvg', 'Average time the last firm left', 'clock', true],
    ['placed', 'Students placed', 0, false], ['unplaced', 'Students left unplaced', 0, false], ['dreamConv', 'Dream conversions', 0, false],
    ['interviews', 'Interviews held', 0, false], ['rank1', 'Placed at rank 1', 0, false], ['gross1', 'Gross offers, cluster 1', 0, false], ['gross2', 'Gross offers, cluster 2', 0, false],
    ['gross3', 'Gross offers, cluster 3', 0, false], ['peakRooms', 'Peak rooms in use', 0, false], ['extensions', 'Shortlist extensions', 0, false], ['lostHolds', 'Hires lost to released holds', 0, false],
    ['gdEnd', 'Last GD finished (mean of the two GD days)', 'clock', false], ['gdWait', 'GD group-minutes lost to clashes', 0, false],
  ];
  const SENS_COLORS = { baseline: '#c26a1b', optimised: '#1f5fbf', manual: '#2f9e6b' };
  const sensSel = new Set(SENS_OUT.filter(o => o[3]).map(o => o[0]));
  let sensLast = null;
  const paramMeta = (k) => { for (const [, items] of PARAMS) for (const it of items) if (it[0] === k) return { key: k, label: it[1], type: it[2], step: it[3] }; return null; };
  const isInt = (m) => m.type === 'num' && (m.step || 1) >= 1;
  const showV = (m, v) => m.type === 'pct' ? (Math.round(v * 1000) / 10) + '%' : m.type === 'clock' ? PS.fmtTime(v) : (Math.round(v * 100) / 100);
  const inV = (m, v) => m.type === 'pct' ? String(Math.round(v * 1000) / 10) : m.type === 'clock' ? PS.fmtTime(v) : String(Math.round(v * 100) / 100);
  const readV = (m, s) => { if (m.type === 'clock') return PS.parseTime(s); const v = parseFloat(s); if (isNaN(v)) return null; return m.type === 'pct' ? v / 100 : v; };
  function initSens() {
    $('#sensKey').innerHTML = PARAMS.map(([g, items]) => '<optgroup label="' + esc(g) + '">' + items.filter(it => it[0] !== 'seed').map(it => '<option value="' + it[0] + '">' + esc(it[1]) + (it[2] === 'pct' ? ' (%)' : '') + '</option>').join('') + '</optgroup>').join('');
    $('#sensKey').value = 'dreamShare'; sensDefaults();
    $('#sensOutputs').innerHTML = SENS_OUT.map(o => '<label><input type="checkbox" data-out="' + o[0] + '"' + (sensSel.has(o[0]) ? ' checked' : '') + '> ' + esc(o[1]) + '</label>').join('');
  }
  function sensDefaults() {
    const m = paramMeta($('#sensKey').value); if (!m) return; const v = readParamsSafe()[m.key];
    let lo, hi;
    if (m.type === 'pct') { lo = Math.max(0, v - 0.2); hi = Math.min(1, v + 0.2); if (hi - lo < 0.1) { lo = 0; hi = 1; } }
    else if (m.type === 'clock') { lo = Math.max(0, v - 120); hi = v + 120; }
    else if (v === 0) { lo = 0; hi = isInt(m) ? 4 : 1; }
    else { lo = v * 0.5; hi = v * 1.5; if (isInt(m)) { lo = Math.max(1, Math.round(lo)); hi = Math.max(lo + 1, Math.round(hi)); } }
    $('#sensFrom').value = inV(m, lo); $('#sensTo').value = inV(m, hi);
  }
  $('#sensKey').addEventListener('change', sensDefaults);
  $('#sensOutputs').addEventListener('change', (e) => { const k = e.target.dataset.out; if (!k) return; if (e.target.checked) sensSel.add(k); else sensSel.delete(k); if (sensLast) drawSens(sensLast); });
  $('#paramForm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sweep]'); if (!b) return;
    $('#sensKey').value = b.dataset.sweep; sensDefaults(); $('#sensCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  let sensWorker = null;
  $('#btnSens').addEventListener('click', () => {
    const m = paramMeta($('#sensKey').value); if (!m) return;
    const lo = readV(m, $('#sensFrom').value), hi = readV(m, $('#sensTo').value);
    if (lo == null || hi == null) { $('#sensProgress').textContent = 'Check the From and To values.'; return; }
    const n = Math.max(2, Math.min(15, +$('#sensPoints').value || 6)), runs = Math.max(1, Math.min(20, +$('#sensRuns').value || 2));
    const modes = [['sensBase', 'baseline'], ['sensOpt', 'optimised'], ['sensMan', 'manual']].filter(x => $('#' + x[0]).checked).map(x => x[1]);
    if (!modes.length) { $('#sensProgress').textContent = 'Pick at least one mode.'; return; }
    let values = []; for (let i = 0; i < n; i++) values.push(lo + (hi - lo) * i / (n - 1));
    if (isInt(m)) values = [...new Set(values.map(Math.round))]; else if (m.type === 'clock') values = [...new Set(values.map(v => Math.round(v / 5) * 5))];
    else if (m.type === 'pct') values = values.map(v => Math.round(v * 1000) / 1000);
    const base = PS.sanitizeParams(Object.assign({}, readParamsSafe()));
    const job = { params: base, overrides: state.overrides, cohortMap: state.cohortMap, key: m.key, values, runs, modes };
    const meta = { m, values, modes, runs, current: base[m.key] };
    $('#btnSens').disabled = true; $('#sensProgress').textContent = 'Running 0 of ' + values.length * runs * modes.length + '…';
    const finish = (results) => { $('#btnSens').disabled = false; sensLast = Object.assign(meta, { results }); $('#sensProgress').textContent = values.length + ' points × ' + runs + ' run' + (runs > 1 ? 's' : '') + ' × ' + modes.length + ' mode' + (modes.length > 1 ? 's' : '') + ', seeds ' + base.seed + '–' + (base.seed + runs - 1) + '.'; drawSens(sensLast); };
    try {
      if (sensWorker) sensWorker.terminate();
      sensWorker = new Worker('js/sens-worker.js');
      sensWorker.onmessage = (ev) => { if (ev.data.type === 'progress') $('#sensProgress').textContent = 'Running ' + ev.data.done + ' of ' + ev.data.total + '…'; else finish(ev.data.results); };
      sensWorker.onerror = () => { sensWorker = null; runSensHere(job, finish); };
      sensWorker.postMessage(job);
    } catch (err) { runSensHere(job, finish); }
  });
  async function runSensHere(job, finish) { // fallback when workers are unavailable (e.g. opened from disk)
    const roles = PS.buildRoles(job.overrides, job.cohortMap); const out = job.values.map(() => ({})); let done = 0; const total = job.values.length * job.runs * job.modes.length;
    for (let i = 0; i < job.values.length; i++) for (const md of job.modes) {
      const acc = {};
      for (let r = 0; r < job.runs; r++) { await new Promise(res => setTimeout(res, 0)); const sim2 = new PS.Sim(Object.assign({}, job.params, { [job.key]: job.values[i], seed: job.params.seed + r }), roles, md); sim2.runToEnd(); const s = PS.summarize(sim2); for (const k in s) acc[k] = (acc[k] || 0) + s[k] / job.runs; done++; $('#sensProgress').textContent = 'Running ' + done + ' of ' + total + '…'; }
      out[i][md] = acc;
    }
    finish(out);
  }
  function niceTicks(lo, hi, n) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step; const ticks = [];
    for (let t = t0; t <= t1 + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return ticks;
  }
  function clockTicks(lo, hi) {
    const step = [15, 30, 60, 120, 180, 240].find(st => (hi - lo) / st <= 5) || 360;
    const t0 = Math.floor(lo / step) * step, t1 = Math.max(t0 + step, Math.ceil(hi / step) * step); const out = [];
    for (let t = t0; t <= t1; t += step) out.push(t); return out;
  }
  function drawSens(S) {
    const { m, values, modes, results, current } = S;
    $('#sensLegend').innerHTML = modes.map(md => '<span><i style="background:' + SENS_COLORS[md] + '"></i>' + MODE_NAME[md] + '</span>').join('') + '<span><i style="background:repeating-linear-gradient(90deg,#9aa1ab 0 4px,transparent 4px 7px)"></i>Current value (' + showV(m, current) + ')</span>';
    const outs = SENS_OUT.filter(o => sensSel.has(o[0]));
    const Wd = 360, Ht = 230, ml = 52, mr = 12, mt = 30, mb = 40;
    const X = (v) => ml + (values.length > 1 ? (v - values[0]) / (values[values.length - 1] - values[0]) : 0.5) * (Wd - ml - mr);
    $('#sensCharts').innerHTML = outs.map(([key, label, dp]) => {
      const ys = []; modes.forEach(md => values.forEach((v, i) => ys.push(results[i][md][key])));
      const ticks = dp === 'clock' ? clockTicks(Math.min(...ys), Math.max(...ys)) : niceTicks(Math.min(...ys), Math.max(...ys), 4); const y0 = ticks[0], y1 = ticks[ticks.length - 1];
      const Y = (v) => mt + (1 - (v - y0) / (y1 - y0 || 1)) * (Ht - mt - mb);
      const fy = (v) => dp === 'clock' ? PS.fmtTime(v).replace(':00', '') : (Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 10) / 10);
      let g = '<text x="8" y="16" font-size="12.5" font-weight="600" fill="#1d232b">' + esc(label) + '</text>';
      ticks.forEach(t => { g += '<line x1="' + ml + '" x2="' + (Wd - mr) + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="#eee9df"/><text x="' + (ml - 6) + '" y="' + (Y(t) + 3.5) + '" font-size="10" text-anchor="end" fill="#6b7380">' + fy(t) + '</text>'; });
      const skip = Math.ceil(values.length / 6);
      values.forEach((v, i) => { if (i % skip && i !== values.length - 1) return; g += '<text x="' + X(v) + '" y="' + (Ht - mb + 15) + '" font-size="10" text-anchor="middle" fill="#6b7380">' + showV(m, v) + '</text>'; });
      g += '<text x="' + ((ml + Wd - mr) / 2) + '" y="' + (Ht - 6) + '" font-size="10.5" text-anchor="middle" fill="#6b7380">' + esc(m.label) + '</text>';
      if (current >= values[0] && current <= values[values.length - 1]) g += '<line x1="' + X(current) + '" x2="' + X(current) + '" y1="' + mt + '" y2="' + (Ht - mb) + '" stroke="#9aa1ab" stroke-dasharray="4 3"/>';
      modes.forEach(md => {
        const pts = values.map((v, i) => [X(v), Y(results[i][md][key])]);
        g += '<polyline fill="none" stroke="' + SENS_COLORS[md] + '" stroke-width="2" points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
        pts.forEach((p, i) => { g += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" fill="' + SENS_COLORS[md] + '"><title>' + MODE_NAME[md] + ' at ' + showV(m, values[i]) + ': ' + (dp === 'clock' ? PS.fmtTime(results[i][md][key]) : (Math.round(results[i][md][key] * 10) / 10)) + '</title></circle>'; });
      });
      return '<div class="chart"><svg viewBox="0 0 ' + Wd + ' ' + Ht + '" role="img" aria-label="' + esc(label) + '">' + g + '</svg></div>';
    }).join('') || '<p class="muted">Pick at least one output above.</p>';
    // table
    const fmtCell = (v, dp) => dp === 'clock' ? PS.fmtTime(v) : (Math.round(v * 10) / 10);
    $('#sensTableWrap').innerHTML = '<div class="row-inline"><button id="btnSensCsv">Download results as CSV</button></div><div class="tablewrap"><table class="data"><thead><tr><th>' + esc(m.label) + '</th>' + outs.map(o => modes.map(md => '<th class="num">' + esc(o[1]) + ' · ' + MODE_NAME[md] + '</th>').join('')).join('') + '</tr></thead><tbody>' +
      values.map((v, i) => '<tr><td>' + showV(m, v) + '</td>' + outs.map(o => modes.map(md => '<td class="num">' + fmtCell(results[i][md][o[0]], o[2]) + '</td>').join('')).join('') + '</tr>').join('') + '</tbody></table></div>';
    $('#btnSensCsv').addEventListener('click', () => {
      const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
      const head = [m.label].concat(...SENS_OUT.map(o => modes.map(md => o[1] + ' - ' + MODE_NAME[md])));
      const lines = [head.map(q).join(',')].concat(values.map((v, i) => [showV(m, v)].concat(...SENS_OUT.map(o => modes.map(md => fmtCell(results[i][md][o[0]], o[2])))).map(q).join(',')));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'sensitivity-' + m.key + '.csv'; a.click();
    });
  }

  // ------------------------------------------------------------------ firms
  const FIRM_COLS = [
    ['X', 'Target X', 'num'], ['pop', 'Popularity', 'num'], ['strategy', 'List strategy', 'sel', ['auto', 'confident', 'competing', 'defensive']],
    ['hotMult', 'Hotlist ×X', 'num', 'blank'], ['listMult', 'List ×X', 'num', 'blank'], ['inter', 'Interactions', 'sel', [1, 2]],
    ['i1min', 'Int 1 min', 'num'], ['i1max', 'Int 1 max', 'num'], ['i2min', 'Int 2 min', 'num'], ['i2max', 'Int 2 max', 'num'],
    ['late', 'Late slot', 'chk'], ['manualOpen', 'Manual open', 'txt'], ['manualPanels', 'Manual panels', 'num', 'blank'],
    ['gd', 'GD (clusters 2–3)', 'chk'], ['gdLen', 'GD min', 'num'], ['gdMin', 'GD size min', 'num', 'blank'], ['gdMax', 'GD size max', 'num', 'blank'],
  ];
  const ID_COLS = [['company', 'Company', 'txt'], ['role', 'Role', 'txt'], ['cohort', 'Cohort', 'cohort'], ['clusterFix', 'Cluster', 'cluster']];
  const userKeys = (o) => Object.keys(o).filter(PS.isUserKey);
  const addedRoles = () => (state.overrides.__added = state.overrides.__added || []);
  const removedRoles = () => (state.overrides.__removed = state.overrides.__removed || []);
  const firmEditCount = () => {
    const e = userKeys(state.overrides).length, a = (state.overrides.__added || []).length, r = (state.overrides.__removed || []).filter(id => !id.startsWith('N')).length;
    const parts = []; if (e) parts.push(e + ' role' + (e > 1 ? 's' : '') + ' edited'); if (a) parts.push(a + ' added'); if (r) parts.push(r + ' removed');
    return parts.length ? parts.join(', ') : 'No edits';
  };
  function tidyOverrides() {
    if (state.overrides.__added && !state.overrides.__added.length) delete state.overrides.__added;
    if (state.overrides.__removed && !state.overrides.__removed.length) delete state.overrides.__removed;
  }
  function renderFirms() {
    const cl = +$('#firmCluster').value, q = $('#firmSearch').value.toLowerCase();
    const roles = PS.buildRoles(state.overrides, state.cohortMap);
    const cohorts = [...new Set(PS.ROLES.map(r => r.cohort).concat(roles.map(r => r.cohort)))].sort();
    $('#firmCohorts').innerHTML = cohorts.map(c => '<option value="' + esc(c) + '">').join('');
    const rows = roles.filter(r => (!cl || r.cluster === cl) && (!q || (r.company + ' ' + r.role + ' ' + r.cohort).toLowerCase().includes(q)));
    const head = '<tr><th></th>' + ID_COLS.map(c => '<th>' + c[1] + '</th>').join('') + FIRM_COLS.map(c => '<th>' + c[1] + '</th>').join('') + '</tr>';
    const body = rows.map(r => {
      const isNew = r.id.startsWith('N'); const o = isNew ? {} : (state.overrides[r.id] || {});
      const mark = (k) => (!isNew && Object.prototype.hasOwnProperty.call(o, k)) ? ' class="changed"' : (isNew ? ' class="added"' : '');
      const idc = ID_COLS.map(([k, , type]) => {
        if (type === 'txt') return '<td' + mark(k) + '><input type="text" class="wide" data-id="' + r.id + '" data-k="' + k + '" value="' + esc(r[k] || '') + '"></td>';
        if (type === 'cohort') return '<td' + mark(k) + '><input type="text" class="wide" list="firmCohorts" data-id="' + r.id + '" data-k="' + k + '" value="' + esc(r[k] || '') + '"></td>';
        return '<td' + mark(k) + '><select data-id="' + r.id + '" data-k="clusterFix">' + [1, 2, 3].map(x => '<option' + (x === r.cluster ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></td>';
      }).join('');
      const cells = FIRM_COLS.map(([k, , type, opt]) => {
        const v = r[k] == null ? '' : r[k]; const ch = mark(k);
        if (type === 'sel') return '<td' + ch + '><select data-id="' + r.id + '" data-k="' + k + '">' + opt.map(x => '<option' + (String(x) === String(v || (k === 'strategy' ? 'auto' : '')) ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></td>';
        if (type === 'chk') return '<td' + ch + '><input type="checkbox" data-id="' + r.id + '" data-k="' + k + '"' + (v ? ' checked' : '') + '></td>';
        if (type === 'txt') return '<td' + ch + '><input type="text" placeholder="e.g. 10:30 am" data-id="' + r.id + '" data-k="' + k + '" value="' + esc(v) + '"></td>';
        return '<td' + ch + '><input type="number" step="any" data-id="' + r.id + '" data-k="' + k + '" value="' + v + '"' + (opt === 'blank' ? ' placeholder="auto"' : '') + '></td>';
      }).join('');
      return '<tr' + (isNew ? ' class="newrow"' : '') + '><td><button class="rowdel" title="Remove this role" data-del="' + r.id + '">✕</button><span class="swatch" style="background:' + PS.firmColor(r.company) + '"></span></td>' + idc + cells + '</tr>';
    }).join('');
    $('#firmTable').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    const nr = (state.overrides.__removed || []).length;
    $('#btnRestoreFirms').style.display = nr ? '' : 'none'; $('#btnRestoreFirms').textContent = 'Restore ' + nr + ' removed role' + (nr > 1 ? 's' : '');
    $('#firmDirty').textContent = firmEditCount() + ' · ' + roles.length + ' roles in ' + new Set(roles.map(r => r.company)).size + ' companies';
  }
  $('#firmTable').addEventListener('change', (e) => {
    const el = e.target; const id = el.dataset.id, k = el.dataset.k; if (!id) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = el.value === '' ? null : parseFloat(el.value);
    if (k === 'inter' || k === 'clusterFix') v = +v;
    if (k === 'X' && v != null) v = Math.max(1, Math.round(v));
    if (k === 'pop' && v != null) v = Math.max(0, Math.min(100, v));
    if (typeof v === 'string' && ['company', 'role', 'cohort'].includes(k)) v = v.trim();
    if (id.startsWith('N')) {
      const r = addedRoles().find(x => x.id === id); if (!r) return;
      if (v === null || (k === 'strategy' && v === 'auto')) delete r[k]; else if (!(['company', 'role', 'cohort'].includes(k) && !v)) r[k] = v;
      if (k === 'cohort' && v && state.cohortMap[v] == null) { r.clusterFix = r.clusterFix || 3; state.cohortMap[v] = r.clusterFix; }
    } else {
      const base = PS.ROLES.find(r => r.id === id); const o = state.overrides[id] = state.overrides[id] || {};
      const baseCluster = state.cohortMap[(o.cohort || base.cohort)] || PS.COHORT_CLUSTER[o.cohort || base.cohort];
      if (k === 'clusterFix') { if (v === baseCluster) delete o.clusterFix; else o.clusterFix = v; }
      else if (v === null || v === '' || v === base[k] || (k === 'strategy' && v === 'auto')) delete o[k]; else o[k] = v;
      if (k === 'cohort' && v && state.cohortMap[v] == null) state.cohortMap[v] = o.clusterFix || baseCluster || 3;
      if (!Object.keys(o).length) delete state.overrides[id];
    }
    persist();
    if (['company', 'role', 'cohort', 'clusterFix'].includes(k)) renderFirms();
    else { el.parentElement.classList.toggle('changed', !id.startsWith('N') && !!state.overrides[id] && Object.prototype.hasOwnProperty.call(state.overrides[id], k)); $('#firmDirty').textContent = firmEditCount() + ' (apply to use)'; }
  });
  $('#firmTable').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-del]'); if (!b) return;
    const id = b.dataset.del;
    if (id.startsWith('N')) state.overrides.__added = addedRoles().filter(r => r.id !== id);
    else { delete state.overrides[id]; if (!removedRoles().includes(id)) removedRoles().push(id); }
    tidyOverrides(); persist(); renderFirms();
  });
  $('#btnAddFirm').addEventListener('click', () => {
    const cl = +$('#firmCluster').value || 1; const list = addedRoles();
    let n = list.length + 1; while (list.some(r => r.id === 'N' + String(n).padStart(3, '0'))) n++;
    const id = 'N' + String(n).padStart(3, '0');
    const cohort = Object.keys(state.cohortMap).find(c => state.cohortMap[c] === cl) || 'New cohort';
    list.push({ id, company: 'New company ' + n, role: 'Summer Intern', cohort, clusterFix: cl, pop: 50, X: 2, inter: 1, i1min: 30, i1max: 60, i2min: 20, i2max: 30, late: false, gd: false, gdLen: 30 });
    persist(); $('#firmSearch').value = ''; renderFirms();
    const row = $('#firmTable').querySelector('input[data-id="' + id + '"][data-k="company"]'); if (row) { row.scrollIntoView({ block: 'center' }); row.select(); }
  });
  $('#btnRestoreFirms').addEventListener('click', () => { delete state.overrides.__removed; persist(); renderFirms(); });
  $('#firmCluster').addEventListener('change', renderFirms);
  $('#firmSearch').addEventListener('input', renderFirms);
  $('#btnApplyFirms').addEventListener('click', () => { persist(); newSim(); goSim(); });
  $('#btnResetFirms').addEventListener('click', () => { const st = state.overrides.__students; state.overrides = st ? { __students: st } : {}; persist(); renderFirms(); newSim(); });

  // ------------------------------------------------------------------ student roster (add, edit, remove students)
  const stuEdits = () => (state.overrides.__students = state.overrides.__students || { edits: {}, added: [], removed: [] });
  function tidyStudents() {
    const E = state.overrides.__students; if (!E) return;
    for (const k of Object.keys(E.edits || {})) if (!Object.keys(E.edits[k]).length) delete E.edits[k];
    if (!Object.keys(E.edits || {}).length && !(E.added || []).length && !(E.removed || []).length) delete state.overrides.__students;
  }
  function rosterCount() {
    const E = state.overrides.__students || {}; const e = Object.keys(E.edits || {}).length, a = (E.added || []).length, r = (E.removed || []).filter(k => k.startsWith('b')).length;
    const parts = []; if (e) parts.push(e + ' edited'); if (a) parts.push(a + ' added'); if (r) parts.push(r + ' removed');
    return parts.length ? parts.join(', ') : 'No edits';
  }
  function renderRoster() {
    const roles = PS.buildRoles(state.overrides, state.cohortMap);
    const preview = new PS.Sim(state.params, roles, 'optimised'); const E = state.overrides.__students || { edits: {}, added: [], removed: [] };
    const cohorts = [...new Set(roles.map(r => r.cohort))].sort();
    const q = ($('#rosterFind').value || '').toLowerCase();
    const P = preview.P;
    const rows = preview.students.filter(st => !q || st.name.toLowerCase().includes(q)).map(st => {
      const isNew = st.key.startsWith('a'); const e = isNew ? (E.added.find(x => x.key === st.key) || {}) : ((E.edits || {})[st.key] || {});
      const cls = (k) => isNew ? ' class="added"' : (Object.prototype.hasOwnProperty.call(e, k) ? ' class="changed"' : '');
      const num = (k, val, ph, step) => '<td' + cls(k) + '><input type="number" step="' + (step || 'any') + '" data-key="' + st.key + '" data-k="' + k + '" value="' + (e[k] != null ? e[k] : (val != null ? val : '')) + '" placeholder="' + ph + '"></td>';
      return '<tr' + (isNew ? ' class="newrow"' : '') + '><td><button class="rowdel" title="Remove this student" data-sdel="' + st.key + '">✕</button></td><td class="num">' + (st.id + 1) + '</td>' +
        '<td' + cls('name') + '><input type="text" class="wide" data-key="' + st.key + '" data-k="name" value="' + esc(st.name) + '"></td>' +
        num('strength', +st.strength.toFixed(2), 'random', '0.01') + num('prefNoise', null, String(P.prefNoise)) +
        '<td' + cls('favCohort') + '><select data-key="' + st.key + '" data-k="favCohort"><option value="">None</option>' + cohorts.map(c => '<option' + (e.favCohort === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></td>' +
        num('favBonus', null, '0') + '<td' + cls('applyShare') + '><input type="number" class="mid" step="1" min="1" max="100" data-key="' + st.key + '" data-k="applyShare" value="' + (e.applyShare != null ? Math.round(e.applyShare * 100) : '') + '" placeholder="random"></td>' +
        '<td class="muted">' + (isNew ? 'Added' : (Object.keys(e).length ? 'Edited' : '')) + '</td></tr>';
    }).join('');
    $('#stuRoster').innerHTML = '<thead><tr><th></th><th class="num">#</th><th>Name</th><th>CV strength</th><th>Preference spread</th><th>Favourite cohort</th><th>Bonus</th><th>Applies to (% of roles)</th><th></th></tr></thead><tbody>' + rows + '</tbody>';
    const nr = (E.removed || []).length; $('#btnRestoreStudents').style.display = nr ? '' : 'none'; $('#btnRestoreStudents').textContent = 'Restore ' + nr + ' removed student' + (nr > 1 ? 's' : '');
    $('#rosterDirty').textContent = rosterCount() + ' · ' + preview.students.length + ' students';
  }
  $('#btnStuRoster').addEventListener('click', () => {
    const card = $('#stuRosterCard'); const show = card.style.display === 'none'; card.style.display = show ? '' : 'none';
    $('#btnStuRoster').textContent = show ? 'Hide student editor' : 'Edit students'; if (show) renderRoster();
  });
  $('#rosterFind').addEventListener('input', renderRoster);
  $('#stuRoster').addEventListener('change', (ev) => {
    const el = ev.target; const key = el.dataset.key, k = el.dataset.k; if (!key) return;
    const E = stuEdits(); let v = el.value;
    if (el.type === 'number') v = el.value === '' ? null : parseFloat(el.value);
    if (k === 'applyShare' && v != null) v = Math.max(1, Math.min(100, v)) / 100;
    if (k === 'name') v = v.trim() || null;
    if (k === 'favCohort' && !v) v = null;
    const target = key.startsWith('a') ? E.added.find(x => x.key === key) : (E.edits[key] = E.edits[key] || {});
    if (!target) return;
    if (v == null) delete target[k]; else target[k] = v;
    if (!key.startsWith('b') || k !== 'name') { /* keep */ }
    tidyStudents(); persist(); renderRoster();
  });
  $('#stuRoster').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-sdel]'); if (!b) return; const key = b.dataset.sdel; const E = stuEdits();
    if (key.startsWith('a')) E.added = E.added.filter(x => x.key !== key); else { delete E.edits[key]; if (!E.removed.includes(key)) E.removed.push(key); }
    tidyStudents(); persist(); renderRoster();
  });
  $('#btnAddStudent').addEventListener('click', () => {
    const E = stuEdits(); let n = E.added.length + 1; while (E.added.some(x => x.key === 'a' + n)) n++;
    E.added.push({ key: 'a' + n, name: 'New student ' + n }); persist(); $('#rosterFind').value = ''; renderRoster();
    const inp = $('#stuRoster').querySelector('input[data-key="a' + n + '"][data-k="name"]'); if (inp) { inp.scrollIntoView({ block: 'center' }); inp.select(); }
  });
  $('#btnRestoreStudents').addEventListener('click', () => { const E = stuEdits(); E.removed = []; tidyStudents(); persist(); renderRoster(); });
  $('#btnResetStudents').addEventListener('click', () => { delete state.overrides.__students; persist(); renderRoster(); newSim(); });
  $('#btnApplyStudents').addEventListener('click', () => { persist(); newSim(); renderRoster(); renderStudents(); });

  // ------------------------------------------------------------------ GD days
  const gdShort = (n) => n.replace(/ (India|Private|Limited|Pvt|Ltd|Group|International|Technologies|Solutions|Consulting|Services|Company|Wellness|Bengaluru)\b.*$/i, '').slice(0, 16);
  function renderGd() {
    const days = sim && sim.gdDays ? Object.keys(sim.gdDays).map(Number) : [];
    const sel = $('#gdCluster'), want = +sel.dataset.want || +sel.value || days[days.length - 1];
    sel.innerHTML = days.map(k => '<option value="' + k + '"' + (k === want ? ' selected' : '') + '>Cluster ' + k + '</option>').join(''); delete sel.dataset.want;
    const has = days.length > 0;
    ['#gdSummary', '#gdTable'].forEach(x => { $(x).innerHTML = ''; }); $('#gdGantt').innerHTML = ''; $('#gdGanttNote').textContent = '';
    $('#gdEmpty').style.display = has ? 'none' : ''; $('#gdGantt').closest('.card').style.display = has ? '' : 'none'; $('#gdTable').closest('.card').style.display = has ? '' : 'none';
    if (!has) { $('#gdEmpty').textContent = sim.P.gdOn ? 'The first GD day is held after cluster 1 ends. Run the simulation into cluster 2 (Skip day gets there quickly) and come back here.' : 'Group discussions are switched off on the Assumptions tab.'; return; }
    const k = +sel.value, g = sim.gdDays[k], P = sim.P, mode = $('#gdMode').value, lb = g.lowerBound;
    const inv = g.companies.reduce((a, c) => a + c.invited, 0), R = P.wings * P.gdRoomsPerWing;
    const binding = lb.value === lb.byStudent ? 'the busiest student\'s own GDs back to back' : lb.value === lb.byFirm ? 'the longest company block' : 'total GD work over ' + R + ' rooms';
    const rows = [
      ['Companies holding GDs · invitations', () => g.companies.length + ' · ' + inv],
      ['Most GDs for one student', () => lb.maxGdsPerStudent],
      ['Groups held', x => x.nGroups],
      ['Last GD finished', x => PS.fmtTime(x.end)],
      ['Lower bound on the last finish (' + binding + ')', () => PS.fmtTime(Math.ceil(lb.value))],
      ['Gap to the lower bound', x => Math.max(0, Math.round(x.end - lb.value)) + ' min'],
      ['Companies given two panels', x => x.twoPanel],
      ['Panelist idle hours (a panel waiting while its company is still running)', x => Math.round(x.panelIdle / 60)],
      ['Late (buffer) GDs timetabled after ' + PS.fmtTime(P.gdLatestStart) + ' · with two panels', x => x.latePlanned + ' · ' + (x.lateTwoPanel || 0)],
      ['Companies actually starting after ' + PS.fmtTime(P.gdLatestStart) + ' (planned, or pushed late by overruns)', x => x.lateActual],
      ['Groups held up because a member was still in another GD', x => x.clashGroups],
      ['Group-minutes lost waiting for those members', x => x.clashWait.toLocaleString('en-IN')],
      ['Groups running past ' + PS.fmtTime(P.gdDayEnd), x => x.lateGroups],
      ['GD room-hours used (of ' + R + ' rooms)', x => Math.round(x.roomHours)],
    ];
    $('#gdSummary').innerHTML = '<div class="card"><h3>GD day before cluster ' + k + '</h3><table class="data"><thead><tr><th>Measure</th><th class="num">Baseline (fixed blocks)</th><th class="num">Optimised (timetabled blocks)</th></tr></thead><tbody>' +
      rows.map(([l, fn]) => '<tr><td>' + l + '</td><td class="num">' + fn(g.baseline) + '</td><td class="num">' + fn(g.optimised) + '</td></tr>').join('') + '</tbody></table>' +
      '<p class="muted">In both timetables a company runs its GDs as one block in one wing, with one or two panels in that wing\'s syndicate rooms, and the next company may use a room only ' + P.gdSwitch + ' minutes after the last group there ends. ' +
      'Baseline is today\'s practice: any company with two or more groups gets two panels; companies are timetabled in popularity order, and the next company in a room is timetabled ' + Math.round(P.gdBuffer / 60 * 10) / 10 + ' hours after the block was due to end (squeezed to the ' + P.gdSwitch + '-minute gap if that would start it after ' + PS.fmtTime(P.gdLatestStart) + '). Groups are made in list order and dealt to the panels in turn, so a panel waits whenever one of its members is still in another company\'s GD, and with an odd number of groups one panel sits idle at the end. ' +
      'Optimised gives a company two panels only when its invitees split into an even number of groups within the size limits, so both panels run the same number of rounds. The timetable is built by greedy insertion from several company orders (most-loaded students first, shortest block first, longest block first, largest company first, and shuffles), keeping the best order. Starting after ' + PS.fmtTime(P.gdLatestStart) + ' is allowed but undesirable, like a buffer room: the timetable first keeps the number of such late (buffer) GDs as low as it can, then takes the earliest finish plus a reputation term (mean start time weighted towards the most popular companies, times ' + P.gdPopWeight + '), so names like TAS or Aditya Birla open first. If no order fits by ' + PS.fmtTime(P.gdLatestStart) + ', late companies are moved to the front and the rounds are packed tighter; a company that still has to start late runs two panels, so it is over quickly (one panel only if its invitees make a single group). Late GDs are flagged in the table below. Each company takes the earliest slot at which a wing is free and every invitee fits into one of its rounds without a clash (students are matched to rounds by augmenting paths). Rounds are spaced at the mean GD length plus one standard deviation, so overruns rarely hold anyone up. ' +
      'The timetable does not change who is selected: GD performance is drawn once per student and company, so both timetables give the same post-GD lists.</p></div>';
    // Gantt
    const x = g[mode], end = Math.max(g.baseline.end, g.optimised.end, P.gdDayEnd * 0 + 240), t1 = Math.ceil((end + 20) / 60) * 60;
    const W = 1100, L = 120, top = 24, rh = 22, H = top + R * rh + 26, sx = t => L + (W - L - 10) * t / t1;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:760px;font:11px system-ui,sans-serif">';
    for (let t = 0; t <= t1; t += 60) svg += '<line x1="' + sx(t) + '" x2="' + sx(t) + '" y1="' + (top - 4) + '" y2="' + (H - 18) + '" stroke="#8884" /><text x="' + sx(t) + '" y="14" text-anchor="middle" fill="currentColor">' + PS.fmtTime(t).replace(':00', '') + '</text>';
    for (let w = 0; w < P.wings; w++) for (let j = 0; j < P.gdRoomsPerWing; j++) { const r = w * P.gdRoomsPerWing + j, y = top + r * rh; svg += '<text x="4" y="' + (y + 15) + '" fill="currentColor">Wing ' + PS.wingLabel(w) + ' · syndicate ' + (j + 1) + '</text><line x1="' + L + '" x2="' + (W - 10) + '" y1="' + (y + rh) + '" y2="' + (y + rh) + '" stroke="#8882"/>'; }
    for (const gr of x.groups) {
      const r = gr.wing * P.gdRoomsPerWing + gr.slot, y = top + r * rh + 3, x0 = sx(gr.start), w = Math.max(1, sx(gr.end) - x0);
      svg += '<g><title>' + esc(gr.comp) + ': ' + PS.fmtTime(gr.start) + '–' + PS.fmtTime(Math.round(gr.end)) + ', ' + gr.size + ' students</title><rect x="' + x0 + '" y="' + y + '" width="' + w + '" height="' + (rh - 6) + '" rx="3" fill="' + PS.firmColor(gr.comp) + '" stroke="#0006" stroke-width="0.5"/>' +
        (w > 46 ? '<text x="' + (x0 + 3) + '" y="' + (y + 12) + '" fill="#fff" style="font-size:10px">' + esc(gdShort(gr.comp)) + '</text>' : '') + '</g>';
    }
    if (P.gdDayEnd <= t1) svg += '<line x1="' + sx(P.gdDayEnd) + '" x2="' + sx(P.gdDayEnd) + '" y1="' + top + '" y2="' + (H - 8) + '" stroke="#c0392b" stroke-dasharray="4 3"/>';
    const lbx = sx(Math.ceil(lb.value)); svg += '<line x1="' + lbx + '" x2="' + lbx + '" y1="' + top + '" y2="' + (H - 18) + '" stroke="#2f9e6b" stroke-dasharray="4 3"/><text x="' + lbx + '" y="' + (H - 4) + '" text-anchor="middle" fill="#2f9e6b">lower bound</text>';
    svg += '</svg>';
    $('#gdGantt').innerHTML = svg;
    $('#gdGanttNote').textContent = (mode === 'baseline' ? 'Baseline fixed-block timetable' : 'Optimised timetable') + '. Each bar is one group; hover for the company, times and group size. The green dashed line is the lower bound. Both timetables share the same time axis.';
    // table
    const by = (m) => new Map(g[m].perComp.map(c => [c.name, c]));
    const B = by('baseline'), O = by('optimised');
    const span = (c) => c && c.start != null ? PS.fmtTime(c.start) + '–' + PS.fmtTime(Math.round(c.end)) : '–';
    const roleOf = (lab, comp) => lab.startsWith(comp + ' – ') ? lab.slice(comp.length + 3) : lab;
    $('#gdTable').innerHTML = '<thead><tr><th>Company</th><th class="num">Applied to any role</th><th class="num">Called to GD</th><th class="num">GD length</th><th class="num">Group size</th><th class="num">Groups</th><th>Baseline block (planned)</th><th>Baseline actual</th><th>Optimised</th><th class="num">Panels: base · opt</th><th class="num">Wing (opt.)</th><th class="num">Panelist idle (opt., min)</th><th>Each role: usual CV shortlist → interview list after GD</th></tr></thead><tbody>' +
      g.companies.slice().sort((a, b) => b.invited - a.invited).map(c => { const b = B.get(c.name), o = O.get(c.name);
        return '<tr><td><span class="swatch" style="background:' + PS.firmColor(c.name) + '"></span>' + esc(c.name) + '</td><td class="num">' + (c.pool || '–') + '</td><td class="num">' + c.invited + '</td><td class="num">' + c.len + ' min</td><td class="num">' + c.min + '–' + c.max + '</td><td class="num">' + (o ? o.groups : '–') + '</td><td>' + (b && b.plannedStart != null ? PS.fmtTime(b.plannedStart) + '–' + PS.fmtTime(b.plannedEnd) : '–') + '</td><td>' + span(b) + (b && b.late ? ' <span class="tag late">late buffer</span>' : '') + '</td><td>' + span(o) + (o && o.late ? ' <span class="tag late">late buffer</span>' : '') + '</td><td class="num">' + (b ? b.panels : '–') + ' · ' + (o ? o.panels : '–') + '</td><td class="num">' + (o && o.wing != null ? PS.wingLabel(o.wing) : '–') + '</td><td class="num">' + (o ? o.idle : '–') + '</td><td class="muted">' +
          c.after.map(a => esc(roleOf(a.label, c.name)) + ': ' + a.cv + ' → ' + a.gd).join('<br>') + '</td></tr>'; }).join('') + '</tbody>';
  }
  $('#gdCluster').addEventListener('change', renderGd);
  $('#gdMode').addEventListener('change', renderGd);
  $('#btnGdCsv').addEventListener('click', () => {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"'; const lines = [['GD day before cluster', 'Timetable', 'Company', 'Wing', 'GD room', 'Start', 'End', 'Students'].map(q).join(',')];
    for (const k of Object.keys(sim.gdDays || {})) for (const m of ['baseline', 'optimised']) for (const gr of sim.gdDays[k][m].groups) lines.push([k, MODE_NAME[m], gr.comp, PS.wingLabel(gr.wing), gr.slot + 1, PS.fmtTime(gr.start), PS.fmtTime(Math.round(gr.end)), gr.size].map(q).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'gd-timetables.csv'; a.click();
  });

  // ------------------------------------------------------------------ cohorts
  function cohortStats() {
    const roles = PS.buildRoles(state.overrides, state.cohortMap); const by = {};
    roles.forEach(r => { const c = by[r.cohort] = by[r.cohort] || { cohort: r.cohort, roles: 0, X: 0, pop: 0 }; c.roles++; c.X += +r.X; c.pop += +r.pop; });
    return Object.values(by).map(c => Object.assign(c, { pop: c.pop / c.roles, cluster: state.cohortMap[c.cohort] })).sort((a, b) => a.cluster - b.cluster || b.pop - a.pop);
  }
  function renderCohorts() {
    const S = cohortStats();
    const tot = [1, 2, 3].map(k => S.filter(c => c.cluster === k).reduce((a, c) => ({ roles: a.roles + c.roles, X: a.X + c.X, n: a.n + 1 }), { roles: 0, X: 0, n: 0 }));
    $('#cohortTotals').innerHTML = tot.map((t, i) => '<div class="counter"><div class="v">Cluster ' + (i + 1) + '</div><div class="k">' + t.n + ' cohorts · ' + t.roles + ' roles · ' + t.X + ' hires</div></div>').join('');
    $('#cohortTable').innerHTML = '<thead><tr><th>Cohort</th><th class="num">Roles</th><th class="num">Target X</th><th class="num">Batch preference (avg popularity)</th><th>Cluster</th></tr></thead><tbody>' +
      S.map(c => '<tr><td>' + esc(c.cohort) + '</td><td class="num">' + c.roles + '</td><td class="num">' + c.X + '</td><td class="num">' + c.pop.toFixed(1) + '</td><td><select data-cohort="' + esc(c.cohort) + '">' + [1, 2, 3].map(k => '<option' + (k === c.cluster ? ' selected' : '') + '>' + k + '</option>').join('') + '</select>' + (c.cluster !== PS.COHORT_CLUSTER[c.cohort] ? ' <span class="muted">moved</span>' : '') + '</td></tr>').join('') + '</tbody>';
  }
  $('#cohortTable').addEventListener('change', (e) => { const c = e.target.dataset.cohort; if (!c) return; state.cohortMap[c] = +e.target.value; persist(); renderCohorts(); });
  $('#btnPractice').addEventListener('click', () => {
    const S = cohortStats().sort((a, b) => b.pop - a.pop); const total = S.reduce((a, c) => a + c.roles, 0); let run = 0;
    S.forEach(c => { const k = run < total / 3 ? 1 : run < 2 * total / 3 ? 2 : 3; state.cohortMap[c.cohort] = k; run += c.roles; });
    persist(); renderCohorts();
  });
  $('#btnDefaultCohorts').addEventListener('click', () => { state.cohortMap = Object.assign({}, PS.COHORT_CLUSTER); persist(); renderCohorts(); });
  $('#btnApplyCohorts').addEventListener('click', () => { persist(); newSim(); goSim(); });

  $('#btnSolveIP').addEventListener('click', () => {
    const mr = +$('#ipMaxRoles').value || Infinity, mh = +$('#ipMaxHires').value || Infinity;
    $('#ipStatus').textContent = 'Solving…';
    setTimeout(() => {
      const t0 = performance.now(); const roles = PS.buildRoles(state.overrides, state.cohortMap);
      const r = PS.solveCohortIP(roles, { maxRoles: mr, maxHires: mh }); const ms = Math.round(performance.now() - t0);
      if (!r.feasible) { $('#ipStatus').textContent = ''; $('#ipResult').innerHTML = '<p class="warn">No allocation satisfies these caps (' + r.stats.nodes + ' nodes explored). Loosen the caps and solve again.</p>'; return; }
      const cur = r.score(state.cohortMap); const per = { 1: [0, 0], 2: [0, 0], 3: [0, 0] };
      roles.forEach(x => { per[r.alloc[x.cohort]][0]++; per[r.alloc[x.cohort]][1] += +x.X; });
      const st = r.stats; const curPer = { 1: [0, 0], 2: [0, 0], 3: [0, 0] }; roles.forEach(x => { curPer[state.cohortMap[x.cohort]][0]++; curPer[state.cohortMap[x.cohort]][1] += +x.X; }); const curViol = [1, 2, 3].some(k => curPer[k][0] > mr || curPer[k][1] > mh);
      $('#ipStatus').textContent = (r.optimal ? 'Optimal' : 'Best found (node limit reached)') + ' in ' + ms + ' ms.';
      $('#ipResult').innerHTML = '<div class="totals">' +
        [['Objective', r.objective.toFixed(1) + ' (current split ' + cur.toFixed(1) + (curViol ? ', breaks the caps' : '') + ')'], ['Root LP bound', st.rootBound.toFixed(1)], ['Nodes explored', st.nodes + ''], ['Fathomed', st.byBound + ' by bound · ' + st.byIntegrality + ' integral · ' + st.infeasible + ' infeasible']]
          .map(c => '<div class="counter"><div class="v">' + c[1] + '</div><div class="k">' + c[0] + '</div></div>').join('') + '</div>' +
        '<p class="muted">Proposed clusters: ' + [1, 2, 3].map(k => 'cluster ' + k + ' with ' + per[k][0] + ' roles and ' + per[k][1] + ' hires').join('; ') + '. Incumbent improved ' + st.incumbents.length + ' time' + (st.incumbents.length === 1 ? '' : 's') + ' (at nodes ' + st.incumbents.map(x => x.node).join(', ') + ').</p>' +
        '<div class="tablewrap" style="max-height:320px"><table class="data"><thead><tr><th>Cohort</th><th class="num">Roles</th><th class="num">Avg popularity</th><th class="num">Current</th><th class="num">Proposed</th></tr></thead><tbody>' +
        r.cohorts.map(c => '<tr><td>' + esc(c.cohort) + '</td><td class="num">' + c.roles + '</td><td class="num">' + c.pop.toFixed(1) + '</td><td class="num">' + state.cohortMap[c.cohort] + '</td><td class="num' + (r.alloc[c.cohort] !== state.cohortMap[c.cohort] ? ' best' : '') + '">' + r.alloc[c.cohort] + '</td></tr>').join('') + '</tbody></table></div>' +
        '<div class="row-inline"><button id="btnUseIP">Use this allocation</button><span class="muted">Then press "Apply and restart" to run it.</span></div>';
      $('#btnUseIP').addEventListener('click', () => { Object.assign(state.cohortMap, r.alloc); persist(); renderCohorts(); });
    }, 10);
  });

  // ------------------------------------------------------------------ about
  $('#aboutText').innerHTML = `
    <p>This tool simulates three days of final placements: 400 students, 234 roles from 161 companies across three clusters, and interview rooms in nine wings on three floors: wings 2 and 3 on the ground floor, 6, 7 and 8 on the first floor, and 9, 10, 11 and 12 on the second floor (each with 10 planned rooms and 4 buffer rooms by default). Students wait in PP Gupta Auditorium. When a panel calls them, they walk out to the central tracker and check in (about a minute), then go on to their wing (about another minute), where a Placecom volunteer takes them to the room. After the interview they come back the same way, through the central tracker, with the outcome.</p>
    <h3>Each cluster</h3>
    <p>Students still in the process apply to the cluster's roles and rank them, with ties of up to three. Each firm shortlists from its own applicants, choosing a confident, competing or defensive list size. The night before, a plan fixes each firm's open time, panels and rooms. During the day, offers arrive at the end of each firm's final interaction, and students accept (and wait), hold (on a two-hour clock that pauses during interviews), or reject. Each role's target X counts gross offers: it stops once it has made X offers, whether or not the students keep them, so a rejected offer or a released hold is not replaced (the Assumptions tab can switch back to the earlier net count of accepted plus held offers). A role that runs short of candidates extends its shortlist. At the end of the cluster, holds become accepted and about a third of placed students dream into later clusters, with up to three applications and at most two per cluster.</p>
    <h3>Decisions before each cluster</h3>
    <p>Before each cluster starts, the tool shows the decisions fixed the night before: for every firm, its shortlist, when it opens, how many panels it gets and which rooms, under both today's practice (baseline) and the optimised plan, worked out on the same shortlists. The full list, with an opening schedule by time, is on the Decisions tab and can be downloaded.</p>
    <h3>Group discussion days</h3>
    <p>Clusters 2 and 3 each have a GD day the day before, from 8 am to ${PS.fmtTime(PS.DEFAULT_PARAMS.gdDayEnd)}, in the two syndicate rooms either side of the Placecom desk at each of the nine wing entrances; the interview rooms inside the wings stay empty. The Simulation tab animates each GD day before its cluster. A firm with a GD screens everyone who applied to any of its roles once and calls ${PS.DEFAULT_PARAMS.gdInviteMult} times the shortlists its roles would otherwise draw (at least one full group); a student not called cannot be interviewed by that firm. Students cannot decline and there is no cap on how many GDs one student attends. Each company runs one GD process across its roles, in groups of 7 to 10, as one block in one wing with one or two panels (its Placecom volunteer stays in that wing); a room passes to the next company only after a ${PS.DEFAULT_PARAMS.gdSwitch}-minute gap. Two panels are given only when both can run the same number of rounds. After the GD each role is one step more confident and draws its hotlist and shortlist from GD attendees who applied to it; if it runs short on the day it extends only to other GD attendees, best GD performance first. Baseline uses fixed company blocks with a three-hour buffer, as today; the optimised timetable inserts companies one at a time at the earliest clash-free slot, matching students to rounds, and keeps the best of several company orders. Starting after ${PS.fmtTime(PS.DEFAULT_PARAMS.gdLatestStart)} is allowed but kept to a minimum, like a buffer room; a company that has to start that late runs two panels so it is over quickly. Popular companies are pulled to the start of the day. The GD tab compares both against a lower bound.</p>
    <h3>Sensitivity analysis</h3>
    <p>On the Assumptions tab, pick any input and a range, and the tool runs complete placements at each value and plots how every chosen output moves, for each mode. The small arrow beside each assumption opens it in the sensitivity panel.</p>
    <h3>The three modes</h3>
    <p><b>Baseline</b> is today's practice: every firm opens at 8 am, panels in proportion to list size, and each free panel calls the next available student on its list. <b>Optimised</b> sizes panels from expected interviews (Little's law), opens less-preferred firms a little later, packs each role into one wing (the wings are bins, filled with room reuse at noon, and whole wings are freed when the plan allows), and on the day matches free students to free panels with the Hungarian algorithm, scoring each pairing by the chance of a hire that sticks per minute of interview (Smith's rule), the student's own preference, a look-ahead for firms they rank higher, and the urgency of any held offer. <b>Manual</b> uses your own open times and panels from the Firms tab.</p>
    <h3>Methods used</h3>
    <p>The cohort allocation can be solved as a 0-1 integer programme by LP-based branch and bound (Cohorts tab). Panels are sized by Little's law. Each firm's opening time is computed from the preference lists as a release date: a shortlisted student is free for a firm once they are likely to have finished every interview with a firm they rank higher, a free shortlisted candidate counts as a third of a free hotlisted one (an editable setting), and the firm opens at the first half-hour by which its free candidates add up to one hotlisted candidate per planned panel. The pre-day plan is a bin-packing problem: every role must sit in one wing, so each wing is a bin of ten rooms over the day with a morning and an afternoon shelf. Roles are first assigned to wings by the longest-processing-time rule (largest workload first, to the least-loaded wing that still has a room for it), then each wing is scheduled bottom-left (each firm at its earliest feasible time, panels added up to the Little's-law number) and improved inside the wing: a savings list in the spirit of Clarke and Wright gives rooms that are handed over at noon to the firms that gain most from an extra afternoon panel, an Or-opt style move opens small firms earlier so their room can be handed over, and an Or-opt style relocation moves single panels between firms while the hire-weighted finish time falls. The number of wings is then cut one at a time while the plan's cost stays within a small slack, so whole wings are freed when they are not needed. Every plan is reported against a lower bound obtained by relaxing the room constraints. On the day, the matching of free panels to waiting students is an assignment problem, solved exactly each minute by the Hungarian method.</p>
    <h3>Reading the screen</h3>
    <p>Grey dots are students waiting; white dots are walking; blue are in interviews; amber are holding an offer, with a ring showing the time left on the hold clock; green have accepted; purple are dreaming. Rooms take the colour of the firm using them, and hatched rooms are the buffer. Hover over any student or room for details.</p>
    <h3>Changing the model</h3>
    <p>Every probability, time and rule is editable on the Assumptions tab; each role's hires, list sizes, interview lengths and slots are editable on the Firms tab; cohorts can be moved between clusters on the Cohorts tab. Settings are saved in this browser and can be exported to share with your group.</p>`;

  // ------------------------------------------------------------------ boot
  initSens();
  newSim();
  requestAnimationFrame(frame);
})(window.PS);
