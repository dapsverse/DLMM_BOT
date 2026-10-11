// Drawdown-from-high study for range mode: for moments where range-mode static filters would pass (liquid, |1h|,|6h| change small),
// bucket by drawdown from the prior high and compare forward 6h behaviour. Fees can't be computed (no TVL history) so volume sustain is the fee proxy.
import { loadPools } from './lib.mjs';
const MINVOL = +(process.env.MINVOL ?? 100000), FWD = 6, RANGE = 0.06, CEIL = 0.15;
const sets = [['data', false], ['data_new', false], ['data_old', true]];
const pools = sets.flatMap(([d, pp]) => loadPools(72, d, pp).map((p) => ({ ...p, set: d })));
const O = 1, Hh = 2, L = 3, C = 4, V = 5;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = (x) => (x * 100).toFixed(1) + '%';
// concentrated-liquidity value (SOL) after price moves p0 -> p, range [p0(1-R), p0(1+R)], deposit 1 SOL-equivalent at p0 (50/50 by value not needed: uniform-L deposit)
function lpValueRatio(p0, p, R) {
  const pa = p0 * (1 - R), pb = p0 * (1 + R), sa = Math.sqrt(pa), sb = Math.sqrt(pb);
  const val = (P) => { const sp = Math.sqrt(Math.min(Math.max(P, pa), pb)); const x = 1 / sp - 1 / sb, y = sp - sa; return x * P + y; };
  return val(p) / val(p0) - 1;
}
const BUCKETS = [['0..-30%', 0, -0.3], ['-30..-60%', -0.3, -0.6], ['-60..-80%', -0.6, -0.8], ['-80..-90%', -0.8, -0.9], ['<-90%', -0.9, -1.01]];
const rows = BUCKETS.map(() => []);
for (const p of pools) {
  const c = p.c;
  for (let i = 120; i < c.length - FWD - 1; i += 6) {
    const k = c[i];
    const tv = c.slice(i - 24, i).reduce((s, x) => s + x[V], 0);
    if (tv < MINVOL) continue;
    if (Math.abs(k[C] / c[i - 1][C] - 1) > CEIL || Math.abs(k[C] / c[i - 6][C] - 1) > CEIL) continue; // range-mode volatility ceiling
    const hi = Math.max(...c.slice(Math.max(0, i - 14 * 24), i + 1).map((x) => x[Hh]));
    const dd = k[C] / hi - 1;
    const b = BUCKETS.findIndex(([, a, z]) => dd <= a && dd > z);
    if (b < 0) continue;
    const fwd = c.slice(i + 1, i + 1 + FWD), end = fwd[fwd.length - 1][C];
    const outRange = fwd.some((x) => x[Hh] > k[C] * (1 + RANGE) || x[L] < k[C] * (1 - RANGE));
    const volFwd = fwd.reduce((s, x) => s + x[V], 0) / FWD, volPrev = tv / 24;
    rows[b].push({ m: p.mint, ret: end / k[C] - 1, outRange, lp: lpValueRatio(k[C], end, RANGE), vr: volFwd / (volPrev || 1e-9), dead: volFwd < 0.2 * volPrev });
  }
}
console.log(`range-eligible moments: vol24>=${MINVOL}, |1h|,|6h|<=${CEIL * 100}%, fwd ${FWD}h, LP range +-${RANGE * 100}% (price-only LP value, no fees)\n`);
for (let b = 0; b < BUCKETS.length; b++) {
  const r = rows[b]; if (!r.length) { console.log(BUCKETS[b][0].padEnd(11), 'n=0'); continue; }
  console.log(`${BUCKETS[b][0].padEnd(11)} n=${String(r.length).padStart(5)} tok=${String(new Set(r.map((x) => x.m)).size).padStart(3)} | fwd ret med ${pct(med(r.map((x) => x.ret))).padStart(6)} P(<=-15%) ${pct(r.filter((x) => x.ret <= -0.15).length / r.length).padStart(6)} | out-of-range ${pct(r.filter((x) => x.outRange).length / r.length).padStart(6)} | LP price PnL mean ${pct(mean(r.map((x) => x.lp))).padStart(6)} med ${pct(med(r.map((x) => x.lp))).padStart(6)} | vol sustain med ${med(r.map((x) => x.vr)).toFixed(2)}x dead ${pct(r.filter((x) => x.dead).length / r.length)}`);
}
