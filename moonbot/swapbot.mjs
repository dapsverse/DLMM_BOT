// "Swap bot" test: pick high-volume sell-dominant tokens, open SOL-only bid range [p0(1-W), p0] (earns fees while it fills, no swap),
// when fully filled (low <= pa) flip to a token-only ask range [pa, p0(1+R)], done when high >= top. Forced market exit after TA/TB candles.
// Usage: DATA=data5m2 W=0.2 R=0.1 RV=0.6 R1H=-0.05 MINV=30000 TA=288 TB=288 node moonbot/swapbot.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL(`./${process.env.DATA ?? 'data5m2'}/`, import.meta.url).pathname;
const E = process.env, F = 0.011, K = +(process.env.K ?? 0.761), COST = 0.002;
const W = +(E.W ?? 0.2), R = +(E.R ?? 0.1), RV = +(E.RV ?? 0.6), R1H = +(E.R1H ?? -0.05), MINV = +(E.MINV ?? 30000), TA = +(E.TA ?? 288), TB = +(E.TB ?? 288), ANY = E.ANY === '1';
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const overlap = (l, h, pa, pb) => (h <= l ? (l >= pa && l <= pb ? 1 : 0) : Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l));
function run(c, i0, Cp) {
  const p0 = c[i0][4], pa = p0 * (1 - W); let fees = 0, t = i0 + 1;
  // phase A: SOL-only [pa,p0], L from 1 SOL
  const L1 = 1 / (Math.sqrt(p0) - Math.sqrt(pa)); let filled = -1;
  for (; t <= Math.min(c.length - 1, i0 + TA); t++) {
    fees += Cp * c[t][5] * overlap(c[t][3], c[t][2], pa, p0) / W;
    if (c[t][3] <= pa) { filled = t; break; }
  }
  const tokenAt = (L, p, a, b) => { const P = Math.min(Math.max(p, a), b); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(b)), y: L * (Math.sqrt(P) - Math.sqrt(a)) }; };
  if (filled < 0) { // never fully filled: close, liquidate residual token
    const pe = c[Math.min(c.length - 1, i0 + TA)][4], a = tokenAt(L1, pe, pa, p0);
    return { net: a.y + a.x * pe * (1 - F) + fees - 1 - COST, fees, filled: false, done: false, hrs: TA / 12 };
  }
  const X = L1 * (1 / Math.sqrt(pa) - 1 / Math.sqrt(p0)), pb2 = p0 * (1 + R), w2 = (pb2 - pa) / pa;
  const L2 = X / (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb2)); let done = false, end = Math.min(c.length - 1, filled + TB);
  for (t = filled + 1; t <= end; t++) { fees += Cp * c[t][5] * overlap(c[t][3], c[t][2], pa, pb2) / w2; if (c[t][2] >= pb2) { done = true; end = t; break; } }
  const pe = c[end][4], a = tokenAt(L2, done ? pb2 : pe, pa, pb2);
  return { net: a.y + a.x * pe * (1 - F) + fees - 1 - 2 * COST, fees, filled: true, done, hrs: (end - i0) / 12 };
}
const rs = [], byTok = new Map();
for (const p of pools) {
  const c = p.c, Cp = K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000); let next = 24;
  for (let i = 24; i < c.length - 2; i++) {
    if (i < next) continue;
    const win = c.slice(i - 11, i + 1), v1h = win.reduce((s, x) => s + x[5], 0); if (v1h < MINV) continue;
    const rv = win.filter((x) => x[4] < x[1]).reduce((s, x) => s + x[5], 0) / v1h, r1h = c[i][4] / c[i - 12][4] - 1;
    if (!ANY && !(rv >= RV && r1h <= R1H)) continue;
    const r = run(c, i, Cp); rs.push(r); (byTok.get(p.address) ?? byTok.set(p.address, []).get(p.address)).push(r.net); next = i + 36;
  }
}
const toks = [...byTok.values()], bs = [];
for (let b = 0; b < 500; b++) { let s = 0, n = 0; for (let k = 0; k < toks.length; k++) { const t = toks[Math.floor(Math.random() * toks.length)]; s += t.reduce((a, x) => a + x, 0); n += t.length; } bs.push(s / n); }
const f = rs.filter((r) => r.filled), d = rs.filter((r) => r.done);
console.log(`${ANY ? 'ANY-TIME' : `sell-dom rv>=${RV} r1h<=${R1H * 100}%`} W=${W * 100}% R=${R * 100}% n=${rs.length} tok=${toks.length} | fill ${pct(f.length / rs.length, 0)} complete ${pct(d.length / rs.length, 0)} | net mean ${pct(mean(rs.map((r) => r.net)), 2)} med ${pct(q(rs.map((r) => r.net), .5), 2)} p10 ${pct(q(rs.map((r) => r.net), .1))} win ${pct(rs.filter((r) => r.net > 0).length / rs.length, 0)} CI95 [${pct(q(bs, .025))},${pct(q(bs, .975))}] | fees ${pct(mean(rs.map((r) => r.fees)), 2)} | filled-not-done mean ${pct(mean(f.filter((r) => !r.done).map((r) => r.net)))} done mean ${pct(mean(d.map((r) => r.net)), 2)} | avg ${mean(rs.map((r) => r.hrs)).toFixed(1)}h`);
