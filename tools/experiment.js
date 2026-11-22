#!/usr/bin/env node
/* Command-line experiment runner.
   Examples:
     node tools/experiment.js --arms 2x2 --seeds 2001-2030 --rng both --out out/pilot
     node tools/experiment.js --arms 2x2 --seeds 1001-1060 --rng crn --scope c1 --out out/c1
     node tools/experiment.js --arms 2x2 --seeds 1001-1060 --rng crn --checks --diag --out out/checks
   Options:
     --settings FILE   settings JSON (default: base-settings.json next to this folder)
     --arms LIST       '2x2' or a comma list of modes: baseline, optimised, manual, bplan-omatch, oplan-bmatch
     --seeds A-B       seed range (or a comma list); keep training (2001+) and test (1001+) seeds apart
     --rng MODE        crn | legacy | both (both runs every seed twice and reports variance-reduction ratios)
     --scope S         season (default) | c1 (cluster 1 only: every arm starts from an identical pool)
     --ref ARM         reference arm for paired differences (default baseline)
     --checks          invariant checks;  --diag  top-eight truncation and handover diagnostics
     --out DIR         output folder (runs.csv, runs.json, summary.json, summary.md) */
'use strict';
const fs = require('fs'), path = require('path');
global.window = global; global.performance = global.performance || require('perf_hooks').performance;
const root = path.join(__dirname, '..');
for (const f of ['data.js', 'engine.js', 'checks.js', 'stats.js', 'experiment.js']) require(path.join(root, 'js', f));
const PS = global.PS;

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k] = v; }
const settings = JSON.parse(fs.readFileSync(opt.settings || path.join(root, 'base-settings.json'), 'utf8'));
const params = Object.assign({}, PS.DEFAULT_PARAMS, settings.params || {});
const roles = PS.buildRoles(settings.overrides || {}, Object.assign({}, PS.COHORT_CLUSTER, settings.cohortMap || {}));
const arms = (opt.arms || '2x2') === '2x2' ? PS.ARMS_2X2.map(a => a.id) : String(opt.arms).split(',');
const parseSeeds = (s) => String(s).split(',').flatMap(p => { const m = p.match(/^(\d+)-(\d+)$/); if (!m) return [+p]; const out = []; for (let x = +m[1]; x <= +m[2]; x++) out.push(x); return out; });
const seeds = parseSeeds(opt.seeds || '2001-2030');
const rngs = opt.rng === 'both' ? [0, 1] : opt.rng === 'legacy' ? [0] : [1];
const scope = opt.scope === 'c1' ? 'c1' : 'season';
const out = opt.out || path.join(process.cwd(), 'experiment-out'); fs.mkdirSync(out, { recursive: true });
const metrics = scope === 'c1' ? PS.METRICS_C1 : PS.METRICS_SEASON;

const runs = []; const t0 = Date.now(); let n = 0; const total = seeds.length * arms.length * rngs.length;
for (const rg of rngs) for (const seed of seeds) for (const arm of arms) {
  const r = PS.runOne(Object.assign({}, params, { seed, rngMode: rg }), roles, arm, { scope, checks: !!opt.checks, truncation: !!opt.diag, handovers: !!opt.diag });
  runs.push(r); n++;
  if (n % 10 === 0 || n === total) process.stderr.write(`\r${n}/${total} runs, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
process.stderr.write('\n');
const res = PS.analyse(runs, { metrics, ref: opt.ref || 'baseline', arms, seeds: [seeds[0], seeds[seeds.length - 1]], scope, settings: opt.settings || 'base-settings.json' });
// checks and diagnostics, aggregated
if (opt.checks || opt.diag) {
  const agg = { runs: runs.length, violations: {}, exceptions: {}, violationSamples: [], truncation: null, handovers: null };
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.violations || {})) agg.violations[k] = (agg.violations[k] || 0) + v;
    for (const [k, v] of Object.entries(r.exceptions || {})) agg.exceptions[k] = (agg.exceptions[k] || 0) + v;
    if (r.violationSamples && agg.violationSamples.length < 12) agg.violationSamples.push(...r.violationSamples.slice(0, 2));
  }
  const tr = runs.filter(r => r.truncation);
  if (tr.length) { const s = (k) => tr.reduce((a, r) => a + r.truncation[k], 0); agg.truncation = { runs: tr.length, matchingCalls: s('calls'), callsWhereAssignmentDiffers: s('differ'), callsWhereFullMatchesMorePanels: s('fullMatchedMore'), extraPanelsMatched: s('extraMatched'), totalScoreGap: s('scoreGap'), replicaMismatches: s('replicaMismatch'), maxFreePanels: Math.max(...tr.map(r => r.truncation.maxRows)), maxCandidates: Math.max(...tr.map(r => r.truncation.maxCols)), msK8: s('msK8'), msFull: s('msFull') }; }
  const ho = runs.filter(r => r.handovers);
  if (ho.length) {
    const h = { runs: ho.length, total: 0, byOutcome: {}, delayed: { n: 0, sumDelay: 0, max: 0, over60: 0 }, delayedOrFailed: 0, bufferWasFree: 0, dueRoomState: {} };
    for (const r of ho) { const x = r.handovers; h.total += x.total; for (const [k, v] of Object.entries(x.byOutcome)) h.byOutcome[k] = (h.byOutcome[k] || 0) + v;
      if (x.delay.n) { h.delayed.n += x.delay.n; h.delayed.sumDelay += x.delay.mean * x.delay.n; h.delayed.max = Math.max(h.delayed.max, x.delay.max); h.delayed.over60 += x.delay.over60; }
      h.delayedOrFailed += x.bufferFreeAtDue.delayedOrFailed; h.bufferWasFree += x.bufferFreeAtDue.bufferWasFree; for (const [k, v] of Object.entries(x.dueRoomState)) h.dueRoomState[k] = (h.dueRoomState[k] || 0) + v; }
    h.delayed.mean = h.delayed.n ? h.delayed.sumDelay / h.delayed.n : 0; delete h.delayed.sumDelay; agg.handovers = h;
  }
  res.checks = agg;
}
res.wallSeconds = (Date.now() - t0) / 1000;
fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify(runs));
const cols = metrics.map(m => m[0]);
fs.writeFileSync(path.join(out, 'runs.csv'), ['rng,seed,arm,' + cols.join(',') + ',totalMs,planMs,decisionsMs,matchMs,gdMs'].concat(runs.map(r => [r.rngMode ? 'crn' : 'legacy', r.seed, r.arm, ...cols.map(c => r.metrics[c]), r.runtime.totalMs.toFixed(1), r.runtime.planMs.toFixed(1), r.runtime.decisionsMs.toFixed(1), r.runtime.matchMs.toFixed(1), r.runtime.gdMs.toFixed(1)].join(','))).join('\n'));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(res, null, 1));
// readable summary
const f = (x, d = 2) => (x == null || !isFinite(x)) ? '–' : x.toFixed(d);
const L = [`# Experiment ${path.basename(out)}`, `Scope: ${scope}; arms: ${arms.join(', ')}; seeds ${seeds[0]}–${seeds[seeds.length - 1]} (${seeds.length}); random numbers: ${rngs.map(x => x ? 'event-keyed (CRN)' : 'legacy stream').join(' and ')}; wall time ${res.wallSeconds.toFixed(0)} s`, ''];
for (const rg of rngs) {
  const R = res.rng[rg]; L.push(`## ${rg ? 'Event-keyed (CRN)' : 'Legacy stream'}`, '', '| Metric | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---|').join(''));
  for (const [m, lab] of metrics) L.push(`| ${lab} | ` + arms.map(a => `${f(R.cells[a][m].mean)} ± ${f(R.cells[a][m].halfWidth)}`).join(' | ') + ' |');
  if (R.effects) { L.push('', '| Effect (paired, 95% CI) | Planning | Matching | Interaction |', '|---|---|---|---|');
    for (const [m, lab] of metrics) L.push(`| ${lab} | ` + ['planning', 'matching', 'interaction'].map(e => { const x = R.effects[e][m]; return `${f(x.mean)} [${f(x.lo)}, ${f(x.hi)}] d=${f(x.dz)}`; }).join(' | ') + ' |'); }
  L.push('', '| Runtime per run (ms) | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---|').join(''));
  for (const k of ['totalMs', 'planMs', 'decisionsMs', 'matchMs', 'gdMs']) L.push(`| ${k} | ` + arms.map(a => f(R.runtime[a][k].mean, 0)).join(' | ') + ' |');
  L.push('');
}
if (res.varianceRatio) { L.push('## Variance-reduction ratio Var(CRN diff) / Var(legacy diff)', '', '| Contrast | ' + metrics.filter(m => m[2]).map(m => m[0]).join(' | ') + ' |', '|---|' + metrics.filter(m => m[2]).map(() => '---|').join(''));
  for (const [k, v] of Object.entries(res.varianceRatio)) L.push(`| ${k} | ` + metrics.filter(m => m[2]).map(m => f(v[m[0]])).join(' | ') + ' |'); L.push(''); }
if (res.checks) L.push('## Checks', '', '```', JSON.stringify(res.checks, null, 1), '```');
fs.writeFileSync(path.join(out, 'summary.md'), L.join('\n'));
console.log('wrote', out, `(${res.wallSeconds.toFixed(0)} s)`);
