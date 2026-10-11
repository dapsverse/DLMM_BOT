// Range-bot simulator on 5m candles (price in SOL per token). Fee model: fee_t = C * vol_t / width while price inside range (C calibrated on live fees).
// Compares idle-before-rebalance minutes, range width, one-sided SOL entry, and limit-ask exit vs immediate swap. Friction F per swap leg on swapped notional.
// Usage: node moonbot/rangesim.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m/', import.meta.url).pathname;
const F = +(process.env.FRIC ?? 0.011), MINVOL = +(process.env.MINVOL ?? 100000), YMIN = +(process.env.YMIN ?? 2), HORIZON = 288, STEP = 36, MAKER = 0.005;
const raw = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400);
const pools = raw.map((p) => { // normalise to SOL per token
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
// concentrated liquidity amounts for range [pa,pb] with liquidity L at price p
const amounts = (L, p, pa, pb) => { const P = Math.min(Math.max(p, pa), pb); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)), y: L * (Math.sqrt(P) - Math.sqrt(pa)) }; };
const valueOf = (L, p, pa, pb) => { const a = amounts(L, p, pa, pb); return a.x * p + a.y; };
function overlapFrac(l, h, pa, pb) { if (h <= l) return l >= pa && l <= pb ? 1 : 0; return Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l); }
// policy: {R, M (idle minutes before rebalance), oneSided}
function run(c, i0, pol, Cp) { // Cp = K * baseFee / tvl (per pool)
  const C = Cp;
  const R = pol.R, p0 = c[i0][4];
  let V = 1, fees = 0, cost = 0, reb = 0, pa, pb, L, idle = 0, events = [];
  const open = (p, capital, oneSided) => {
    if (oneSided) { pa = p * (1 - R); pb = p; } else { pa = p * (1 - R); pb = p * (1 + R); }
    const unit = valueOf(1, p, pa, pb); L = capital / unit; // value at p of unit liquidity (oneSided: all SOL)
    return pb - pa;
  };
  let width = open(p0, 1, pol.oneSided) / p0;
  if (!pol.oneSided) cost += 0.5 * F; // entry swap of half the capital
  let end = Math.min(c.length - 1, i0 + HORIZON);
  for (let t = i0 + 1; t <= end; t++) {
    const [ts, o, h, l, cl, v] = c[t];
    const inFrac = overlapFrac(l, h, pa, pb); fees += C * v * inFrac / width;
    const out = cl < pa || cl > pb;
    idle = out ? idle + 5 : 0;
    if (idle >= pol.M) {
      const cur = valueOf(L, cl, pa, pb), a = amounts(L, cl, pa, pb), wT = a.x * cl / (cur || 1e-12);
      V = cur;
      const down = cl < pa;
      let swapFrac; // fraction of V swapped to get new starting composition
      if (pol.oneSided) swapFrac = wT; else swapFrac = Math.abs(wT - 0.5);
      const cst = swapFrac * V * F; cost += cst; reb++;
      events.push({ t, down, wT, V });
      V -= cst; width = open(cl, V, pol.oneSided) / cl; idle = 0;
    }
  }
  const pe = c[end][4], cur = valueOf(L, pe, pa, pb), a = amounts(L, pe, pa, pb), wT = a.x * pe / (cur || 1e-12);
  const exitCost = wT * cur * F; // sell remaining token
  const total = cur + fees * 1 - exitCost - (cost); // fees are in capital fractions; cost already deducted from capital? (V reduced at rebalance) -> handle below
  return { net: (cur - exitCost) + fees - 1 - (pol.oneSided ? 0 : 0.5 * F), fees, reb, events };
}
// windows
function windows(P) {
  const out = [];
  for (const p of P) {
    const c = p.c;
    for (let i = 288; i < c.length - HORIZON - 1; i += STEP) {
      const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0);
      if (tv < MINVOL) continue;
      if (tv * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000) * 100 < YMIN) continue; // fee/TVL per day (%) like the bot's yield floor
      if (Math.abs(c[i][4] / c[i - 12][4] - 1) > 0.15 || Math.abs(c[i][4] / c[i - 72][4] - 1) > 0.15) continue;
      out.push({ p, i });
    }
  }
  return out;
}
// calibration of C from live entries: (pool, entry ts, end ts, realized fee frac)
const LIVE = [
  { addr: '4fvH46ajCnwsDxcdr9LWMMB4BfPnxtk8KLof9bTrBp9K', t0: '2026-10-10T14:34:19Z', t1: '2026-10-10T21:47:50Z', fee: 0.0915 / 1.2186 },
  { addr: '57JmG2uos4wGFtBuerGS2azHEPBBnp8FJRgeLmnx8uXV', t0: '2026-10-10T21:55:25Z', t1: '2026-10-10T22:58:12Z', fee: 0.0101 / 1.2186 },
];
const cs = [];
for (const L of LIVE) {
  const p = pools.find((x) => x.address === L.addr); if (!p) { console.log('calib: missing', L.addr.slice(0, 6)); continue; }
  const t0 = Date.parse(L.t0) / 1000, t1 = Date.parse(L.t1) / 1000, c = p.c, i0 = c.findIndex((x) => x[0] >= t0);
  const p0 = c[i0][4], pa = p0 * 0.94, pb = p0 * 1.06; let s = 0;
  for (let t = i0 + 1; c[t] && c[t][0] <= t1; t++) s += c[t][5] * overlapFrac(c[t][3], c[t][2], pa, pb) / 0.12;
  const base = (+p.baseFeePct || 1) / 100, shape = base / p.tvl; cs.push(L.fee / s / shape); console.log(`calib ${L.addr.slice(0, 6)}: realized fee ${pct(L.fee)} tvl $${Math.round(p.tvl)} baseFee ${p.baseFeePct}% -> K=${(L.fee / s / shape).toFixed(3)}`);
}
const K = process.env.K ? +process.env.K : cs.length ? Math.exp(cs.reduce((a, x) => a + Math.log(x), 0) / cs.length) : 0.1; // geometric mean
console.log('using K =', K.toFixed(3), '(fee = K*baseFee/tvl * vol/width)\n');
const Cof = (p) => K * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000);
const W = windows(pools); console.log('pools', pools.length, 'windows', W.length, 'tokens', new Set(W.map((w) => w.p.address)).size, 'live-pools windows', W.filter((w) => w.p.live).length);
const POL = [];
for (const R of [0.06, 0.09, 0.12]) for (const M of [5, 15, 30, 60]) POL.push({ name: `centered R${R * 100}% idle${M}m`, R, M });
for (const M of [5, 30]) POL.push({ name: `ONE-SIDED R6% idle${M}m`, R: 0.06, M, oneSided: true });
for (const pol of POL) {
  const rs = W.map((w) => run(w.p.c, w.i, pol, Cof(w.p)));
  console.log(`${pol.name.padEnd(26)} mean ${pct(mean(rs.map((r) => r.net)), 2).padStart(7)} med ${pct(q(rs.map((r) => r.net), .5), 2).padStart(7)} p10 ${pct(q(rs.map((r) => r.net), .1)).padStart(6)} fees ${pct(mean(rs.map((r) => r.fees)), 2).padStart(6)} rebalances/24h ${mean(rs.map((r) => r.reb)).toFixed(2)} win ${pct(rs.filter((r) => r.net > 0).length / rs.length, 0)}`);
}
// ---- item 6: ask-exit vs swap-now at downward rebalances (all token) ----
console.log('\nASK-EXIT vs SWAP-NOW at downward idle rebalance (centered R6% idle5m): value of selling token = 1 + gain per unit');
const evs = [];
for (const w of W) { const r = run(w.p.c, w.i, { R: 0.06, M: 5 }, Cof(w.p)); for (const e of r.events) if (e.down && e.wT > 0.9) evs.push({ c: w.p.c, t: e.t }); }
console.log('downward all-token rebalances:', evs.length);
for (const a of [0, 0.02, 0.05]) for (const T of [12, 36]) { // wait up to T candles (60 / 180 min)
  const gains = evs.map(({ c, t }) => { const px = c[t][4], ask = px * (1 + a); let fill = null;
    for (let u = t + 1; u <= Math.min(c.length - 1, t + T); u++) if (c[u][2] >= ask && c[u][5] > 0) { fill = ask * (1 + MAKER * 0.5 * 0); break; }
    const out = fill !== null ? fill / px : (c[Math.min(c.length - 1, t + T)][4] / px) * (1 - F); // timeout -> swap at then price
    return out - (1 - F); }); // vs swap now (1-F)
  console.log(`ask +${a * 100}% wait ${T * 5}m: mean gain vs swap-now ${pct(mean(gains), 2)} median ${pct(q(gains, .5), 2)} p10 ${pct(q(gains, .1), 1)} filled ${pct(evs.filter(({ c, t }) => { const ask = c[t][4] * (1 + a); for (let u = t + 1; u <= Math.min(c.length - 1, t + T); u++) if (c[u][2] >= ask && c[u][5] > 0) return true; return false; }).length / (evs.length || 1), 0)}`);
}
// ---- item 3 direct: how often does price come back into range after leaving? ----
const back = { down: [], up: [] };
for (const w of W) { const c = w.p.c, p0 = c[w.i][4], pa = p0 * 0.94, pb = p0 * 1.06; let start = -1, dir = null;
  for (let t = w.i + 1; t < Math.min(c.length, w.i + HORIZON); t++) { const out = c[t][4] < pa || c[t][4] > pb;
    if (out && start < 0) { start = t; dir = c[t][4] < pa ? 'down' : 'up'; }
    if (start >= 0 && !out) { back[dir].push((t - start) * 5); start = -1; dir = null; break; }
    if (start >= 0 && t === Math.min(c.length, w.i + HORIZON) - 1) back[dir].push(Infinity); } }
console.log('\nfirst exit from entry range (+-6%): minutes until price is back inside');
for (const d of ['down', 'up']) { const a = back[d]; console.log(d.padEnd(5), 'n', a.length, ...[5, 15, 30, 60, 180].map((m) => `<=${m}m ${pct(a.filter((x) => x <= m).length / (a.length || 1), 0)}`)); }
