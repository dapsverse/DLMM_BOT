// Maker-grid on DLMM limit orders (no Jupiter swaps). SOL bids below price, token asks above each fill.
// Conservative fills: price must cross one FULL extra bin past the order bin (bin step from pool meta); maker earns 50% of pool base fee per filled leg.
// Forced exit after HOLD hours = cancel + market swap (friction + stale/dead haircut). Usage: DATA=data_new MINVOL=100000 node moonbot/grid2.mjs
import { loadPools, staleMult } from './lib.mjs';
const MINVOL = +(process.env.MINVOL ?? 100000), EXIT_FRIC = 0.012, MAKER_SHARE = +(process.env.MAKER_SHARE ?? 0.5), ORDER_ACCT_COST = +(process.env.ORDER_COST ?? 0.002); // SOL rent estimate, unverified
const VALID = 24, HOLD = +(process.env.HOLD ?? 72);
const pools = loadPools(+(process.env.MINLEN ?? 72));
const O = 1, Hh = 2, L = 3, C = 4, V = 5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (x) => (x * 100).toFixed(1) + '%';
const CFGS = [
  { name: 'bids -10/-20/-30, ask +15%', bids: [0.1, 0.2, 0.3], tp: 0.15 },
  { name: 'bids -10/-20/-30, ask +30%', bids: [0.1, 0.2, 0.3], tp: 0.30 },
  { name: 'bids -5/-10, ask +10%', bids: [0.05, 0.1], tp: 0.10 },
  { name: 'bids -20/-40, ask +50%', bids: [0.2, 0.4], tp: 0.50 },
];
for (const cfg of CFGS) {
  const rows = [], win = [], lock = [], fills = [], tokens = new Set(), forced = [];
  for (const p of pools) {
    const c = p.c, bs = (+p.binStep || 50) / 10000, fee = (+p.baseFeePct || 1) / 100;
    for (let i = 48; i < c.length - VALID - 2; i += 24) {
      if (c.slice(i - 24, i).reduce((s, x) => s + x[V], 0) < MINVOL) continue;
      const ref = c[i][O]; let pnl = 0, nfill = 0, lockH = 0;
      for (const b of cfg.bids) {
        const px = ref * (1 - b), cross = px * (1 - bs); let fillT = -1;
        for (let t = i; t < i + VALID; t++) if (c[t][L] <= cross && c[t][V] > 0) { fillT = t; break; }
        if (fillT < 0) { lockH += VALID / cfg.bids.length; continue; }
        nfill++; const w = 1 / cfg.bids.length, ask = px * (1 + cfg.tp), tokensQty = (w / px) * (1 + MAKER_SHARE * fee); // maker earns share of fee on bid fill
        let out = null, endT = Math.min(c.length - 1, fillT + HOLD);
        for (let t = fillT + 1; t <= endT; t++) if (c[t][Hh] >= ask * (1 + bs) && c[t][V] > 0) { out = ask * (1 + MAKER_SHARE * fee); endT = t; break; }
        if (out === null) { out = c[endT][C] * (1 - EXIT_FRIC) * staleMult(c, endT); forced.push(1); } else forced.push(0);
        pnl += tokensQty * out - w - ORDER_ACCT_COST * w; lockH += (fillT - i) + (endT - fillT);
      }
      rows.push({ m: p.mint, t: c[i][0], r: pnl, age: (c[i][0] - c[0][0]) / 86400 }); win.push(pnl); fills.push(nfill / cfg.bids.length); lock.push(lockH / cfg.bids.length); tokens.add(p.mint);
    }
  }
  const avgLock = mean(lock) || 1;
  // token-cluster bootstrap CI + time halves
  const byTok = new Map(); for (const r of rows) (byTok.get(r.m) ?? byTok.set(r.m, []).get(r.m)).push(r.r);
  const toks = [...byTok.values()]; const bs = [];
  for (let b = 0; b < 500; b++) { let sum = 0, n = 0; for (let k = 0; k < toks.length; k++) { const t = toks[Math.floor(Math.random() * toks.length)]; sum += t.reduce((a, x) => a + x, 0); n += t.length; } bs.push(sum / n); }
  const tm = [...rows].sort((a, b) => a.t - b.t); const h = Math.floor(tm.length / 2);
  const ci = `CI95 [${pct(q(bs, .025))}, ${pct(q(bs, .975))}] halves ${pct(mean(tm.slice(0, h).map((x) => x.r)))}/${pct(mean(tm.slice(h).map((x) => x.r)))}`;
  console.log(`${cfg.name.padEnd(28)} windows ${win.length} tok ${tokens.size} fill ${pct(mean(fills))} mean ${pct(mean(win))} med ${pct(q(win, .5))} p10 ${pct(q(win, .1))} p90 ${pct(q(win, .9))} | avg lock ${avgLock.toFixed(0)}h => ${pct(mean(win) / (avgLock / 24))}/day on locked cap | forced-exit ${pct(mean(forced))}\n    ${ci} | by pool age: ${[[0, 3], [3, 6], [6, 99]].map(([a, b]) => { const x = rows.filter((r) => r.age >= a && r.age < b).map((r) => r.r); return `${a}-${b}d n=${x.length} ${pct(mean(x))}`; }).join(' ')}`);
}
