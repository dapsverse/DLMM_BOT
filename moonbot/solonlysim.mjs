// Meridian-style SOL-only bid-ask/uniform ladder BELOW price on 5m candles (price in SOL per token).
// Bin model: bin i (0=top) spans [p0(1+s)^-(i+1), p0(1+s)^-i], constant-sum, holds SOL above price / token below. Fee model as rangesim: fee_t = K*baseFee/tvl * vol_t * sum_bins(overlapFrac_i * w_i/s).
// Costs: no entry swap; exit sells the token leg at friction F. Exits: idle below range (all token) >= M min, trailing TP, SL, horizon. Price rising above range: re-seed at the new price after M min (free).
// Usage: node moonbot/solonlysim.mjs   (env: K FRIC YMIN MINVOL BSMIN BSMAX HORIZON)
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL(`./${process.env.DATA ?? 'data5m2'}/`, import.meta.url).pathname;
const F = +(process.env.FRIC ?? 0.011), K = +(process.env.K ?? 0.761), MINVOL = +(process.env.MINVOL ?? 100000), YMIN = +(process.env.YMIN ?? 2);
const BSMIN = +(process.env.BSMIN ?? 0), BSMAX = +(process.env.BSMAX ?? 1e9), HORIZON = +(process.env.HORIZON ?? 288), STEP = +(process.env.STEP ?? 36), TVLMIN = +(process.env.TVLMIN ?? 0);
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400 && p.binStep >= BSMIN && p.binStep <= BSMAX && p.tvl >= TVLMIN).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';

function makeLadder(p0, s, N, shape) {
  const w = Array.from({ length: N }, (_, i) => (shape === 'bidask' ? i + 1 : 1)); const sw = w.reduce((a, b) => a + b, 0);
  return { p0, s, N, bins: w.map((x, i) => ({ w: x / sw, hi: p0 * (1 + s) ** -i, lo: p0 * (1 + s) ** -(i + 1) })) };
}
function valueAt(L, p, capital) { // capital in SOL; bins constant-sum, token side valued at p
  let v = 0;
  for (const b of L.bins) { const sol = b.w * capital, pm = Math.sqrt(b.hi * b.lo); const f = p >= b.hi ? 0 : p <= b.lo ? 1 : (b.hi - p) / (b.hi - b.lo); v += (1 - f) * sol + f * (sol / pm) * p; }
  return v;
}
function tokenValueAt(L, p, capital) {
  let v = 0; for (const b of L.bins) { const sol = b.w * capital, pm = Math.sqrt(b.hi * b.lo); const f = p >= b.hi ? 0 : p <= b.lo ? 1 : (b.hi - p) / (b.hi - b.lo); v += f * (sol / pm) * p; } return v;
}
function feeAt(L, l, h, v, C) {
  let s = 0; const rng = h - l;
  for (const b of L.bins) { const fr = rng < 1e-18 ? (l >= b.lo && l < b.hi ? 1 : 0) : Math.max(0, Math.min(h, b.hi) - Math.max(l, b.lo)) / rng; if (fr > 0) s += fr * b.w / L.s; }
  return C * v * s;
}
// pol: {N, shape, M (idle min), tpArm, tpDrop, sl}
function run(p, i0, pol, C) {
  const c = p.c, s = p.binStep / 1e4; let L = makeLadder(c[i0][4], s, pol.N, pol.shape);
  let cap = 1, fees = 0, idle = 0, upIdle = 0, peak = 0, reseeds = 0, exit = 'horizon', end = Math.min(c.length - 1, i0 + HORIZON), t = i0;
  for (t = i0 + 1; t <= end; t++) {
    const [, , h, l, cl, v] = c[t];
    fees += feeAt(L, l, h, v, C) * cap;
    const bottom = L.bins[L.N - 1].lo, top = L.p0;
    idle = cl < bottom ? idle + 5 : 0; upIdle = cl > top * (1 + s) ** 3 ? upIdle + 5 : 0;
    const pnl = valueAt(L, cl, cap) + fees - 1;
    peak = Math.max(peak, pnl);
    if (pol.sl && pnl <= -pol.sl) { exit = 'SL'; break; }
    if (pol.tpArm && peak >= pol.tpArm && pnl <= peak - pol.tpDrop) { exit = 'TP'; break; }
    if (idle >= pol.M) { exit = 'OOR'; break; }
    if (upIdle >= pol.M) { cap = valueAt(L, cl, cap); L = makeLadder(cl, s, pol.N, pol.shape); upIdle = 0; reseeds++; } // all SOL, free re-seed higher
  }
  t = Math.min(t, end); const pe = c[t][4];
  const tokV = tokenValueAt(L, pe, cap), val = valueAt(L, pe, cap);
  return { net: val - tokV * F + fees - 1, fees, exit, reseeds, filledPct: tokV / (val || 1e-12) };
}
function windows() {
  const out = [];
  for (const p of pools) {
    const c = p.c;
    for (let i = 288; i < c.length - HORIZON - 1; i += STEP) {
      const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0);
      if (tv < MINVOL) continue;
      if (tv * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000) * 100 < YMIN) continue;
      const sw6 = Math.max(...c.slice(i - 72, i).map((x) => x[2])) / Math.min(...c.slice(i - 72, i).map((x) => x[3])) - 1; // 6h high/low swing
      out.push({ p, i, swing: sw6 });
    }
  }
  return out;
}
const Cof = (p) => K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
const W = windows();
console.log(`pools ${pools.length} windows ${W.length} tokens ${new Set(W.map((w) => w.p.address)).size} (binStep ${BSMIN}..${BSMAX}, horizon ${HORIZON * 5 / 60}h, K=${K}, F=${F})\n`);
const POLS = [];
for (const N of [35, 69]) for (const shape of ['uniform', 'bidask']) POLS.push({ name: `N${N} ${shape} OOR30 SL50`, N, shape, M: 30, sl: 0.5 });
POLS.push({ name: 'N35 bidask OOR30 SL50 TP3/1.5', N: 35, shape: 'bidask', M: 30, sl: 0.5, tpArm: 0.03, tpDrop: 0.015 });
POLS.push({ name: 'N35 bidask OOR30 SL50 TP10/3', N: 35, shape: 'bidask', M: 30, sl: 0.5, tpArm: 0.10, tpDrop: 0.03 });
POLS.push({ name: 'N35 bidask OOR30 SL25', N: 35, shape: 'bidask', M: 30, sl: 0.25 });
const show = (name, rs) => console.log(`${name.padEnd(34)} n${String(rs.length).padStart(4)} mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} p90 ${pct(q(rs.map((r) => r.net), .9)).padStart(6)} win ${pct(rs.filter((r) => r.net > 0).length / rs.length, 0).padStart(4)} fees ${pct(mean(rs.map((r) => r.fees)), 2).padStart(6)} best ${pct(Math.max(...rs.map((r) => r.net)), 0)} exits ${['OOR', 'SL', 'TP', 'horizon'].map((e) => e[0] + pct(rs.filter((r) => r.exit === e).length / rs.length, 0)).join(' ')}`);
for (const pol of POLS) show(pol.name, W.map((w) => run(w.p, w.i, pol, Cof(w.p))));

// ---- baseline: our current style, centered 50:50 R12% idle60m (rangesim.run) ----
const amounts = (L, p, pa, pb) => { const P = Math.min(Math.max(p, pa), pb); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)), y: L * (Math.sqrt(P) - Math.sqrt(pa)) }; };
const valueOfC = (L, p, pa, pb) => { const a = amounts(L, p, pa, pb); return a.x * p + a.y; };
const overlapFrac = (l, h, pa, pb) => (h <= l ? (l >= pa && l <= pb ? 1 : 0) : Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l));
function runCentered(c, i0, R, M, C) {
  let V = 1, fees = 0, cost = 0.5 * F, idle = 0, pa, pb, L, width; const end = Math.min(c.length - 1, i0 + HORIZON);
  const open = (p, cap) => { pa = p * (1 - R); pb = p * (1 + R); L = cap / valueOfC(1, p, pa, pb); width = (pb - pa) / p; };
  open(c[i0][4], 1);
  for (let t = i0 + 1; t <= end; t++) {
    const [, , h, l, cl, v] = c[t]; fees += C * v * overlapFrac(l, h, pa, pb) / width;
    idle = cl < pa || cl > pb ? idle + 5 : 0;
    if (idle >= M) { const cur = valueOfC(L, cl, pa, pb), a = amounts(L, cl, pa, pb), wT = a.x * cl / (cur || 1e-12); V = cur - Math.abs(wT - 0.5) * cur * F; open(cl, V); idle = 0; }
  }
  const pe = c[end][4], cur = valueOfC(L, pe, pa, pb), a = amounts(L, pe, pa, pb), wT = a.x * pe / (cur || 1e-12);
  return { net: cur - wT * cur * F + fees - 1 - cost + (V - 1) * 0, fees, exit: 'horizon' };
}
show('BASELINE centered R12% idle60', W.map((w) => runCentered(w.p.c, w.i, 0.12, 60, Cof(w.p))));
console.log('\n-- by 6h swing bucket (N35 bidask OOR30 SL50): does a swingier token pay more? --');
const pol = { N: 35, shape: 'bidask', M: 30, sl: 0.5 };
for (const [lo, hi, nm] of [[0, 0.1, 'calm <10%'], [0.1, 0.25, 'mid 10-25%'], [0.25, 0.6, 'swing 25-60%'], [0.6, 99, 'extreme >60%']]) {
  const ws = W.filter((w) => w.swing >= lo && w.swing < hi); if (ws.length >= 5) show(nm, ws.map((w) => run(w.p, w.i, pol, Cof(w.p))));
}
if (process.env.OUT) {
  const rs = W.map((w) => ({ w, r: run(w.p, w.i, pol, Cof(w.p)) })).sort((a, b) => b.r.net - a.r.net).slice(0, 8);
  for (const { w, r } of rs) console.log(w.p.name, w.p.address.slice(0, 6), 'tvl', Math.round(w.p.tvl), 'bs', w.p.binStep, 'base', w.p.baseFeePct, 'net', pct(r.net, 0), 'fees', pct(r.fees, 0), 'exit', r.exit, 'filled', pct(r.filledPct, 0), 'when', new Date(w.p.c[w.i][0] * 1000).toISOString().slice(5, 16), 'vol24h', Math.round(w.p.c.slice(w.i, w.i + 288).reduce((s, x) => s + x[5], 0)));
}
