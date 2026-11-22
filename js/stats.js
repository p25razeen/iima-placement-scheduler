/* Small statistics library for paired experiments: t intervals, paired effect sizes, Holm adjustment, sample size. */
window.PS = window.PS || {};
(function (PS) {
  'use strict';
  // log-gamma (Lanczos) and the regularised incomplete beta function, for the t distribution
  function lgamma(x) {
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  const tcdf = (t, df) => { const x = df / (df + t * t), p = 0.5 * ibeta(x, df / 2, 0.5); return t >= 0 ? 1 - p : p; };
  function tquant(p, df) { // inverse CDF by bisection
    let lo = -50, hi = 50; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tcdf(m, df) < p) lo = m; else hi = m; } return (lo + hi) / 2;
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); };

  // summary of one sample (or of paired differences): mean, sd, se, 95% t interval, two-sided p for mean = 0, d_z = mean / sd
  function describe(a, conf) {
    conf = conf || 0.95; const n = a.length, m = mean(a), s = sd(a), se = n > 1 ? s / Math.sqrt(n) : 0;
    const tc = n > 1 ? tquant(1 - (1 - conf) / 2, n - 1) : NaN;
    const tstat = se > 0 ? m / se : (m === 0 ? 0 : Infinity);
    const p = n > 1 ? (se > 0 ? 2 * (1 - tcdf(Math.abs(tstat), n - 1)) : (m === 0 ? 1 : 0)) : NaN;
    return { n, mean: m, sd: s, se, lo: m - tc * se, hi: m + tc * se, halfWidth: tc * se, p, dz: s > 0 ? m / s : (m === 0 ? 0 : Infinity) };
  }
  // Holm step-down adjustment of a list of p values
  function holm(ps) {
    const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const out = new Array(ps.length); let run = 0;
    idx.forEach(([p, i], r) => { run = Math.max(run, Math.min(1, (ps.length - r) * p)); out[i] = run; }); return out;
  }
  // seeds needed so that the 95% half-width of a paired mean is at most h, given a pilot sd
  function seedsNeeded(sdPilot, h) {
    if (!(sdPilot > 0)) return 2; let n = 2;
    for (; n < 100000; n++) if (tquant(0.975, n - 1) * sdPilot / Math.sqrt(n) <= h) break; return n;
  }
  PS.stats = { mean, sd, describe, holm, seedsNeeded, tcdf, tquant };
})(window.PS);
