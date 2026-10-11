// Blue-chip DLMM spot-LP backtest on 5m candles with a MECHANISTIC fee model (no calibration constant):
//   fee_t = LPSHARE * baseFee * vol_t * sum_j( pathFrac_j * ours_j / (pool_j + ours_j) )
// pool_j = snapshot pool liquidity (USD) at the same bin OFFSET from the active bin (assumes LPs follow price).
// Position = equal-USD-per-bin (Spot) over n bins centred on price; X above price, Y below. Rebalance (recentre) after M idle minutes.
// Reports net return vs HODL of the initial split (LP alpha) and absolute return, per 24h window. Usage: node moonbot/bcsim.mjs [capitalUsd=4360]
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./databc/', import.meta.url).pathname, CAP = +(process.argv[2] ?? 4360);
const LPSHARE = +(process.env.LPSHARE ?? 0.93), FBLUE = +(process.env.FBLUE ?? 0.001), FMID = +(process.env.FMID ?? 0.0025), HOR = 288, STEP = 48;
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles.length > 600 && p.bins);
if (process.env.VOLNORM) for (const p of pools) { const avg = p.candles.reduce((s, x) => s + x[5], 0) / (p.candles.length / 288); const k = Math.min(1, p.vol24 / avg); p.candles = p.candles.map((x) => [x[0], x[1], x[2], x[3], x[4], x[5] * k]); } // conservative: scale week volume to the current 24h regime
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
function density(p) { const m = new Map(p.bins.list.map((b) => [b.id - p.bins.activeId, b.usd])); return (k) => { if (m.has(k)) return m.get(k); const arr = [...m.keys()]; const near = arr.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a)); return m.get(near); }; }
function simulate(p, i0, nBins, M, F) {
  const c = p.candles, s = p.binStep / 10000, dens = density(p), bf = p.baseFeePct / 100;
  const half = Math.floor(nBins / 2); // bins offsets -half..+half around entry active bin
  let center = c[i0][4], V, base = 0, fees = 0, costs = 0, reb = 0, idle = 0, a0 = 0; // a0 = active bin index (relative to center bin) of the position frame
  const priceOf = (k) => center * (1 + s) ** k;
  const open = (cap) => { // equal USD per bin at current price: below hold Y (V each), above hold X (V*center/p_k... valued V at p_k)
    let denom = 0; for (let k = -half; k <= half; k++) denom += k <= 0 ? 1 : center / priceOf(k) * 1; // value at center
    V = cap / denom; };
  const valueAt = (price) => { let v = 0; for (let k = -half; k <= half; k++) { const pk = priceOf(k); v += price >= pk ? V : V * price / pk; } return v; };
  const xFrac = (price) => { let vx = 0, tot = 0; for (let k = -half; k <= half; k++) { const pk = priceOf(k); const val = price >= pk ? V : V * price / pk; tot += val; if (price < pk) vx += val; } return tot ? vx / tot : 0; };
  let cap = CAP; open(cap);
  const entryX = xFrac(center); costs += entryX * cap * F; // buy the X part
  const hodlX = entryX * cap / center, hodlY = (1 - entryX) * cap; const startVal = cap;
  const end = Math.min(c.length - 1, i0 + HOR);
  for (let t = i0 + 1; t <= end; t++) {
    const [, o, h, l, cl, v] = c[t];
    const lo = priceOf(-half), hi = priceOf(half + 1);
    const pathLo = Math.min(l, h), pathHi = Math.max(h, l), span = Math.max(pathHi - pathLo, 1e-12);
    const aNow = Math.round(Math.log(cl / center) / Math.log(1 + s)); // bin index of price relative to center frame
    let share = 0;
    for (let k = -half; k <= half; k++) {
      const b0 = priceOf(k), b1 = priceOf(k + 1);
      const ov = Math.max(0, Math.min(pathHi, b1) - Math.max(pathLo, b0)); if (ov <= 0) continue;
      const oursUsd = k <= 0 ? V : V * (cl / priceOf(k)); // approximate USD of our liquidity in that bin
      const poolUsd = dens(k - aNow);
      share += (ov / span) * (oursUsd / (poolUsd + oursUsd));
    }
    fees += LPSHARE * bf * v * share; // v = volume in quote/USD terms
    const out = cl < lo || cl >= hi; idle = out ? idle + 5 : 0;
    if (idle >= M) { // recentre: close at cl, swap to ~50/50, reopen
      const val = valueAt(cl), xf = xFrac(cl); const swap = Math.abs(xf - 0.5) * val; costs += swap * F; reb++;
      cap = val; center = cl; open(cap); idle = 0; // fees stay accounted separately
      // after reopen entry composition is spot-shaped; ignore its tiny skew vs 50/50
    }
  }
  const pe = c[end][4], val = valueAt(pe); const xf = xFrac(pe); const exitCost = xf * val * F;
  const lpEnd = val + fees - costs - exitCost, hodlEnd = hodlX * pe + hodlY;
  return { net: lpEnd / startVal - 1, alpha: (lpEnd - hodlEnd) / startVal, fees: fees / startVal, reb, il: (val - hodlEnd) / startVal };
}
const isBlue = (n) => /SOL-USDC|cbBTC-USDC/.test(n);
const CONFIGS = [['n25 idle30', 25, 30], ['n25 idle120', 25, 120], ['n69 idle30', 69, 30], ['n69 idle120', 69, 120], ['n69 idle480', 69, 480]];
const rows = [];
for (const p of pools) {
  const F = isBlue(p.name) ? FBLUE : FMID; const out = {};
  for (const [name, n, M] of CONFIGS) { const rs = []; for (let i = 0; i + HOR + 1 < p.candles.length; i += STEP) rs.push(simulate(p, i, n, M, F)); out[name] = { net: mean(rs.map((r) => r.net)), alpha: mean(rs.map((r) => r.alpha)), fees: mean(rs.map((r) => r.fees)), reb: mean(rs.map((r) => r.reb)), win: rs.filter((r) => r.alpha > 0).length / rs.length }; }
  rows.push({ p, out });
}
console.log(`capital $${CAP}  windows 24h from ${pools.length} pools, LPSHARE ${LPSHARE}, friction blue ${FBLUE * 100}% / other ${FMID * 100}% per leg\n`);
for (const [name] of CONFIGS) {
  console.log('== ' + name + '   (alpha = LP minus HODL of the initial split, per 24h; $/day on capital)');
  for (const { p, out } of rows.sort((a, b) => b.out[name].alpha - a.out[name].alpha)) { const o = out[name];
    console.log(`${(p.name + ' s' + p.binStep + ' f' + p.baseFeePct).padEnd(24)} fees ${pct(o.fees).padStart(7)} alpha ${pct(o.alpha).padStart(7)} ($${(o.alpha * CAP).toFixed(1)}) net ${pct(o.net).padStart(7)} reb ${o.reb.toFixed(1)} win ${pct(o.win, 0)}`); }
  console.log('');
}
