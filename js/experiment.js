/* Experiment core shared by the command-line runner and the browser worker.
   runOne() runs one (seed, arm) and returns metrics, runtimes and optional checks; analyse() turns paired runs into
   cell means, paired differences against a reference arm, the 2x2 decomposition and variance-reduction ratios. */
window.PS = window.PS || {};
(function (PS) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  PS.ARMS_2X2 = [
    { id: 'baseline', label: 'Baseline plan + baseline matching', plan: 'baseline', match: 'baseline' },
    { id: 'oplan-bmatch', label: 'Optimised plan + baseline matching', plan: 'optimised', match: 'baseline' },
    { id: 'bplan-omatch', label: 'Baseline plan + optimised matching', plan: 'baseline', match: 'optimised' },
    { id: 'optimised', label: 'Optimised plan + optimised matching', plan: 'optimised', match: 'optimised' },
  ];
  PS.METRICS_SEASON = [
    ['filledPct', 'Roles that reached target X (%)', true], ['top10', 'Placed in the top 10% of their preferences', true], ['below50', 'Placed below 50% of their preferences', true],
    ['totalLoss', 'Offer losses: total', true], ['unplaced', 'Students left unplaced', true], ['holdLoss', 'Offer losses: released holds', true], ['endAvg', 'Average time the last firm left', true],
    ['placed', 'Students placed', false], ['interviews', 'Interviews held', false], ['rejected', 'Offer losses: rejected', false], ['dreamLoss', 'Offer losses: dreams', false], ['dreamConv', 'Dream conversions', false],
    ['util', 'Panel utilisation (%)', false], ['idleMinPerRole', 'Idle panel minutes per role', false], ['buffer', 'Buffer room openings', false], ['peakRooms', 'Peak rooms in use', false], ['extensions', 'Shortlist extensions', false],
  ];
  PS.METRICS_C1 = [
    ['filledPct', 'Cluster 1: roles that reached target X (%)', true], ['top10', 'Cluster 1: placed in the top 10% of their preferences', true], ['below50', 'Cluster 1: placed below 50%', true],
    ['totalLoss', 'Cluster 1: offer losses', true], ['gross', 'Cluster 1: students placed', true], ['holdLoss', 'Cluster 1: offer losses to released holds', true], ['endTime', 'Cluster 1: time the last firm left', true],
    ['interviews', 'Cluster 1: interviews', false], ['util', 'Cluster 1: panel utilisation (%)', false], ['buffer', 'Cluster 1: buffer openings', false], ['peakRooms', 'Cluster 1: peak rooms', false],
  ];
  // per-cluster measures (keys prefixed c1_, c2_, c3_) and GD-day measures (g2_, g3_), so one season run can be viewed
  // round by round without rerunning
  PS.metricsCluster = (k) => [
    ['c' + k + '_filledPct', 'Cluster ' + k + ': roles that reached target X (%)', true], ['c' + k + '_gross', 'Cluster ' + k + ': students placed', true],
    ['c' + k + '_top10', 'Cluster ' + k + ': placed in the top 10% of their preferences', true], ['c' + k + '_below50', 'Cluster ' + k + ': placed below 50%', true],
    ['c' + k + '_totalLoss', 'Cluster ' + k + ': offer losses', true], ['c' + k + '_holdLoss', 'Cluster ' + k + ': offer losses to released holds', true],
    ['c' + k + '_endTime', 'Cluster ' + k + ': time the last firm left', true],
    ['c' + k + '_pool', 'Cluster ' + k + ': students in the pool', false], ['c' + k + '_poolNoOffer', 'Cluster ' + k + ': of whom with no offer yet', false], ['c' + k + '_poolDreamers', 'Cluster ' + k + ': of whom placed earlier, dreaming in', false],
    ['c' + k + '_interviews', 'Cluster ' + k + ': interviews', false], ['c' + k + '_offersMade', 'Cluster ' + k + ': offers made', false],
    ['c' + k + '_rejected', 'Cluster ' + k + ': offer losses, rejected', false], ['c' + k + '_dreamLoss', 'Cluster ' + k + ': offer losses, dreams', false],
    ['c' + k + '_dreamConv', 'Cluster ' + k + ': dream conversions into the cluster', false], ['c' + k + '_util', 'Cluster ' + k + ': panel utilisation (%)', false],
    ['c' + k + '_buffer', 'Cluster ' + k + ': buffer openings', false], ['c' + k + '_peakRooms', 'Cluster ' + k + ': peak rooms', false],
    ['c' + k + '_extensions', 'Cluster ' + k + ': shortlist extensions', false],
  ];
  PS.METRICS_GD = [2, 3].flatMap(k => [
    ['g' + k + '_end', 'GD day before cluster ' + k + ': last GD ends', true], ['g' + k + '_clashWait', 'GD day before cluster ' + k + ': student clash wait (min)', true],
    ['g' + k + '_lateActual', 'GD day before cluster ' + k + ': companies starting after the latest start', true],
    ['g' + k + '_lateGroups', 'GD day before cluster ' + k + ': groups ending after the GD day ends', false],
    ['g' + k + '_util', 'GD day before cluster ' + k + ': GD panel utilisation (%)', false], ['g' + k + '_nGroups', 'GD day before cluster ' + k + ': groups', false],
  ]);
  PS.VIEWS = [['season', 'Whole season'], ['c1', 'Cluster 1'], ['c2', 'Cluster 2'], ['c3', 'Cluster 3'], ['gd', 'GD days']];
  PS.metricsFor = (view) => view === 'season' ? PS.METRICS_SEASON : view === 'gd' ? PS.METRICS_GD : PS.metricsCluster(+view.slice(1));
  // views a set of runs can show: those whose measures are all present in every run
  PS.viewsAvailable = (runs) => PS.VIEWS.filter(([v]) => runs.length && PS.metricsFor(v).every(([m]) => runs.every(r => r.metrics[m] != null)));
  // which way is better, for highlighting
  PS.betterDir = (m) => { const b = m.replace(/^[cg]\d_/, '');
    if (['filledPct', 'top10', 'placed', 'gross', 'dreamConv', 'util'].includes(b)) return 'high';
    if (['below50', 'wasted', 'unplaced', 'lostHolds', 'lost', 'totalLoss', 'rejected', 'holdLoss', 'dreamLoss', 'idleMinPerRole', 'idle', 'buffer', 'endAvg', 'endTime', 'end', 'clashWait', 'lateActual', 'lateGroups', 'panelIdle'].includes(b)) return 'low';
    return null; };
  PS.isClockMetric = (m) => /(^|_)(endAvg|endTime|end)$/.test(m);
  // precision targets (95% half-width of a paired difference) used to size the main run
  PS.PRECISION = { filledPct: 1.0, top10: 3, below50: 3, totalLoss: 3, unplaced: 0.5, holdLoss: 2, endAvg: 10, gross: 3, endTime: 10 };

  const c1Metrics = (c) => ({
    filledPct: 100 * c.filled / Math.max(1, c.roles), top10: c.ranks.r1 + c.ranks.top10, below50: c.ranks.rest, wasted: c.wasted, gross: c.grossOffers,
    lostHolds: c.lostHolds, endTime: c.endTime, interviews: c.interviews, idle: c.idleHours, buffer: c.bufferOpenings, peakRooms: c.peakRooms,
    rejected: c.rejected, holdLoss: c.holdLoss, dreamLoss: c.dreamLoss, totalLoss: c.totalLoss, util: c.util, idleMinPerRole: c.idleMinPerRole,
  });
  const clusterMetrics = (c) => Object.assign(c1Metrics(c), { offersMade: c.offersMade, dreamConv: c.dreamConversions, extensions: c.extensions, pool: c.pool, poolNoOffer: c.poolNoOffer, poolDreamers: c.poolDreamers });
  // adds the per-cluster (c1_ ...) and GD-day (g2_ ...) measures of a finished or partly run simulation to an object
  PS.roundMetrics = function (sim, into) {
    for (const k of [1, 2, 3]) { const c = sim.metrics.clusters[k]; if (!c) continue; const m = clusterMetrics(c); for (const key in m) into['c' + k + '_' + key] = m[key]; }
    const which = sim.planMode === 'baseline' && sim.matchMode === 'baseline' ? 'baseline' : 'optimised';
    for (const k of [2, 3]) { const d = sim.gdDays && sim.gdDays[k] && sim.gdDays[k][which]; if (!d) continue;
      Object.assign(into, { ['g' + k + '_end']: d.end, ['g' + k + '_clashWait']: d.clashWait, ['g' + k + '_lateActual']: d.lateActual, ['g' + k + '_lateGroups']: d.lateGroups, ['g' + k + '_panelIdle']: Math.round(d.panelIdle), ['g' + k + '_util']: d.util, ['g' + k + '_nGroups']: d.nGroups }); }
    return into;
  };

  // one run. opts: { scope: 'season' | 'c1', checks: bool, truncation: bool, handovers: bool }
  PS.runOne = function (params, roles, armId, opts) {
    opts = opts || {};
    const t0 = now(); const sim = new PS.Sim(params, roles, armId);
    // planMs: the arm's own pre-day plan; decisionsMs: the decision summaries, which plan every mode for display;
    // matchMs: live matching; gdMs: both GD timetables. Only outermost calls are timed, so nothing is counted twice.
    const tm = { plan: 0, decisions: 0, match: 0, gd: 0 }; let inDec = false;
    const time = (name, key) => { const prev = sim[name]; sim[name] = function (...a) {
      if (name === 'plan' && inDec) return prev.apply(this, a);
      if (name === 'makeDecisions') inDec = true;
      const s = now(); try { return prev.apply(this, a); } finally { tm[key] += now() - s; if (name === 'makeDecisions') inDec = false; } }; };
    let R = null;
    if (opts.checks || opts.truncation || opts.handovers) R = PS.attachChecks(sim, { invariants: !!opts.checks, truncation: !!opts.truncation, handovers: !!opts.handovers });
    time('makeDecisions', 'decisions'); time('plan', 'plan'); time('assign', 'match'); time('runGd', 'gd');
    if (opts.scope === 'c1') { sim.advance(); while (!sim.dayOver) sim.step(); }
    else sim.runToEnd();
    const total = now() - t0;
    const metrics = PS.roundMetrics(sim, opts.scope === 'c1' ? c1Metrics(sim.metrics.clusters[1]) : PS.summarize(sim));
    const out = { seed: params.seed, arm: armId, rngMode: +params.rngMode || 0, metrics, runtime: { totalMs: total, planMs: tm.plan, decisionsMs: tm.decisions, matchMs: tm.match, gdMs: tm.gd } };
    if (R) {
      out.violations = R.counts; out.exceptions = R.excCounts; out.violationSamples = R.violations.slice(0, 5); out.exceptionSamples = R.exceptions.slice(0, 3);
      if (R.truncation) out.truncation = R.truncation;
      if (R.handovers) { const h = R.handovers.summary(); out.handovers = h; }
    }
    return out;
  };

  // analysis of runs = [{seed, arm, rngMode, metrics, runtime}]
  PS.analyse = function (runs, cfg) {
    const S = PS.stats, metrics = cfg.metrics, ref = cfg.ref || 'baseline';
    const rngs = [...new Set(runs.map(r => r.rngMode))].sort();
    const out = { config: cfg, rng: {} };
    for (const rg of rngs) {
      const R = runs.filter(r => r.rngMode === rg); const arms = [...new Set(R.map(r => r.arm))];
      const by = {}; for (const r of R) { by[r.arm] = by[r.arm] || {}; by[r.arm][r.seed] = r; }
      const seeds = [...new Set(R.map(r => r.seed))].filter(sd => arms.every(a => by[a][sd])).sort((a, b) => a - b);
      const res = { seeds: seeds.length, seedRange: [seeds[0], seeds[seeds.length - 1]], cells: {}, diffs: {}, effects: null, runtime: {} };
      for (const a of arms) {
        res.cells[a] = {}; for (const [m] of metrics) res.cells[a][m] = S.describe(seeds.map(sd => by[a][sd].metrics[m]));
        const rt = (k) => S.describe(seeds.map(sd => by[a][sd].runtime[k]));
        res.runtime[a] = { totalMs: rt('totalMs'), planMs: rt('planMs'), decisionsMs: rt('decisionsMs'), matchMs: rt('matchMs'), gdMs: rt('gdMs') };
      }
      for (const a of arms) if (a !== ref) {
        const d = {}; const ps = [];
        for (const [m] of metrics) { d[m] = S.describe(seeds.map(sd => by[a][sd].metrics[m] - by[ref][sd].metrics[m])); ps.push(d[m].p); }
        const prim = metrics.map((x, i) => [x, i]).filter(([x]) => x[2]); const adj = S.holm(prim.map(([, i]) => ps[i]));
        prim.forEach(([x], j) => { d[x[0]].pHolm = adj[j]; });
        res.diffs[a + ' − ' + ref] = d;
      }
      const need = ['baseline', 'oplan-bmatch', 'bplan-omatch', 'optimised'];
      if (need.every(a => by[a])) {
        const eff = { planning: {}, matching: {}, interaction: {} }; const per = { planning: {}, matching: {}, interaction: {} };
        for (const [m] of metrics) {
          const v = (a, sd) => by[a][sd].metrics[m];
          per.planning[m] = seeds.map(sd => 0.5 * ((v('oplan-bmatch', sd) - v('baseline', sd)) + (v('optimised', sd) - v('bplan-omatch', sd))));
          per.matching[m] = seeds.map(sd => 0.5 * ((v('bplan-omatch', sd) - v('baseline', sd)) + (v('optimised', sd) - v('oplan-bmatch', sd))));
          per.interaction[m] = seeds.map(sd => (v('optimised', sd) - v('oplan-bmatch', sd)) - (v('bplan-omatch', sd) - v('baseline', sd)));
          for (const e of ['planning', 'matching', 'interaction']) eff[e][m] = S.describe(per[e][m]);
        }
        for (const e of ['planning', 'matching', 'interaction']) { const prim = metrics.filter(x => x[2]); const adj = S.holm(prim.map(([m]) => eff[e][m].p)); prim.forEach(([m], j) => { eff[e][m].pHolm = adj[j]; }); }
        res.effects = eff;
        // seeds needed for the target precision on each effect
        res.seedsNeeded = {}; for (const e of ['planning', 'matching', 'interaction']) { res.seedsNeeded[e] = {}; for (const [m] of metrics) if (PS.PRECISION[m] != null) res.seedsNeeded[e][m] = S.seedsNeeded(eff[e][m].sd, PS.PRECISION[m]); }
      }
      out.rng[rg] = res;
    }
    // variance-reduction ratio: Var(paired difference, event-keyed) / Var(paired difference, legacy stream), same seeds
    if (rngs.includes(0) && rngs.includes(1)) {
      const vr = {}; const a = out.rng[0], b = out.rng[1];
      for (const k of Object.keys(b.diffs)) { vr[k] = {}; for (const [m] of metrics) { const s0 = a.diffs[k] && a.diffs[k][m].sd, s1 = b.diffs[k][m].sd; vr[k][m] = s0 > 0 ? (s1 * s1) / (s0 * s0) : null; } }
      if (a.effects && b.effects) for (const e of ['planning', 'matching', 'interaction']) { vr['effect: ' + e] = {}; for (const [m] of metrics) { const s0 = a.effects[e][m].sd, s1 = b.effects[e][m].sd; vr['effect: ' + e][m] = s0 > 0 ? (s1 * s1) / (s0 * s0) : null; } }
      out.varianceRatio = vr;
    }
    return out;
  };
})(window.PS);
