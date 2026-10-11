// Skewed-allocation test: s = share of capital VALUE on the token (ask) side; 1-s on the SOL (bid) side. s=0.5 ~ our centered position.
// Same 5m data, fee proxy (K calibrated like rangesim) and friction model. Usage: YMIN=2 node moonbot/skewsim.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m/', import.meta.url).pathname;
const F = 0.011, MINVOL = +(process.env.MINVOL ?? 100000), YMIN = +(process.env.YMIN ?? 2), HORIZON = 288, STEP = 36, R = +(process.env.R ?? 0.06), M = +(process.env.IDLE ?? 30), K = +(process.env.K ?? 0.761);
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const ov = (l, h, a, b) => (h <= l ? (l >= a && l <= b ? 1 : 0) : Math.max(0, Math.min(h, b) - Math.max(l, a)) / (h - l));
// position = bid part (SOL) on [pa,p0] + ask part (token) on [p0,pb]; value in SOL at price p
function mk(p0, V, s) {
  const pa = p0 * (1 - R), pb = p0 * (1 + R), sa = Math.sqrt(pa), s0 = Math.sqrt(p0), sb = Math.sqrt(pb);
  const Lb = (1 - s) * V / (s0 - sa), La = s * V / (p0 * (1 / s0 - 1 / sb)); // SOL part: y=Lb(s0-sa); token part: x=La(1/s0-1/sb) tokens worth s*V at p0
  return { pa, pb, p0, Lb, La, s };
}
function val(pos, p) {
  const { pa, pb, p0, Lb, La } = pos, P = Math.min(Math.max(p, pa), p0), Q = Math.min(Math.max(p, p0), pb);
  const sol = Lb * (Math.sqrt(P) - Math.sqrt(pa)); // bid part: SOL left (below p0 range)
  const tokB = Lb * (1 / Math.sqrt(P) - 1 / Math.sqrt(p0)); // tokens bought by bid part
  const tokA = La * (1 / Math.sqrt(Q) - 1 / Math.sqrt(pb)); // tokens left in ask part
  const solA = La * (Math.sqrt(Q) - Math.sqrt(p0)); // SOL received by the ask part as price rises through it
  return { v: sol + solA + (tokB + tokA) * p, tokVal: (tokB + tokA) * p };
}
function run(c, i0, s, Cp) {
  let V = 1, fees = 0, reb = 0, idle = 0, pos = mk(c[i0][4], 1, s), cost = s * F; // entry swap for token share
  for (let t = i0 + 1; t <= Math.min(c.length - 1, i0 + HORIZON); t++) {
    const [, , h, l, cl, v] = c[t];
    fees += Cp * v * (ov(l, h, pos.pa, pos.p0) * (1 - pos.s) + ov(l, h, pos.p0, pos.pb) * pos.s) / R;
    const out = cl < pos.pa || cl > pos.pb; idle = out ? idle + 5 : 0;
    if (idle >= M) { const cur = val(pos, cl); const wT = cur.tokVal / cur.v; const sw = Math.abs(wT - s) * cur.v * F; V = cur.v - sw; pos = mk(cl, V, s); idle = 0; reb++; }
  }
  const end = c[Math.min(c.length - 1, i0 + HORIZON)][4], cur = val(pos, end);
  return { net: cur.v - cur.tokVal * F + fees - 1 - s * F, reb, fees, up: end / c[i0][4] - 1 };
}
const W = [];
for (const p of pools) { const c = p.c; for (let i = 288; i < c.length - HORIZON - 1; i += STEP) {
  const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0); if (tv < MINVOL) continue;
  if (tv * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000) * 100 < YMIN) continue;
  if (Math.abs(c[i][4] / c[i - 12][4] - 1) > 0.15 || Math.abs(c[i][4] / c[i - 72][4] - 1) > 0.15) continue; W.push({ p, i }); } }
console.log(`R=${R * 100}% idle=${M}m yield>=${YMIN}%/d windows ${W.length} tokens ${new Set(W.map((w) => w.p.address)).size}; price drift over window: mean ${pct(mean(W.map((w) => w.p.c[w.i + HORIZON]?.[4] / w.p.c[w.i][4] - 1 || 0)))}\n`);
const Cof = (p) => K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
for (const s of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
  const rs = W.map((w) => ({ ...run(w.p.c, w.i, s, Cof(w.p)) }));
  const dn = rs.filter((r) => r.up < -0.05), upw = rs.filter((r) => r.up > 0.05), flat = rs.filter((r) => Math.abs(r.up) <= 0.05);
  console.log(`token share ${String(s * 100).padStart(3)}%  mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} fees ${pct(mean(rs.map((r) => r.fees)), 1).padStart(5)} | when price fell>5% (n=${dn.length}) ${pct(mean(dn.map((r) => r.net)), 1)} | rose>5% (n=${upw.length}) ${pct(mean(upw.map((r) => r.net)), 1)} | flat (n=${flat.length}) ${pct(mean(flat.map((r) => r.net)), 1)}`);
}
