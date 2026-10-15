// New-pool launch study: buy k hours after the pool's first candle, hold H hours (no stop) or with trail/stop, 1.1%/leg friction.
import { loadPools, staleMult } from './lib.mjs';
const FRIC = 0.011, GAP = 0.02;
const MINV = +(process.env.MINV ?? 0);
const PREV = +(process.env.PREV ?? 0); // look-ahead-free liquidity filter: volume of the hours BEFORE entry
const allPools = loadPools(30).filter((p) => p.launchedInWindow && p.c.slice(0, 24).reduce((s, x) => s + x[5], 0) >= MINV);
const all = allPools; let all_k = all;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x) => (x * 100).toFixed(1) + '%';
function sim(c, j, trail, maxH, stop) {
  const entry = c[j][1] * (1 + FRIC); let peak = c[j][1], exit = null;
  for (let t = j; t < Math.min(c.length, j + maxH); t++) {
    const sp = Math.max(peak * (1 - trail), c[j][1] * (1 - stop));
    if (c[t][3] <= sp && c[t][5] > 0) { exit = Math.min(c[t][1], sp) * (1 - GAP); break; }
    peak = Math.max(peak, c[t][2]);
    if (t === Math.min(c.length, j + maxH) - 1) exit = c[t][4] * staleMult(c, t);
  }
  return exit === null ? null : exit * (1 - FRIC) / entry - 1;
}
console.log('launched pools in window:', all.length, 'median first-24h volume $', Math.round(q(all.map((p) => p.c.slice(0, 24).reduce((s, x) => s + x[5], 0)), .5)));
for (const k of [1, 3, 6, 12]) for (const [trail, stop, H] of [[0.25, 0.2, 24], [0.4, 0.3, 72]]) {
  const ok = all.filter((p) => p.c.slice(0, k + 1).reduce((s, x) => s + x[5], 0) >= PREV);
  const rets = ok.filter((p) => p.c.length > k + H).map((p) => sim(p.c, k, trail, H, stop)).filter((x) => x !== null);
  const holdOnly = ok.filter((p) => p.c.length > k + 24).map((p) => p.c[k + 24][4] / p.c[k][1] * (1 - FRIC) / (1 + FRIC) - 1);
  console.log(`pool n=${ok.length} buy @h${String(k).padEnd(2)} trail${trail * 100}/stop${stop * 100}/${H}h n=${rets.length} mean ${pct(mean(rets))} med ${pct(q(rets, .5))} win ${pct(rets.filter((x) => x > 0).length / rets.length)} p90 ${pct(q(rets, .9))} | hold24 no-stop mean ${pct(mean(holdOnly))} med ${pct(q(holdOnly, .5))}`);
}
const peaks = all.map((p) => Math.max(...p.c.slice(1, 49).map((x) => x[2])) / p.c[1][1] - 1);
console.log('max run-up within 48h after h1: median', pct(q(peaks, .5)), 'p90', pct(q(peaks, .9)), '>=+100%:', pct(peaks.filter((x) => x >= 1).length / peaks.length));
const fin = all.filter((p) => p.c.length > 72).map((p) => p.c[72][4] / p.c[1][1] - 1);
console.log('price at h72 vs h1: median', pct(q(fin, .5)), 'mean', pct(mean(fin)), '<=-50%:', pct(fin.filter((x) => x <= -0.5).length / fin.length));
