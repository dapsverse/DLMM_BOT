// Moon-signal backtest on 1h candles from moonbot/data. Entry at next candle open, 1.1%/leg friction, extra gap slippage on stops.
// Usage: node moonbot/backtest.mjs
import { loadPools, staleMult } from './lib.mjs';
const FRIC = 0.011, GAP = 0.02, MIN_VOL24 = +(process.env.MIN_VOL24 ?? 20000);
const pools = loadPools(100);
const O = 1, Hh = 2, L = 3, C = 4, V = 5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x) => (x * 100).toFixed(1) + '%';

function features(c, i) {
  if (i < 48) return null;
  const k = c[i];
  const vols = c.slice(i - 24, i).map((x) => x[V]);
  const v24 = vols.reduce((s, x) => s + x, 0);
  if (v24 < MIN_VOL24) return null;
  const vr = k[V] / (mean(vols) || 1e-9);
  const hi48 = Math.max(...c.slice(i - 48, i).map((x) => x[Hh]));
  const hi14 = Math.max(...c.slice(0, i).map((x) => x[Hh]));
  return {
    ret1: k[C] / k[O] - 1, ret3: k[C] / c[i - 3][O] - 1, vr,
    closeNearHigh: (k[C] - k[L]) / ((k[Hh] - k[L]) || 1e-12),
    breakout48: k[C] > hi48, dd14: k[C] / Math.max(hi14, k[Hh]) - 1, v24,
  };
}
// exit sim: returns net return on SOL for entering at open of candle j
function simulate(c, j, trail, maxH, stop) {
  if (j >= c.length) return null;
  const entry = c[j][O] * (1 + FRIC);
  let peak = c[j][O], exit = null, held = 0;
  for (let t = j; t < Math.min(c.length, j + maxH); t++) {
    held = t - j + 1;
    const stopPx = Math.max(peak * (1 - trail), c[j][O] * (1 - stop));
    if (c[t][L] <= stopPx && t > j && c[t][V] > 0) { exit = Math.min(c[t][O], stopPx) * (1 - GAP); break; }
    if (t === j && c[t][L] <= c[j][O] * (1 - stop)) { exit = c[j][O] * (1 - stop) * (1 - GAP); break; }
    peak = Math.max(peak, c[t][Hh]);
    if (t === Math.min(c.length, j + maxH) - 1) exit = c[t][C] * staleMult(c, t);
  }
  if (exit === null) return null;
  return { ret: (exit * (1 - FRIC)) / entry - 1, held, maxUp: peak / c[j][O] - 1 };
}
const VARIANTS = {
  'A ret1>=30% vr>=3': (f) => f.ret1 >= 0.3 && f.vr >= 3,
  'B ret3>=50% vr>=3': (f) => f.ret3 >= 0.5 && f.vr >= 3,
  'C ret1>=20% vr>=5 closeNearHigh': (f) => f.ret1 >= 0.2 && f.vr >= 5 && f.closeNearHigh >= 0.7,
  'D breakout48 ret1>=15% vr>=3': (f) => f.breakout48 && f.ret1 >= 0.15 && f.vr >= 3,
  'E A but dd14>-40% (not far off high)': (f) => f.ret1 >= 0.3 && f.vr >= 3 && f.dd14 > -0.4,
  'BASE any candle (baseline)': () => true,
};
const EXITS = [{ trail: 0.25, maxH: 24, stop: 0.2 }, { trail: 0.4, maxH: 72, stop: 0.3 }];
const DELAY = +(process.env.DELAY ?? 1);
for (const ex of EXITS) {
  console.log(`\n=== exit: trail ${ex.trail * 100}% from peak, stop ${ex.stop * 100}%, max ${ex.maxH}h, delay ${DELAY} candle(s) ===`);
  for (const [name, fn] of Object.entries(VARIANTS)) {
    const rets = [], ups = [], tokens = new Set(); let lastSig = new Map();
    for (const p of pools) {
      const c = p.c;
      for (let i = 48; i < c.length - DELAY - 1; i++) {
        if (name.startsWith('BASE') && i % 24 !== 0) continue; // sample baseline once a day per pool
        const f = features(c, i); if (!f || !fn(f)) continue;
        if (!name.startsWith('BASE') && i - (lastSig.get(p.mint) ?? -99) < 24) continue; // 24h cooldown per token
        lastSig.set(p.mint, i);
        const r = simulate(c, i + DELAY, ex.trail, ex.maxH, ex.stop); if (!r) continue;
        rets.push(r.ret); ups.push(r.maxUp); tokens.add(p.mint);
      }
    }
    if (!rets.length) { console.log(name.padEnd(40), 'n=0'); continue; }
    console.log(`${name.padEnd(40)} n=${String(rets.length).padStart(4)} tok=${String(tokens.size).padStart(3)} mean ${pct(mean(rets)).padStart(7)} med ${pct(q(rets, .5)).padStart(7)} win ${pct(rets.filter((x) => x > 0).length / rets.length).padStart(6)} p10 ${pct(q(rets, .1)).padStart(7)} p90 ${pct(q(rets, .9)).padStart(7)} moon>=+100%peak ${pct(ups.filter((x) => x >= 1).length / ups.length)}`);
  }
}
console.log(`\npools ${pools.length}, dead ${pools.filter((p) => p.dead).length}, launched in window ${pools.filter((p) => p.launchedInWindow).length}`);
