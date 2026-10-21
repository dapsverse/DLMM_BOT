// token_spot timing study: after a rule-based "local bottom" signal (proxy for what the AI judges), how often does price trade
// 1 bin (binStep%) above the entry within 15/30/60 min, and how often does it whipsaw out of the range afterwards?
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m2/', import.meta.url).pathname;
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const DROP = +(process.env.DROP ?? 8); // % below 3h high
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pc = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : 'n/a');

function study(name, signal) {
  let n = 0, r15 = 0, r30 = 0, r60 = 0, reached = 0, ws15 = 0, ws30 = 0, dump10 = 0, dump25 = 0, mfe = [], tReach = [], mfe3 = 0, mfe5 = 0, reachEarlyDump = 0;
  for (const p of pools) {
    const c = p.c, step = (+p.binStep || 100) / 10000;
    for (let i = 40; i < c.length - 30; i++) {
      if (!signal(c, i)) continue;
      n++; const p0 = c[i][4], rs = p0 * (1 + step);
      let reachT = -1;
      for (let t = i + 1; t <= i + 12; t++) if (c[t][2] >= rs) { reachT = t; break; }
      const within = (k) => reachT > 0 && reachT - i <= k;
      if (within(3)) r15++; if (within(6)) r30++; if (within(12)) r60++;
      if (reachT > 0) {
        reached++; tReach.push((reachT - i) * 5);
        // whipsaw: after reaching, closes below rs for 3 (15m) / 6 (30m) consecutive candles within the next 2h, before price makes +5% over entry
        let below = 0, w15 = false, w30 = false;
        for (let t = reachT + 1; t < Math.min(c.length, reachT + 24); t++) {
          if (c[t][2] >= p0 * 1.05) break;
          below = c[t][4] < rs ? below + 1 : 0; if (below >= 3) w15 = true; if (below >= 6) { w30 = true; break; }
        }
        if (w15) ws15++; if (w30) ws30++;
      }
      let hi = p0, lo = p0; for (let t = i + 1; t <= i + 24 && t < c.length; t++) { hi = Math.max(hi, c[t][2]); }
      mfe.push(hi / p0 - 1); if (hi >= p0 * 1.03) mfe3++; if (hi >= p0 * 1.05) mfe5++;
      for (let t = i + 1; t <= i + 12; t++) lo = Math.min(lo, c[t][3]);
      if (lo <= p0 * 0.9) dump10++; if (lo <= p0 * 0.75) dump25++;
      i += 11; // thin overlapping signals within a pool
    }
  }
  console.log(`${name.padEnd(34)} n=${String(n).padStart(5)} | reach +1bin within 15m ${pc(r15, n)} 30m ${pc(r30, n)} 60m ${pc(r60, n)} (median ${med(tReach)}m) | whipsaw>=15m ${pc(ws15, reached)} >=30m ${pc(ws30, reached)} of reached | 2h max +3% ${pc(mfe3, n)} +5% ${pc(mfe5, n)} median max ${(100 * med(mfe)).toFixed(1)}% | 1h low <=-10% ${pc(dump10, n)} <=-25% ${pc(dump25, n)}`);
}
const hi3h = (c, i) => Math.max(...c.slice(i - 36, i + 1).map((x) => x[2]));
const belowHigh = (c, i) => (hi3h(c, i) / c[i][4] - 1) * 100 >= DROP;
function lowIdx(c, i) { let li = i - 11; for (let t = i - 11; t <= i; t++) if (c[t][3] < c[li][3]) li = t; return li; }
const bottom = (c, i) => { if (!belowHigh(c, i)) return false; const li = lowIdx(c, i), age = i - li; return age >= 2 && age <= 8 && c[i][4] > c[i][1] && c[i][4] >= c[li][3] * 1.01; };
const bottomHL = (c, i) => { if (!bottom(c, i)) return false; const lo1 = Math.min(...c.slice(i - 5, i + 1).map((x) => x[3])), lo0 = Math.min(...c.slice(i - 11, i - 5).map((x) => x[3])); return lo1 > lo0; };

study('every candle (unconditional)', () => true);
study(`>=${DROP}% below 3h high`, belowHigh);
study('+ local-bottom (green, off low)', bottom);
study('+ higher low formed', bottomHL);
console.log(`\npools ${pools.length}, candles ${pools.reduce((s, p) => s + p.c.length, 0)}`);
