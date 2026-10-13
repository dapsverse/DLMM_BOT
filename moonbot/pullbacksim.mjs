// "Pump pullback" LP test (molu/$HIRE style): after a big pump and a pullback, open a SOL-only spot position just below price (no entry swap)
// vs a two-sided spot position, hold H candles, close. Same 5m data / fee proxy (K) / friction as rangesim+shapesim.
// Usage: PUMP=0.3 PB=0.1 W=0.1 H=6 MINV=30000 node moonbot/pullbacksim.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m/', import.meta.url).pathname;
const F = 0.011, K = 0.761, PUMP = +(process.env.PUMP ?? 0.3), PB = +(process.env.PB ?? 0.1), W = +(process.env.W ?? 0.1), H = +(process.env.H ?? 6), MINV = +(process.env.MINV ?? 30000);
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const amounts = (L, p, pa, pb) => { const P = Math.min(Math.max(p, pa), pb); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)), y: L * (Math.sqrt(P) - Math.sqrt(pa)) }; };
const valueOf = (L, p, pa, pb) => { const a = amounts(L, p, pa, pb); return a.x * p + a.y; };
const overlap = (l, h, pa, pb) => (h <= l ? (l >= pa && l <= pb ? 1 : 0) : Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l));
// kind: 'sol' = SOL only in [p(1-W), p]; 'two' = centered [p(1-W), p(1+W)] with half swapped at entry
function run(c, i0, kind, Cp) {
  const p0 = c[i0][4], pa = p0 * (1 - W), pb = kind === 'sol' ? p0 : p0 * (1 + W), width = (pb - pa) / p0;
  const L = 1 / valueOf(1, p0, pa, pb); let fees = 0;
  const end = Math.min(c.length - 1, i0 + H);
  for (let t = i0 + 1; t <= end; t++) fees += Cp * c[t][5] * overlap(c[t][3], c[t][2], pa, pb) / width;
  const pe = c[end][4], cur = valueOf(L, pe, pa, pb), a = amounts(L, pe, pa, pb), tokVal = a.x * pe;
  return { net: cur - tokVal * F + fees - 1 - (kind === 'two' ? 0.5 * F : 0), fees };
}
const sig = [], ctl = [];
for (const p of pools) {
  const c = p.c, Cp = K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
  let next = 24;
  for (let i = 24; i < c.length - H - 1; i++) {
    if (i < next) continue;
    const v1h = c.slice(i - 12, i + 1).reduce((s, x) => s + x[5], 0); if (v1h < MINV) continue;
    const win = c.slice(i - 24, i + 1), peak = Math.max(...c.slice(i - 12, i + 1).map((x) => x[2])), lo = Math.min(...win.map((x) => x[3]));
    const pumped = peak / lo - 1 >= PUMP, pulled = c[i][4] <= peak * (1 - PB) && c[i][4] > lo * 1.02;
    (pumped && pulled ? sig : ctl).push({ p, i, Cp }); if (pumped && pulled) next = i + H + 1;
  }
}
const stat = (name, rs) => console.log(`${name.padEnd(30)} n ${String(rs.length).padStart(4)} mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} fees ${pct(mean(rs.map((r) => r.fees)), 2).padStart(6)} win ${pct(rs.filter((r) => r.net > 0).length / (rs.length || 1), 0)}`);
console.log(`pump>=${PUMP * 100}% in 2h, pullback>=${PB * 100}% from 1h peak, W ${W * 100}%, hold ${H * 5}m, vol1h>=$${MINV}: signals ${sig.length}, tokens ${new Set(sig.map((s) => s.p.address)).size}, controls ${ctl.length}`);
for (const kind of ['sol', 'two']) {
  stat(`${kind === 'sol' ? 'SOL-only' : 'two-sided'} @ pullback`, sig.map((s) => run(s.p.c, s.i, kind, s.Cp)));
  const step = Math.max(1, Math.floor(ctl.length / 600)); stat(`${kind === 'sol' ? 'SOL-only' : 'two-sided'} @ any time (control)`, ctl.filter((_, k) => k % step === 0).map((s) => run(s.p.c, s.i, kind, s.Cp)));
}
