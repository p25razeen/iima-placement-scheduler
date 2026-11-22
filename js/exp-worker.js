/* Background worker for the 2x2 experiment: runs whole placements without animation and posts each run back. */
self.window = self;
importScripts('data.js', 'engine.js', 'stats.js', 'experiment.js');
let stop = false;
self.onmessage = function (e) {
  if (e.data.type === 'stop') { stop = true; return; }
  const { params, overrides, cohortMap, seeds, arms, scope, rngMode } = e.data; stop = false;
  const PS = self.PS; const roles = PS.buildRoles(overrides, cohortMap);
  const total = seeds.length * arms.length; let done = 0;
  for (const seed of seeds) {
    for (const arm of arms) {
      if (stop) { self.postMessage({ type: 'stopped', done }); return; }
      const r = PS.runOne(Object.assign({}, params, { seed, rngMode }), roles, arm, { scope });
      done++; self.postMessage({ type: 'run', run: r, done, total });
    }
  }
  self.postMessage({ type: 'done', done });
};
