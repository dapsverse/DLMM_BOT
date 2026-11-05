import assert from 'node:assert/strict';
import { PAPER_STRATEGIES, advancePaper, belowHighPct, entryReject, openPaper, type PaperCandidate } from '../logic/paperStrategies.js';
import { priceOfU } from '../logic/shadowSim.js';

const costs = { exitCostPct: 1, gasSol: 0.0005, feeFactor: 1 };
const cand: PaperCandidate = { feeTvl24hPct: 20, tvlUsd: 50_000, mcapUsd: 1_000_000, holders: 800, spike: 1, change1hPct: 0, change6hPct: 5, change24hPct: 10, belowHigh4hPct: 15 };

// entry rules: pass, fail per criterion, unknown fails
const A = PAPER_STRATEGIES.dipladder!.entry;
assert.equal(entryReject(A, cand), null);
assert.match(entryReject(A, { ...cand, belowHigh4hPct: 5 }) ?? '', /below the 4h high/);
assert.match(entryReject(A, { ...cand, belowHigh4hPct: 35 }) ?? '', /below the 4h high/);
assert.match(entryReject(A, { ...cand, feeTvl24hPct: 14.9 }) ?? '', /fee\/TVL/);
assert.match(entryReject(A, { ...cand, belowHigh4hPct: null }) ?? '', /unknown/);
const B = PAPER_STRATEGIES.calm!.entry;
assert.match(entryReject(B, cand) ?? '', /tvl|mcap|holders/); // small pool is not calm
assert.equal(entryReject(B, { ...cand, tvlUsd: 200_000, mcapUsd: 8e6, holders: 9000 }), null);
assert.match(entryReject(B, { ...cand, tvlUsd: 2e5, mcapUsd: 8e6, holders: 9000, change6hPct: -20 }) ?? '', /6h/);
const C = PAPER_STRATEGIES.hotyield!.entry;
assert.equal(entryReject(C, { ...cand, feeTvl24hPct: 50, spike: 2 }), null);
assert.match(entryReject(C, { ...cand, feeTvl24hPct: 50, spike: 1 }) ?? '', /spike/);

// belowHighPct
const mk = (t: number, close: number, high = close): { timestamp: number; open: number; high: number; low: number; close: number; volume: number } => ({ timestamp: t, open: close, high, low: close, close, volume: 1 });
const series = Array.from({ length: 20 }, (_, i) => mk(i * 300, i === 3 ? 1 : 0.9, i === 3 ? 1.2 : 0.9));
series[19] = mk(19 * 300, 0.9);
assert.ok(Math.abs((belowHighPct(series) ?? 0) - 25) < 1e-9); // (1.2-0.9)/1.2
assert.equal(belowHighPct(series.slice(0, 5)), null);

// open ladder: all SOL, deposit = capital
const S = { ...PAPER_STRATEGIES.hotyield!, bins: 12, slPct: 4, tpPct: 1.5 };
const pos = openPaper(S, { id: 'x', pool: 'p', name: 'T', mint: 'm', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 50 }, costs);
assert.ok(Math.abs(pos.solBins.reduce((a, b) => a + b.s, 0) - 1) < 1e-9);
assert.equal(pos.tokBins.length, 0);
const two = openPaper(PAPER_STRATEGIES.calm!, { id: 'y', pool: 'p', name: 'T', mint: 'm', binStep: 25, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 10 }, costs);
assert.ok(two.tokBins.length > 0 && Math.abs(two.solBins.reduce((a, b) => a + b.s, 0) - 0.5) < 1e-9);

// flat price in range: fees accrue, no exit before the time stop, then time stop with positive fees and exit cost accounted
const flat = Array.from({ length: 30 }, (_, i) => mk(300 * (i + 1), 1));
const r1 = advancePaper(pos, flat, { ...S, maxMinutes: 120, tpPct: 100 }, costs);
assert.ok(r1.exit && /time stop/.test(r1.exit.reason), r1.exit?.reason);
assert.ok(r1.exit!.feesSol > 0 && r1.exit!.holdSolSol === 0 && Math.abs(r1.exit!.holdTokenSol) < 1e-9);
assert.ok(Math.abs(r1.exit!.netSol - (r1.exit!.feesSol + r1.exit!.valueChangeSol - r1.exit!.exitCostSol - 0.0005)) < 1e-9); // fees + value change - exit cost - entry gas

// price falls below the ladder: out of range below -> stop loss first if net <= -slPct, else oor exit; token comparator negative
const down = Array.from({ length: 12 }, (_, i) => mk(300 * (i + 1), priceOfU(1 - 3 * (i + 1), 1, 100)));
const r2 = advancePaper(pos, down, { ...S, slPct: 50, oorMinutes: 10 }, costs);
assert.ok(r2.exit && /out of range below/.test(r2.exit.reason), r2.exit?.reason);
assert.ok(r2.exit!.holdTokenSol < 0 && r2.exit!.tokenMovePct < 0);
const r3 = advancePaper(pos, down, S, costs);
assert.ok(r3.exit && /stop loss/.test(r3.exit.reason), r3.exit?.reason);

// pump through the ladder top: all SOL stays SOL (ladder below price) -> out of range above, ~0 net minus cost, hold-token strongly positive
const up = Array.from({ length: 6 }, (_, i) => mk(300 * (i + 1), 1.2));
const r4 = advancePaper(pos, up, S, costs);
assert.ok(r4.exit && /out of range above/.test(r4.exit.reason), r4.exit?.reason);
assert.ok(r4.exit!.holdTokenSol > 0.1);

// trailing: net rises past the trigger then falls back by trailDrop -> trailing exit
const T = { ...S, tpPct: 100, slPct: 50, trailTriggerPct: 0.5, trailDropPct: 0.2, oorMinutes: 9999, maxMinutes: 9999 };
const rise = Array.from({ length: 24 }, (_, i) => mk(300 * (i + 1), 1));
const rT = advancePaper(pos, rise, T, costs);
assert.ok(rT.exit === null || /trailing/.test(rT.exit.reason)); // flat price: fees climb, no fall yet
const posPeak = { ...rT.pos, peakPct: rT.pos.peakPct + 5 };
const rT2 = advancePaper(posPeak, [mk(300 * 25, 1)], T, costs);
assert.ok(rT2.exit && /trailing/.test(rT2.exit.reason), rT2.exit?.reason);
assert.ok(PAPER_STRATEGIES.dipladder!.bins === 69 && PAPER_STRATEGIES.hotyield!.bins === 69);

// blitz: aggressive, concentrated, bigger size, tighter than every other strategy
const Z = PAPER_STRATEGIES.blitz!;
assert.ok(Z.kind === 'two_sided' && Z.bins === 6 && Z.capitalSol === 2 && Z.slPct <= 3 && Z.maxMinutes <= 60);
assert.equal(entryReject(Z.entry, { ...cand, feeTvl24hPct: 35, spike: 2, change1hPct: 8 }), null);
assert.match(entryReject(Z.entry, { ...cand, feeTvl24hPct: 35, spike: 2, change1hPct: 1 }) ?? '', /1h/); // needs positive momentum
const zp = openPaper(Z, { id: 'z', pool: 'p', name: 'T', mint: 'm', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 30 }, costs);
assert.ok(Math.abs(zp.solBins.reduce((a, b) => a + b.s, 0) - 1) < 1e-9 && zp.lo === -5 && zp.hi === 6); // half of 2 SOL in 6 bins below, token half above

console.log('OK: paper strategies (entry rules, ladder open, net PnL accounting, exits, comparators)');
