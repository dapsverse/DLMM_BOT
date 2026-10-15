// "Limit-order grid" sim on 1h candles: SOL bids below price, token sold by asks above fills. No stop (limit orders have none).
// Usage: FEE=0.0 node moonbot/grid.mjs
import { loadPools, staleMult } from './lib.mjs';
const FEE = +(process.env.FEE ?? 0.005), EXIT_FRIC = 0.012, MIN_VOL24 = 20000;
const pools = loadPools(100);
const O = 1, Hh = 2, L = 3, C = 4, V = 5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x) => (x * 100).toFixed(1) + '%';
const CFGS = [
  { name: 'bids -10/-20/-30, ask +15% over fill', bids: [0.1, 0.2, 0.3], tp: 0.15 },
  { name: 'bids -10/-20/-30, ask +30% over fill', bids: [0.1, 0.2, 0.3], tp: 0.30 },
  { name: 'bids -5/-10, ask +10% over fill', bids: [0.05, 0.1], tp: 0.10 },
  { name: 'bids -20/-40, ask +50% over fill', bids: [0.2, 0.4], tp: 0.50 },
];
const VALID = 24, HOLD = 72;
for (const cfg of CFGS) {
  const perUnit = [], fillRates = [], filledRets = [];
  for (const p of pools) {
    const c = p.c;
    for (let i = 48; i < c.length - VALID - 2; i += 24) {
      const v24 = c.slice(i - 24, i).reduce((s, x) => s + x[V], 0); if (v24 < MIN_VOL24) continue;
      const ref = c[i][O]; let pnl = 0, filled = 0;
      for (const b of cfg.bids) {
        const px = ref * (1 - b); let fillT = -1;
        for (let t = i; t < i + VALID; t++) if (c[t][L] <= px && c[t][V] > 0) { fillT = t; break; }
        if (fillT < 0) continue;
        filled++;
        const units = (1 / cfg.bids.length) / px; // SOL per slot -> tokens, fee on fill
        const tokens = units * (1 - FEE); const ask = px * (1 + cfg.tp); let out = null;
        for (let t = fillT + 1; t <= Math.min(c.length - 1, fillT + HOLD); t++) if (c[t][Hh] >= ask && c[t][V] > 0) { out = ask * (1 - FEE); break; }
        if (out === null) { const te = Math.min(c.length - 1, fillT + HOLD); out = c[te][C] * (1 - EXIT_FRIC) * staleMult(c, te); }
        const r = tokens * out - 1 / cfg.bids.length; pnl += r; filledRets.push(r * cfg.bids.length);
      }
      perUnit.push(pnl); fillRates.push(filled / cfg.bids.length);
    }
  }
  console.log(`${cfg.name.padEnd(42)} n=${perUnit.length} fill ${pct(mean(fillRates))} meanPnL/allocated ${pct(mean(perUnit))} med ${pct(q(perUnit, .5))} p10 ${pct(q(perUnit, .1))} p90 ${pct(q(perUnit, .9))} | per filled slot mean ${pct(mean(filledRets))} win ${pct(filledRets.filter((x) => x > 0).length / filledRets.length)}`);
}
console.log('FEE per fill', FEE, 'pools', pools.length);
