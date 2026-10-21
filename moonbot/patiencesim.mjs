// Meridian-style SOL-only bid-ask/uniform ladder BELOW price on 5m candles (price in SOL per token).
// Bin model: bin i (0=top) spans [p0(1+s)^-(i+1), p0(1+s)^-i], constant-sum, holds SOL above price / token below. Fee model as rangesim: fee_t = K*baseFee/tvl * vol_t * sum_bins(overlapFrac_i * w_i/s).
// Costs: no entry swap; exit sells the token leg at friction F. Exits: idle below range (all token) >= M min, trailing TP, SL, horizon. Price rising above range: re-seed at the new price after M min (free).
// Patience study: bot-style exits vs waiting for the bounce. Usage: node moonbot/solonlysim.mjs   (env: K FRIC YMIN MINVOL BSMIN BSMAX HORIZON)
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
  let cap = 1, fees = 0, idle = 0, upIdle = 0, peak = 0, reseeds = 0, exit = 'horizon', end = Math.min(c.length - 1, i0 + (pol.H ?? HORIZON)), t = i0;
  for (t = i0 + 1; t <= end; t++) {
    const [, , h, l, cl, v] = c[t];
    fees += feeAt(L, l, h, v, C) * cap;
    const bottom = L.bins[L.N - 1].lo, top = L.p0;
    idle = cl < bottom ? idle + 5 : 0; upIdle = cl > top * (1 + s) ** 3 ? upIdle + 5 : 0;
    const pnl = valueAt(L, cl, cap) + fees - 1;
    peak = Math.max(peak, pnl);
    if (pol.tp && pnl >= pol.tp) { exit = 'TP'; break; }
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
    for (let i = 288; i < c.length - 580; i += STEP) {
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

const BIG = 1e9, H = 576;
const POLS = [
  { name: 'BOT  OOR30 TP5 trail3/1.5 SL25', N: 60, shape: 'bidask', M: 30, sl: 0.25, tp: 0.05, tpArm: 0.03, tpDrop: 0.015, H },
  { name: 'wait OOR 2h  TP5 trail SL25', N: 60, shape: 'bidask', M: 120, sl: 0.25, tp: 0.05, tpArm: 0.03, tpDrop: 0.015, H },
  { name: 'wait OOR 6h  TP5 trail SL25', N: 60, shape: 'bidask', M: 360, sl: 0.25, tp: 0.05, tpArm: 0.03, tpDrop: 0.015, H },
  { name: 'wait OOR 6h  TP5 trail SL50', N: 60, shape: 'bidask', M: 360, sl: 0.5, tp: 0.05, tpArm: 0.03, tpDrop: 0.015, H },
  { name: 'patient: no OOR exit, TP5, SL25', N: 60, shape: 'bidask', M: BIG, sl: 0.25, tp: 0.05, H },
  { name: 'patient: no OOR exit, TP10, SL25', N: 60, shape: 'bidask', M: BIG, sl: 0.25, tp: 0.10, H },
  { name: 'patient: no OOR, no TP, SL25 (48h)', N: 60, shape: 'bidask', M: BIG, sl: 0.25, H },
  { name: 'patient: no OOR, no TP, no SL (48h)', N: 60, shape: 'bidask', M: BIG, H },
];
const byTok = (W, res) => { const m = new Map(); W.forEach((w, i) => { const a = m.get(w.p.address) ?? []; a.push(res[i].net); m.set(w.p.address, a); }); const t = [...m.values()].map(mean); return { tokens: t.length, tokMean: mean(t), tokPos: t.filter((x) => x > 0).length / t.length }; };
const show = (name, W, rs) => { const b = byTok(W, rs); const ex = (e) => pct(rs.filter((r) => r.exit === e).length / rs.length, 0);
  console.log(`${name.padEnd(37)} mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} p90 ${pct(q(rs.map((r) => r.net), .9)).padStart(6)} win ${pct(rs.filter((r) => r.net > 0).length / rs.length, 0).padStart(4)} worst ${pct(Math.min(...rs.map((r) => r.net)), 0).padStart(5)} | per-token mean ${pct(b.tokMean, 2).padStart(7)} tokens+ ${pct(b.tokPos, 0)} (${b.tokens}) | TP${ex('TP')} SL${ex('SL')} OOR${ex('OOR')} hor${ex('horizon')}`); };
for (const pol of POLS) show(pol.name, W, W.map((w) => run(w.p, w.i, pol, Cof(w.p))));
// subset: entries right after a drop (price already down >=15% from its 6h high) = the bounce-bet setup
const D = W.filter((w) => { const c = w.p.c, i = w.i; return c[i][4] <= Math.max(...c.slice(i - 72, i).map((x) => x[2])) * 0.85; });
console.log(`\n-- entries after a >=15% drop from the 6h high (n=${D.length}) --`);
for (const pol of POLS) show(pol.name, D, D.map((w) => run(w.p, w.i, pol, Cof(w.p))));

// paired token-cluster bootstrap: (policy - BOT) mean net, 95% CI over tokens
function boot(Wset, pol) {
  const base = Wset.map((w) => run(w.p, w.i, POLS[0], Cof(w.p)).net), alt = Wset.map((w) => run(w.p, w.i, pol, Cof(w.p)).net);
  const m = new Map(); Wset.forEach((w, i) => { const a = m.get(w.p.address) ?? []; a.push(alt[i] - base[i]); m.set(w.p.address, a); });
  const toks = [...m.values()].map(mean); const B = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let j = 0; j < toks.length; j++) s += toks[Math.floor(Math.random() * toks.length)]; B.push(s / toks.length); }
  return `${pct(mean(toks), 2)} CI [${pct(q(B, .025), 2)}, ${pct(q(B, .975), 2)}] tokens better ${pct(toks.filter((x) => x > 0).length / toks.length, 0)}`;
}
console.log('\n-- paired vs BOT, 95% CI by token (all entries) --');
for (const pol of POLS.slice(1)) console.log(pol.name.padEnd(37), boot(W, pol));
