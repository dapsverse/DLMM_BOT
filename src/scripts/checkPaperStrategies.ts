import assert from 'node:assert/strict';
import { PAPER_STRATEGIES, advancePaper, belowHighPct, entryReject, openPaper, sizeTooBigReject, slipFrac, tokenBlocked, type PaperCandidate } from '../logic/paperStrategies.js';
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
assert.ok(Z.kind === 'two_sided' && Z.bins === 6 && Z.capitalSol === 1 && Z.slPct <= 3 && Z.maxMinutes <= 60 && Z.maxOpen === 2 &&Z.cooldownMin <= 10);
assert.ok(Z.capitalSol * Z.maxOpen <= 2); // total paper exposure stays bounded
// near-open filter: weak yield, no spike, falling or pumping token all enter; absurd moves and unknown data still do not
assert.equal(entryReject(Z.entry, { ...cand, feeTvl24hPct: 2, spike: 0.1, change1hPct: -20, change24hPct: -50 }), null);
assert.equal(entryReject(Z.entry, { ...cand, feeTvl24hPct: 5, spike: null, change1hPct: 60, change24hPct: 500 }), null);
assert.match(entryReject(Z.entry, { ...cand, change24hPct: 2000 }) ?? '', /24h/);
assert.match(entryReject(Z.entry, { ...cand, change1hPct: null }) ?? '', /unknown/);
const zp = openPaper(Z, { id: 'z', pool: 'p', name: 'T', mint: 'm', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 30 }, costs);
assert.ok(Math.abs(zp.solBins.reduce((a, b) => a + b.s, 0) - 0.5) < 1e-9 && zp.lo === -5 && zp.hi === 6); // half of 1 SOL in 6 bins below, token half above

// blitz risk fixes: TVL >= 50k, size <= 2% TVL, slippage ~ size / TVL, one position per token
assert.equal(Z.entry.minTvlUsd, 50_000);
assert.equal(Z.maxPosPctOfTvl, 2);
assert.match(entryReject(Z.entry, { ...cand, tvlUsd: 49_999 }) ?? '', /tvl/);
assert.equal(entryReject(Z.entry, { ...cand, tvlUsd: 50_000 }), null);
assert.equal(sizeTooBigReject(1, 150, 50_000, 2), null); // 0.3%
assert.match(sizeTooBigReject(10, 150, 50_000, 2) ?? '', /3\.00% of pool TVL > 2%/);
assert.match(sizeTooBigReject(1, null, 50_000, 2) ?? '', /unknown/);
assert.match(sizeTooBigReject(1, 150, null, 2) ?? '', /unknown/);
assert.equal(sizeTooBigReject(100, 150, 1000, undefined), null); // other strategies: off
assert.ok(Math.abs(slipFrac(1, 150, 15_000) - 0.02) < 1e-12); // 2 x 150 / 15000
assert.ok(slipFrac(1, 150, 7_500) > slipFrac(1, 150, 15_000)); // thinner pool, more slippage
assert.equal(slipFrac(1, 150, null), 0);
assert.equal(slipFrac(1e6, 150, 1000), 0.5); // capped
// slippage lowers the tokens bought at entry (two-sided) and raises the cost at exit, only for strategies with maxPosPctOfTvl
const inp = { id: 's', pool: 'p', name: 'T', mint: 'mm', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 30, solPriceUsd: 150, tvlUsd: 15_000 };
const withSlip = openPaper(Z, inp, costs);
const noSlip = openPaper({ ...Z, maxPosPctOfTvl: undefined }, inp, costs);
const tok = (p: { tokBins: { tau: number }[] }) => p.tokBins.reduce((a, b) => a + b.tau, 0);
assert.ok(tok(withSlip) < tok(noSlip) && (withSlip as { tvlUsd?: number }).tvlUsd === 15_000 && (noSlip as { tvlUsd?: number }).tvlUsd === undefined);
const up2 = Array.from({ length: 6 }, (_, i) => mk(300 * (i + 1), 1.3));
const eSlip = advancePaper(withSlip, up2, { ...Z, oorMinutes: 5 }, costs).exit!;
const eNo = advancePaper(noSlip, up2, { ...Z, maxPosPctOfTvl: undefined, oorMinutes: 5 }, costs).exit!;
assert.ok(eSlip.slippageSol > 0 && eNo.slippageSol === 0 && eSlip.netSol < eNo.netSol);
// one position per token
const none = new Map<string, number>();
assert.equal(tokenBlocked([], none, 'm1', 1_000_000, 60), null);
assert.match(tokenBlocked(['m1'], none, 'm1', 1_000_000, 60) ?? '', /open position/);
const recent = new Map([['m1', 1_000_000 - 30 * 60_000]]);
assert.match(tokenBlocked([], recent, 'm1', 1_000_000, 60) ?? '', /cooldown 60 min/);
assert.equal(tokenBlocked([], recent, 'm1', 1_000_000 + 40 * 60_000, 60), null); // 70 min later
assert.equal(tokenBlocked([], recent, 'm2', 1_000_000, 60), null); // other token free

console.log('OK: paper strategies (entry rules, ladder open, net PnL accounting, exits, comparators)');
