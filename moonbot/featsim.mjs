// Which entry features predict range-LP outcome? Centered +-R spot position (rangesim model), idle-rebalance M, 24h horizon; bucket net PnL by feature terciles + Spearman.
// Usage: R=0.09 M=60 YMIN=2 node moonbot/featsim.mjs
import { readdirSync, readFileSync } from 'node:fs';
const DIR = new URL('./' + (process.env.DATA ?? 'data5m') + '/', import.meta.url).pathname;
const F = 0.011, K = 0.761, R = +(process.env.R ?? 0.09), M = +(process.env.M ?? 60), YMIN = +(process.env.YMIN ?? 2), HORIZON = 288;
const pools = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length > 400).map((p) => {
  let c = p.candles; if (p.xIsSol) c = c.map(([t, o, h, l, cl, v]) => [t, 1 / o, 1 / l, 1 / h, 1 / cl, v]);
  return { ...p, c: c.filter((x) => x[1] > 0 && x[4] > 0 && isFinite(x[1]) && isFinite(x[4])) };
});
const amounts = (L, p, pa, pb) => { const P = Math.min(Math.max(p, pa), pb); return { x: L * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)), y: L * (Math.sqrt(P) - Math.sqrt(pa)) }; };
const valueOf = (L, p, pa, pb) => { const a = amounts(L, p, pa, pb); return a.x * p + a.y; };
const overlap = (l, h, pa, pb) => (h <= l ? (l >= pa && l <= pb ? 1 : 0) : Math.max(0, Math.min(h, pb) - Math.max(l, pa)) / (h - l));
function run(c, i0, Cp) {
  let pa, pb, L, idle = 0, idleDn = 0, fees = 0, width, endT = Math.min(c.length - 1, i0 + HORIZON);
  const open = (p, cap) => { pa = p * (1 - R); pb = p * (1 + R); L = cap / valueOf(1, p, pa, pb); width = (pb - pa) / p; };
  open(c[i0][4], 1); let V = 1; V -= 0;
  for (let t = i0 + 1; t <= Math.min(c.length - 1, i0 + HORIZON); t++) {
    const [, , h, l, cl, v] = c[t]; fees += Cp * v * overlap(l, h, pa, pb) / width;
    if (process.env.UPEXIT && cl > pb) { endT = t; break; }
    idleDn = cl < pa ? idleDn + 5 : 0;
    if (process.env.DOWNEXIT && idleDn >= +process.env.DOWNEXIT) { endT = t; break; }
    idle = cl < pa || cl > pb ? idle + 5 : 0;
    if (idle >= M) { const cur = valueOf(L, cl, pa, pb), a = amounts(L, cl, pa, pb), w = a.x * cl / (cur || 1e-12); V = cur - Math.abs(w - 0.5) * cur * F; open(cl, V); idle = 0; }
  }
  const end = c[endT][4], cur = valueOf(L, end, pa, pb), a = amounts(L, end, pa, pb);
  return cur - a.x * end * F + fees - 1 - 0.5 * F;
}
const rows = [];
for (const p of pools) { const c = p.c, base = (+p.baseFeePct || 1) / 100, tvl = Math.max(+p.tvl || 1, 20000), Cp = K * base / tvl;
  for (let i = 288; i < c.length - HORIZON - 1; i += 36) {
    const tv = c.slice(i - 288, i).reduce((s, x) => s + x[5], 0); if (tv < 100000) continue;
    const fy = tv * base / tvl * 100; if (fy < YMIN) continue;
    const ch = (n) => c[i][4] / c[i - n][4] - 1; if (Math.abs(ch(12)) > 0.15 || Math.abs(ch(72)) > 0.15) continue;
    const hi = Math.max(...c.slice(Math.max(0, i - 576), i).map((x) => x[2]));
    const v1 = c.slice(i - 12, i).reduce((s, x) => s + x[5], 0), v6 = c.slice(i - 72, i).reduce((s, x) => s + x[5], 0);
    rows.push({ net: run(c, i, Cp), name: p.name, f: { chg1h: ch(12), chg6h: ch(72), chg24h: ch(288), belowHigh48h: c[i][4] / hi - 1, feeYield24h: fy, volAccel1hVs6h: v6 ? (v1 / v6) * 6 : 0, tvlUsd: tvl, baseFee: base * 100 } });
  } }
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), pct = (x) => (x * 100).toFixed(1) + '%';
const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = []; o.forEach(([, i], k) => (r[i] = k)); return r; };
const sp = (x, y) => { const a = rank(x), b = rank(y), ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
console.log(`windows ${rows.length}, tokens ${new Set(rows.map((r) => r.name)).size}, R +-${R * 100}%, idle ${M}m; overall mean ${pct(mean(rows.map((r) => r.net)))}`);
for (const k of Object.keys(rows[0].f)) {
  const s = [...rows].sort((a, b) => a.f[k] - b.f[k]), n = Math.floor(s.length / 3), g = [s.slice(0, n), s.slice(n, 2 * n), s.slice(2 * n)];
  console.log(`${k.padEnd(16)} spearman ${sp(rows.map((r) => r.f[k]), rows.map((r) => r.net)).toFixed(2).padStart(5)}  low ${pct(mean(g[0].map((r) => r.net))).padStart(6)}  mid ${pct(mean(g[1].map((r) => r.net))).padStart(6)}  high ${pct(mean(g[2].map((r) => r.net))).padStart(6)}`);
}
// robustness: thresholds, per-token, leave-one-token-out
const bh = (r) => r.f.belowHigh48h;
for (const [lo, hi] of [[-1, -0.6], [-0.6, -0.4], [-0.4, -0.2], [-0.2, 0.01]]) { const g = rows.filter((r) => bh(r) >= lo && bh(r) < hi); console.log(`belowHigh48h [${lo * 100}%,${hi * 100}%) n ${String(g.length).padStart(3)} tokens ${String(new Set(g.map((r) => r.name)).size).padStart(2)} mean ${pct(mean(g.map((r) => r.net)))} win ${pct(g.filter((r) => r.net > 0).length / (g.length || 1))}`); }
const toks = [...new Set(rows.map((r) => r.name))]; const loo = toks.map((t) => { const g = rows.filter((r) => r.name !== t); return sp(g.map(bh), g.map((r) => r.net)); });
console.log('leave-one-token-out spearman min/max', Math.min(...loo).toFixed(2), Math.max(...loo).toFixed(2));
const per = toks.map((t) => { const g = rows.filter((r) => r.name === t); return { b: mean(g.map(bh)), n: mean(g.map((r) => r.net)) }; });
console.log('token-level (n=' + per.length + ') spearman belowHigh48h vs net', sp(per.map((x) => x.b), per.map((x) => x.n)).toFixed(2));
