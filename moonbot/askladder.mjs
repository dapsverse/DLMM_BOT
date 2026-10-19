// Friday7th-style test: buy token, deposit TOKEN-ONLY in [p0, p0*(1+U)] (ask ladder above price), close when price exits above or after H candles.
// Compares vs just holding the token for the same window. Same 5m data / fee proxy K / friction F as pullbacksim.
// Usage: DATA=data5m2 U=0.5 H=288 PS=0.15 MINV=30000 node moonbot/askladder.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL(`./${process.env.DATA ?? 'data5m2'}/`, import.meta.url).pathname;
const F = 0.011, K = 0.761, U = +(process.env.U ?? 0.5), H = +(process.env.H ?? 288), PS = +(process.env.PS ?? 0.15), MINV = +(process.env.MINV ?? 30000);
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const amounts = (L, p, pa, pb) => { const P = Math.min(Math.max(p, pa), pb); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)), y: L * (Math.sqrt(P) - Math.sqrt(pa)) }; };
const overlap = (l, h, pa, pb) => (h <= l ? (l >= pa && l <= pb ? 1 : 0) : Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l));
function run(c, i0, Cp) {
  const p0 = c[i0][4], pa = p0, pb = p0 * (1 + U), width = U;
  const L = 1 / (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb)) / p0; // token-only, value 1 SOL at p0
  let fees = 0, end = Math.min(c.length - 1, i0 + H);
  for (let t = i0 + 1; t <= end; t++) {
    fees += Cp * c[t][5] * overlap(c[t][3], c[t][2], pa, pb) / width;
    if (c[t][2] >= pb) { end = t; break; }
  }
  const pe = end === i0 ? p0 : c[end][4], a = amounts(L, pe, pa, pb), tokVal = a.x * pe;
  const lp = a.y + tokVal - 1 + fees - F / 2 - tokVal * F / 2; // buy token at entry (F/2), sell residual token at exit
  const hold = pe / p0 - 1 - F;
  return { lp, hold, fees, filled: a.y > 0.99 * (L * (Math.sqrt(pb) - Math.sqrt(pa))) };
}
const all = [], sig = [];
for (const p of pools) {
  const c = p.c, Cp = K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
  let nextA = 12, nextS = 12;
  for (let i = 12; i < c.length - 2; i++) {
    const v1h = c.slice(i - 12, i + 1).reduce((s, x) => s + x[5], 0); if (v1h < MINV) continue;
    if (i >= nextA) { all.push(run(c, i, Cp)); nextA = i + 36; }
    if (i >= nextS && c[i][4] / c[i - 12][4] - 1 >= PS) { sig.push(run(c, i, Cp)); nextS = i + 36; }
  }
}
const stat = (name, rs) => console.log(`${name.padEnd(34)} n ${String(rs.length).padStart(4)}  LP mean ${pct(mean(rs.map((r) => r.lp)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.lp), .5), 2).padStart(7)} win ${pct(rs.filter((r) => r.lp > 0).length / (rs.length || 1), 0).padStart(4)} p10 ${pct(q(rs.map((r) => r.lp), .1)).padStart(6)} | HOLD mean ${pct(mean(rs.map((r) => r.hold)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.hold), .5), 2).padStart(7)} | fees ${pct(mean(rs.map((r) => r.fees)), 2)} filled ${pct(rs.filter((r) => r.filled).length / (rs.length || 1), 0)}`);
console.log(`U=${U * 100}% H=${H * 5}m vol1h>=$${MINV} pools ${pools.length}`);
stat('any time (no prediction)', all);
stat(`after +${PS * 100}% in 1h (momentum)`, sig);
