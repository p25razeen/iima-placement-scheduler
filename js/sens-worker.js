/* Background worker for the sensitivity sweep: runs whole placements without animation. */
self.window = self;
importScripts('data.js', 'engine.js');
self.onmessage = function (e) {
  const { params, overrides, cohortMap, key, values, runs, modes } = e.data;
  const PS = self.PS; const roles = PS.buildRoles(overrides, cohortMap);
  const total = values.length * runs * modes.length; let done = 0;
  const out = values.map(() => ({}));
  values.forEach((v, i) => {
    for (const m of modes) {
      const acc = {};
      for (let r = 0; r < runs; r++) {
        const P = Object.assign({}, params, { [key]: v, seed: params.seed + r });
        const sim = new PS.Sim(P, roles, m); sim.runToEnd();
        const s = PS.summarize(sim);
        for (const k in s) acc[k] = (acc[k] || 0) + s[k] / runs;
        done++; self.postMessage({ type: 'progress', done, total });
      }
      out[i][m] = acc;
    }
  });
  self.postMessage({ type: 'done', results: out });
};
