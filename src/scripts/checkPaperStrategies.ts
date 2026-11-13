import assert from 'node:assert/strict';
import { PAPER_STRATEGIES, advancePaper, belowHighPct, binsForRangePct, entryReject, inRangeFraction, killReason, openPaper, sizeTooBigReject, slipFrac, tokenBlocked, tokenEntryCapReject, vol1hPct, type PaperCandidate } from '../logic/paperStrategies.js';
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
assert.match(entryReject(C, { ...cand, feeTvl24hPct: 50, spike: 0.2 }) ?? '', /spike/);
// 2026-11-07 loosened thresholds (dry run: every scanned pool failed the old fee floors)
assert.equal(entryReject(C, { ...cand, feeTvl24hPct: 15.4, spike: 0.38, change1hPct: -6.9, change24hPct: 11.6 }), null); // Rocco-SOL in the dry run
assert.match(entryReject(C, { ...cand, feeTvl24hPct: 14.9, spike: 1 }) ?? '', /fee\/TVL 24h < 15/);
assert.match(entryReject(C, { ...cand, feeTvl24hPct: 30, spike: 1, change1hPct: -11 }) ?? '', /1h < -10/);
assert.equal(entryReject(B, { ...cand, feeTvl24hPct: 2.67, tvlUsd: 103_000, mcapUsd: 12e6, holders: 61_399, change6hPct: 0.4, change24hPct: 14.8 }), null); // GTA6-SOL in the dry run
assert.match(entryReject(B, { ...cand, feeTvl24hPct: 1.9, tvlUsd: 2e5, mcapUsd: 8e6, holders: 9000 }) ?? '', /fee\/TVL 24h < 2/);
assert.ok(PAPER_STRATEGIES.calm!.simV2 && PAPER_STRATEGIES.hotyield!.simV2 && PAPER_STRATEGIES.calm!.maxEntriesPerToken === 5 && PAPER_STRATEGIES.hotyield!.maxEntriesPerToken === 5);

// belowHighPct
const mk = (t: number, close: number, high = close): { timestamp: number; open: number; high: number; low: number; close: number; volume: number } => ({ timestamp: t, open: close, high, low: close, close, volume: 1 });
const series = Array.from({ length: 20 }, (_, i) => mk(i * 300, i === 3 ? 1 : 0.9, i === 3 ? 1.2 : 0.9));
series[19] = mk(19 * 300, 0.9);
assert.ok(Math.abs((belowHighPct(series) ?? 0) - 25) < 1e-9); // (1.2-0.9)/1.2
assert.equal(belowHighPct(series.slice(0, 5)), null);

// open ladder: all SOL, deposit = capital
const S = { ...PAPER_STRATEGIES.hotyield!, bins: 12, slPct: 4, tpPct: 1.5, simV2: false }; // v1 maths under test here (simulator v2 has its own section below)
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

// ---- simulator v2 + S1 widehold / S2 dipladder2 (2026-11-07)
const W = PAPER_STRATEGIES.widehold!;
const D2 = PAPER_STRATEGIES.dipladder2!;
assert.ok(W.simV2 && D2.simV2 && W.shape === 'spot' && W.rangePct === 35 && D2.bins === 69);
assert.equal(binsForRangePct(35, 100), 31); // ln 1.35 / ln 1.01 = 30.2
assert.equal(binsForRangePct(35, 80), 38);
assert.equal(binsForRangePct(0.01, 100), 1);
const ohlc = (t: number, o: number, h: number, l: number, c: number) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: 1 });
const wIn = { id: 'w', pool: 'p', name: 'T', mint: 'mw', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 20 };
const wp = openPaper(W, wIn, costs);
assert.ok(wp.lo === -30 && wp.hi === 31 && new Set(wp.solBins.map((b) => b.s.toFixed(12))).size === 1); // 31 bins a side, uniform (spot)
// entry rules: pool age, spike ceiling, unknown age fails
const wc = { ...cand, feeTvl24hPct: 20, tvlUsd: 200_000, spike: 1, change24hPct: 50, belowHigh4hPct: 10, poolAgeH: 72, vol1hPct: 4 };
assert.equal(entryReject(W.entry, wc), null);
assert.match(entryReject(W.entry, { ...wc, poolAgeH: 10 }) ?? '', /pool age < 48/);
assert.match(entryReject(W.entry, { ...wc, poolAgeH: null }) ?? '', /pool age unknown/);
assert.match(entryReject(W.entry, { ...wc, spike: 4 }) ?? '', /spike > 3/);
assert.match(entryReject(W.entry, { ...wc, change24hPct: 200 }) ?? '', /24h > 150/);
assert.match(entryReject(D2.entry, { ...cand, feeTvl24hPct: 20, spike: 1, belowHigh4hPct: 15, change24hPct: 2292, poolAgeH: 100 }) ?? '', /24h > 300/); // Diamond-SOL
// fee pro rata to the candle span inside the range
assert.equal(inRangeFraction(-1, 1, 0, -5, 5), 1);
assert.ok(Math.abs(inRangeFraction(4, 8, 7, -5, 5) - 0.5) < 1e-12); // span 4..8, range (-5, 6]: 2 of 4
assert.equal(inRangeFraction(10, 12, 11, -5, 5), 0);
assert.equal(inRangeFraction(3, 3, 3, -5, 5), 1);
// stop loss on the candle LOW, filled at the stop level (no 5m-close overshoot): blitz realised -5.1% on a -3% stop with v1
const wideDrop = advancePaper(wp, [ohlc(300, 1, 1, 0.5, 0.95)], { ...W, slPct: 5 }, costs).exit!;
assert.match(wideDrop.reason, /stop loss/);
assert.ok(Math.abs(wideDrop.netPct + 5) < 0.01, `filled at the stop: ${wideDrop.netPct}`);
assert.ok(wideDrop.price > 0.5 && wideDrop.price < 0.95);
// a gap below the stop fills at the open (worse than the stop, as in reality)
const gap = advancePaper(wp, [ohlc(300, 0.6, 0.6, 0.55, 0.58)], { ...W, slPct: 5 }, costs).exit!;
assert.ok(gap.price === 0.6 && gap.netPct < -5);
// v1 strategies keep the close-only maths: same candle, close 0.95 above the stop -> no exit
assert.equal(advancePaper(openPaper({ ...W, simV2: false }, wIn, costs), [ohlc(300, 1, 1, 0.5, 0.95)], { ...W, simV2: false, slPct: 5 }, costs).exit, null);
// S2 crash guard and fast slide (sol ladder)
const dp = openPaper(D2, { ...wIn, mint: 'md' }, costs);
const crash = advancePaper(dp, [ohlc(300, 1, 1, 0.88, 0.88)], { ...D2, slPct: 50 }, costs).exit!;
assert.match(crash.reason, /crash guard: 5m candle -12\.0%/);
const slideP = priceOfU(-25, 1, 100); // below 30% of the 69-bin depth (bin -20.4)
const slide = advancePaper(dp, [ohlc(300, 1, 1, 0.97, 0.97), ohlc(600, 0.97, 0.97, slideP, slideP * 1.0001)], { ...D2, slPct: 50, crashCandlePct: 99 }, costs).exit!;
assert.match(slide.reason, /fast slide/);
const late = advancePaper({ ...dp, entryTs: -3600 }, [ohlc(300, 1, 1, slideP, slideP)], { ...D2, slPct: 50, crashCandlePct: 99 }, costs).exit; // 65 min after entry: not a fast slide
assert.ok(late === null || !/fast slide/.test(late.reason));
// fees accrue under v2 while in range
const calmRun = advancePaper(wp, Array.from({ length: 12 }, (_, i) => ohlc(300 * (i + 1), 1, 1.01, 0.99, 1)), W, costs);
assert.ok(calmRun.exit === null && calmRun.pos.feesSol > 0);
// recorded per entry: 1h high-low range
assert.ok(Math.abs((vol1hPct(Array.from({ length: 12 }, (_, i) => ohlc(i * 300, 1, i === 5 ? 1.1 : 1, i === 7 ? 0.95 : 1, 1))) ?? 0) - 15) < 1e-9);
assert.equal(vol1hPct([ohlc(0, 1, 1, 1, 1)]), null);
// max 5 positions per token, early kill after 15 positions
assert.equal(tokenEntryCapReject(4, 5), null);
assert.match(tokenEntryCapReject(5, 5) ?? '', /max 5/);
assert.equal(tokenEntryCapReject(99, undefined), null);
const k = W.kill!;
const runs = (n: number, pct: number) => Array.from({ length: n }, () => ({ netSol: pct / 100, netPct: pct }));
assert.equal(killReason(runs(14, -10), k), null); // not before 15
assert.match(killReason(runs(15, -1.6), k) ?? '', /avg net -1\.60% < -1\.5%/);
assert.equal(killReason(runs(15, -1.4), k), null); // -0.21 SOL total, avg -1.4%
assert.match(killReason([...runs(14, 0.5), { netSol: -0.5, netPct: -50 }].map((r, i) => (i < 14 ? { netSol: 0.005, netPct: 0.5 } : r)), { minN: 15, avgPct: -99, totalSol: -0.3 }) ?? '', /total net -0\.430 SOL < -0\.3/);
assert.equal(killReason(runs(30, -5), undefined), null);

// ---- 2026-11-13: only dipladder2 + trail2 active; the net-negative strategies are retired (runner refuses them)
const active = Object.entries(PAPER_STRATEGIES).filter(([, s]) => !s.retired).map(([k]) => k).sort();
assert.deepEqual(active, ['dipladder2', 'trail2']);
for (const k of ['dipladder', 'calm', 'hotyield', 'widehold', 'blitz']) assert.match(PAPER_STRATEGIES[k]!.retired ?? '', /^2026-11-/);
const T2 = PAPER_STRATEGIES.trail2!;
// live shape (SOL-only bid-ask ladder 69, TP 5, SL 25, OOR 30) with trailing 2/1 instead of the live 3/1.5
assert.ok(T2.kind === 'sol_ladder' && T2.bins === 69 && T2.tpPct === 5 && T2.slPct === 25 && T2.oorMinutes === 30 && T2.trailTriggerPct === 2 && T2.trailDropPct === 1 && T2.simV2);
assert.equal(entryReject(T2.entry, { ...cand, feeTvl24hPct: 7, spike: 0.15, belowHigh4hPct: 10 }), null); // the live floors, inclusive
assert.match(entryReject(T2.entry, { ...cand, feeTvl24hPct: 6.9, spike: 1, belowHigh4hPct: 15 }) ?? '', /fee\/TVL 24h < 7/);
assert.match(entryReject(T2.entry, { ...cand, feeTvl24hPct: 20, spike: 0.1, belowHigh4hPct: 15 }) ?? '', /spike < 0\.15/);
assert.match(entryReject(T2.entry, { ...cand, feeTvl24hPct: 20, spike: 1, belowHigh4hPct: 5 }) ?? '', /below the 4h high/);
// trailing 2/1: a position that peaked at +2.5% net and is back near 0 exits by trailing; the live 3/1.5 would not have armed at a +2.5% peak
const tp2 = { ...openPaper(T2, { id: 't', pool: 'p', name: 'T', mint: 'mt', binStep: 100, entryTs: 0, lastTs: 0, entryPrice: 1, feeTvl24hPct: 0 }, costs), peakPct: 2.5 };
const flat1 = [ohlc(300, 1, 1, 1, 1)];
assert.match(advancePaper(tp2, flat1, T2, costs).exit?.reason ?? '', /trailing: net .* fell 1% below the peak 2\.50%/);
assert.equal(advancePaper(tp2, flat1, { ...T2, trailTriggerPct: 3, trailDropPct: 1.5 }, costs).exit, null); // live 3/1.5: not armed
assert.equal(advancePaper({ ...tp2, peakPct: 1.9 }, flat1, T2, costs).exit, null); // peak below +2%: trailing not armed

console.log('OK: paper strategies (entry rules, ladder open, net PnL accounting, exits, comparators)');
