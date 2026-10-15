// After price breaks BELOW an entry range (+-6%), does it rebound? Forward returns from the moment a rebalance would fire (idle M min after the break) vs unconditional.
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./data5m/', import.meta.url).pathname;
const MINVOL = 100000, YMIN = +(process.env.YMIN ?? 2), M = +(process.env.IDLE ?? 5) / 5, HORIZON = 288, STEP = 36;
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]); return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) }; });
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (x) => (x * 100).toFixed(2) + '%';
const FW = { '1h': 12, '3h': 36, '6h': 72 }, down = [], up = [], base = [];
for (const p of pools) { const c = p.c;
  for (let i = 288; i < c.length - HORIZON - 80; i += STEP) {
    const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0); if (tv < MINVOL) continue;
    if (tv * ((+p.baseFeePct || 1) / 100) / Math.max(+p.tvl || 1, 20000) * 100 < YMIN) continue;
    if (Math.abs(c[i][4] / c[i - 12][4] - 1) > 0.15 || Math.abs(c[i][4] / c[i - 72][4] - 1) > 0.15) continue;
    base.push(Object.fromEntries(Object.entries(FW).map(([k, n]) => [k, c[i + n][4] / c[i][4] - 1])));
    const p0 = c[i][4]; let first = -1, dir = null;
    for (let t = i + 1; t < i + HORIZON; t++) { if (c[t][4] < p0 * 0.94) { first = t; dir = 'down'; break; } if (c[t][4] > p0 * 1.06) { first = t; dir = 'up'; break; } }
    if (first < 0) continue;
    // rebalance fires after M consecutive 5m candles outside range; require still outside after M
    const t2 = first + M; if (t2 + 72 >= c.length) continue;
    const out = dir === 'down' ? c[t2][4] < p0 * 0.94 : c[t2][4] > p0 * 1.06; if (!out) continue;
    (dir === 'down' ? down : up).push(Object.fromEntries(Object.entries(FW).map(([k, n]) => [k, c[t2 + n][4] / c[t2][4] - 1])));
  } }
console.log(`events: down-break ${down.length}, up-break ${up.length}, baseline ${base.length} (yield>=${YMIN}%/d, idle ${M * 5}m)\n`);
for (const [name, a] of [['AFTER DOWN-break (rebalance moment)', down], ['AFTER UP-break', up], ['unconditional baseline', base]])
  console.log(name.padEnd(36), Object.keys(FW).map((k) => `${k}: mean ${pct(mean(a.map((x) => x[k])))} med ${pct(med(a.map((x) => x[k])))} P(>0) ${(100 * a.filter((x) => x[k] > 0).length / a.length).toFixed(0)}%`).join(' | '));
