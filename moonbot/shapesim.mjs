// Liquidity-shape test on DLMM constant-sum bins: Spot (uniform), Bid-Ask (weight grows with distance from active = our live strategy), Curve (peaked at active).
// Same 5m data / fee proxy / friction / idle-rebalance as rangesim. Fee per candle = C * vol * sum(d_i over touched bins)/Ntot/width, d_i = bin liquidity / mean bin liquidity.
// Usage: YMIN=2 IDLE=30 STEP=50 NBINS=12 node moonbot/shapesim.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m/', import.meta.url).pathname;
const F = 0.011, MINVOL = 100000, YMIN = +(process.env.YMIN ?? 2), M = +(process.env.IDLE ?? 30), HORIZON = 288, STEPW = 36, K = 0.761;
const NB = +(process.env.NBINS ?? 12), SP = (+(process.env.STEP ?? 50)) / 10000; // bin step as fraction
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const SHAPES = { spot: () => 1, bidask: (d) => d + 1, curve: (d) => NB + 1 - d }; // d = |bin offset|, 1..NB
function open(p0, V, shape) {
  const w = (i) => SHAPES[shape](Math.max(1, Math.abs(i)));
  const bins = []; // {id, P, L (value in SOL units at the bin's own price), d}
  let wb = 0, wa = 0; for (let i = -NB; i <= -1; i++) wb += w(i); for (let i = 1; i <= NB; i++) wa += w(i);
  for (let i = -NB; i <= NB; i++) {
    if (i === 0) continue;
    const P = p0 * Math.pow(1 + SP, i);
    const sideValue = V / 2; // half of value on each side at deposit
    const L = i < 0 ? sideValue * w(i) / wb : (sideValue * w(i) / wa) * (P / p0); // token side: tokens = value/p0 per share; constant-sum L = tokens*P
    bins.push({ id: i, P, L, x: i < 0 ? 0 : L / P });
  }
  const meanL = mean(bins.map((b) => b.L)); bins.forEach((b) => { b.d = b.L / meanL; });
  return { bins, p0 };
}
function value(pos, p) { // bins below price hold SOL (L), above hold tokens (x*p); the bin containing p is half/half
  let v = 0, tok = 0;
  for (const b of pos.bins) {
    const lo = b.P, hi = b.P * (1 + SP);
    if (p >= hi) { v += b.L; } else if (p < lo) { v += b.L / b.P * p; tok += b.L / b.P * p; } else { const f = (p - lo) / (hi - lo); v += b.L * f + (b.L / b.P) * p * (1 - f); tok += (b.L / b.P) * p * (1 - f); }
  }
  return { v, tokVal: tok };
}
function run(c, i0, shape, Cp) {
  let pos = open(c[i0][4], 1, shape), fees = 0, idle = 0, reb = 0, cost = 0.5 * F;
  const lowB = () => pos.bins[0].P, highB = () => pos.bins[pos.bins.length - 1].P * (1 + SP);
  for (let t = i0 + 1; t <= Math.min(c.length - 1, i0 + HORIZON); t++) {
    const [, , h, l, cl, v] = c[t];
    let dsum = 0, k = 0; for (const b of pos.bins) { if (b.P * (1 + SP) >= l && b.P <= h) { dsum += b.d; k++; } }
    const lo = Math.max(l, lowB()), hi = Math.min(h, highB()), inFrac = h > l ? Math.max(0, hi - lo) / (h - l) : (l >= lowB() && l <= highB() ? 1 : 0);
    fees += k ? Cp * v * inFrac * (dsum / k) / (2 * NB * SP) : 0; // share of volume traded inside our bins x our density there vs a uniform position
    const out = cl < lowB() || cl > highB(); idle = out ? idle + 5 : 0;
    if (idle >= M) { const cur = value(pos, cl); const w = cur.tokVal / cur.v; const sw = Math.abs(w - 0.5) * cur.v * F; pos = open(cl, cur.v - sw, shape); idle = 0; reb++; }
  }
  const end = c[Math.min(c.length - 1, i0 + HORIZON)][4], cur = value(pos, end);
  return { net: cur.v - cur.tokVal * F + fees - 1 - cost, fees, reb };
}
const W = [];
for (const p of pools) { const c = p.c; for (let i = 288; i < c.length - HORIZON - 1; i += STEPW) {
  const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0); if (tv < MINVOL) continue;
  if (tv * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000) * 100 < YMIN) continue;
  if (Math.abs(c[i][4] / c[i - 12][4] - 1) > 0.15 || Math.abs(c[i][4] / c[i - 72][4] - 1) > 0.15) continue; W.push({ p, i }); } }
const Cof = (p) => K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
console.log(`bins +-${NB} step ${SP * 100}% (range +-${(NB * SP * 100).toFixed(1)}%), idle ${M}m, yield>=${YMIN}%/d: windows ${W.length}, tokens ${new Set(W.map((w) => w.p.address)).size}\n`);
for (const shape of Object.keys(SHAPES)) {
  const rs = W.map((w) => run(w.p.c, w.i, shape, Cof(w.p)));
  console.log(`${shape.padEnd(7)} mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} fees ${pct(mean(rs.map((r) => r.fees)), 1).padStart(5)} rebalances/24h ${mean(rs.map((r) => r.reb)).toFixed(1)} win ${pct(rs.filter((r) => r.net > 0).length / rs.length, 0)}`);
}
