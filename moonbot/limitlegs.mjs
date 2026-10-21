// Value of replacing Jupiter swaps by limit orders. (A) ENTRY: bid d below price, wait TW candles; vs market buy. (B) EXIT after a down-break held out of range 60m: ask d above price, wait TV candles, fallback market dump; vs dump now.
// Fill rule conservative: price must trade one full bin past the order price. Market leg costs F/2 (1.1% round trip). Maker leg pays nothing (fee bonus ignored). Usage: DATA=data5m2 H=72 TW=12 TV=288 node moonbot/limitlegs.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL(`./${process.env.DATA ?? 'data5m2'}/`, import.meta.url).pathname;
const E = process.env, F = 0.011, H = +(E.H ?? 72), TW = +(E.TW ?? 12), TV = +(E.TV ?? 288), MINV = +(E.MINV ?? 30000), BRK = +(E.BRK ?? 0.06);
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
// (A) entry
const A = { 0.005: [], 0.01: [], 0.02: [], 0.04: [] }, M = [];
// (B) exit
const B = { 0: [], 0.02: [], 0.05: [], 0.1: [] }, DUMP = [], ENDS = [];
for (const p of pools) {
  const c = p.c, bs = (+p.binStep || 50) / 10000; let next = 12, nextB = 12;
  for (let i = 12; i < c.length - H - 2; i++) {
    const v1h = c.slice(i - 12, i + 1).reduce((s, x) => s + x[5], 0); if (v1h < MINV) continue;
    if (i >= next) {
      next = i + 36; const p0 = c[i][4], end = c[i + H][4]; M.push(end / p0 - 1 - F / 2);
      for (const d of Object.keys(A)) {
        const px = p0 * (1 - +d); let ft = -1; for (let t = i + 1; t <= i + TW; t++) if (c[t][3] <= px * (1 - bs)) { ft = t; break; }
        A[d].push(ft < 0 ? null : end / px - 1);
      }
    }
    if (i >= nextB) { // simulate down-break: first t where low <= p0*(1-BRK) within 24h, then 60m later still below that -> exit price
      const p0 = c[i][4], lo = p0 * (1 - BRK); let tb = -1; for (let t = i + 1; t <= Math.min(c.length - 2, i + 288); t++) if (c[t][3] <= lo) { tb = t; break; }
      if (tb < 0 || tb + 12 + TV >= c.length) continue;
      const te = tb + 12; if (c[te][4] > lo) { nextB = tb + 12; continue; } // recovered into range: no exit
      nextB = te + 36; const pe = c[te][4], endv = c[Math.min(c.length - 1, te + TV)][4];
      DUMP.push(-F / 2);
      for (const d of Object.keys(B)) {
        const ask = pe * (1 + +d); let ft = -1; for (let t = te + 1; t <= te + TV; t++) if (c[t][2] >= ask * (1 + bs)) { ft = t; break; }
        B[d].push(ft >= 0 ? +d : endv / pe - 1 - F / 2);
      }
    }
  }
}
console.log(`pools ${pools.length}  H=${H * 5 / 60}h`);
console.log(`(A) ENTRY  market buy: n ${M.length} mean ${pct(mean(M))} (after ${pct(F / 2)} friction)`);
for (const d of Object.keys(A)) { const f = A[d].filter((x) => x !== null), all = A[d].map((x) => (x === null ? 0 : x)); console.log(`    bid -${pct(+d, 1)} wait ${TW * 5}m: fill ${pct(f.length / A[d].length, 0)} | mean per fill ${pct(mean(f))} | mean per signal (unfilled=0) ${pct(mean(all))} | fills where price fell further(<-5%): ${pct(f.filter((x) => x < -0.05).length / (f.length || 1), 0)}`); }
console.log(`(B) EXIT after ${BRK * 100}% down-break held 60m: n ${DUMP.length}  dump now ${pct(-F / 2)}`);
for (const d of Object.keys(B)) console.log(`    ask +${pct(+d, 0)} wait ${TV * 5 / 60}h then dump: fill ${pct(B[d].filter((x) => x === +d).length / B[d].length, 0)} | mean ${pct(mean(B[d]))} | med ${pct(q(B[d], .5))} | p10 ${pct(q(B[d], .1))}`);
