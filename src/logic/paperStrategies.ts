/**
 * PAPER STRATEGIES (2026-11-04, docs/strategy-research-2026-11-04.md): three own strategies, independent of the meridian exit rules, simulated on 5m candles with the
 * bin model of shadowSim.ts (constant-sum bins, fee = value * pool fee/TVL 24h at entry * minutes/1440 while in range). Pure: no wallet, no I/O, no env.
 * Every closed position records NET PnL split in fees / value change (IL + price) / exit cost / gas, plus the two comparators: hold SOL (always 0) and hold the same token.
 */
import { uOf, binOfU, priceOfU, valuePosition, type SimPosition } from './shadowSim.js';
import type { ShadowCandle } from './shadowStrategy.js';

export interface PaperStrategy {
  name: string;
  kind: 'sol_ladder' | 'two_sided';
  /** sol_ladder: bins below the price; two_sided: bins on EACH side */
  bins: number;
  capitalSol: number;
  tpPct: number;
  slPct: number;
  /** trailing: once net PnL peaked >= trailTriggerPct, exit when it falls trailDropPct below the peak (0 = off) */
  trailTriggerPct: number;
  trailDropPct: number;
  maxMinutes: number;
  /** minutes out of range (either side) before the position is closed */
  oorMinutes: number;
  maxOpen: number;
  cooldownMin: number;
  /** blitz only: position size cap in % of pool TVL; setting it also turns on price-impact slippage on the swaps (see slipFrac) */
  maxPosPctOfTvl?: number;
  /** blitz only: minutes a TOKEN (not just a pool) is blocked after an out-of-range-above exit */
  tokenOorAboveCooldownMin?: number;
  /**
   * Simulator v2 (2026-11-07, wide-hold / dipladder-v2 only; the older strategies keep the v1 maths): stop loss checked on the candle LOW and filled at the stop level
   * (at the open on a gap), fee pro rata to the part of the candle's high-low span inside the range, and the extra exits below.
   */
  simV2?: boolean;
  /** liquidity shape: 'bidask' (default, heavier away from the price) or 'spot' (uniform) */
  shape?: 'bidask' | 'spot';
  /** two-sided: half-width of the range in %, converted to bins per side at entry from the pool's bin step (overrides `bins`) */
  rangePct?: number;
  /** exit when one 5m candle falls more than this % open -> close (0/undefined = off) */
  crashCandlePct?: number;
  /** sol ladder: exit when the price reaches `frac` of the ladder depth within `withinMin` minutes of the entry (a fast slide, not a dip) */
  fastDepth?: { frac: number; withinMin: number };
  /** max positions ever opened on one token in this run (correlated samples), undefined = unlimited */
  maxEntriesPerToken?: number;
  /** early kill: after `minN` closed positions, stop opening when avg net % < avgPct or total net SOL < totalSol */
  kill?: { minN: number; avgPct: number; totalSol: number };
  entry: EntryRule;
}

export interface EntryRule {
  minFeeTvl24hPct: number;
  minTvlUsd?: number;
  minMcapUsd?: number;
  minHolders?: number;
  minSpike?: number;
  min1hPct?: number;
  max1hPct?: number;
  max6hAbsPct?: number;
  min24hPct?: number;
  max24hPct?: number;
  /** price must sit between these % below the highest high of the last 4h (needs candles) */
  belowHigh4hMinPct?: number;
  belowHigh4hMaxPct?: number;
  maxSpike?: number;
  /** pool age (hours) from the pool's creation time: a proxy for the token age */
  minPoolAgeH?: number;
}

export interface PaperCandidate {
  /** recorded on entry (simV2 strategies): pool age in hours and the 1h high-low range in % of the last close */
  poolAgeH?: number | null;
  vol1hPct?: number | null;
  feeTvl24hPct: number | null;
  tvlUsd: number | null;
  mcapUsd: number | null;
  holders: number | null;
  spike: number | null;
  change1hPct: number | null;
  change6hPct: number | null;
  change24hPct: number | null;
  belowHigh4hPct: number | null;
}

/** The 3 strategies, see the report for the data behind each number. */
export const PAPER_STRATEGIES: Record<string, PaperStrategy> = {
  // A: buy-the-dip wide SOL ladder (the live-like 69 bins, the only shape that backtested positive), strict yield, SL 12, bot-like trailing
  dipladder: { name: 'dipladder', kind: 'sol_ladder', bins: 69, capitalSol: 1, tpPct: 5, slPct: 12, trailTriggerPct: 3, trailDropPct: 1.5, maxMinutes: 720, oorMinutes: 30, maxOpen: 3, cooldownMin: 120, entry: { minFeeTvl24hPct: 15, minSpike: 0.5, belowHigh4hMinPct: 10, belowHigh4hMaxPct: 30 } },
  // B: calm mature pool, two-sided 12+12 bins, long hold on fees, small directional exposure (untested by backtest: no two-sided data)
  calm: { name: 'calm', kind: 'two_sided', bins: 12, capitalSol: 1, tpPct: 3, slPct: 6, trailTriggerPct: 0, trailDropPct: 0, maxMinutes: 720, oorMinutes: 30, maxOpen: 3, cooldownMin: 240, entry: { minFeeTvl24hPct: 7, minTvlUsd: 100_000, minMcapUsd: 5_000_000, minHolders: 5000, max6hAbsPct: 15, min24hPct: -30 } },
  // C: hot-yield momentum, wide ladder, short time stop (tight ladders lost in the backtest: 25 bins SL10 -4.1 SOL / 341 trades)
  // D: high-frequency paper scalp (Master 2026-11-05: NOT selective): near-open entry filter, concentrated two-sided 6+6 bins, 1 SOL x up to 2 open (2 SOL max exposure), 5 min cooldown, tight TP/SL, 60 min time stop
  blitz: { name: 'blitz', kind: 'two_sided', bins: 6, capitalSol: 1, tpPct: 2, slPct: 3, trailTriggerPct: 1.2, trailDropPct: 0.6, maxMinutes: 60, oorMinutes: 10, maxOpen: 2, cooldownMin: 5, maxPosPctOfTvl: 2, tokenOorAboveCooldownMin: 60, entry: { minFeeTvl24hPct: 0, minTvlUsd: 50_000, min1hPct: -30, max1hPct: 100, min24hPct: -70, max24hPct: 1000 } },
  hotyield: { name: 'hotyield', kind: 'sol_ladder', bins: 69, capitalSol: 1, tpPct: 3, slPct: 8, trailTriggerPct: 0, trailDropPct: 0, maxMinutes: 180, oorMinutes: 15, maxOpen: 3, cooldownMin: 60, entry: { minFeeTvl24hPct: 40, minSpike: 1.5, min1hPct: -5, max1hPct: 25, max24hPct: 300 } },
  // S1 (2026-11-07 analysis): fee only beat value change when a position sat in range for hours (live trailing/TP exits, dipladder's in-range holds), and blitz's
  // narrow range lost 2.98 SOL / 135 on the down side. So: wide two-sided spot +-35%, mature high-yield pools, no post-pump, no fixed TP, long hold.
  widehold: { name: 'widehold', kind: 'two_sided', bins: 0, rangePct: 35, shape: 'spot', simV2: true, capitalSol: 1, tpPct: 1000, slPct: 15, trailTriggerPct: 6, trailDropPct: 2, maxMinutes: 1440, oorMinutes: 60, maxOpen: 2, cooldownMin: 60, maxEntriesPerToken: 5, kill: { minN: 15, avgPct: -1.5, totalSol: -0.3 }, entry: { minFeeTvl24hPct: 15, minTvlUsd: 150_000, minPoolAgeH: 48, min24hPct: -40, max24hPct: 150, belowHigh4hMinPct: 5, belowHigh4hMaxPct: 25, minSpike: 0.5, maxSpike: 3 } },
  // S2: dipladder plus crash guards: its 2 losses (ABTC -12.5%, Diamond -24%) were fast dumps of 45-53%, Diamond after +2292% in 24h.
  dipladder2: { name: 'dipladder2', kind: 'sol_ladder', bins: 69, simV2: true, capitalSol: 1, tpPct: 5, slPct: 12, trailTriggerPct: 3, trailDropPct: 1.5, maxMinutes: 720, oorMinutes: 30, maxOpen: 3, cooldownMin: 120, crashCandlePct: 10, fastDepth: { frac: 0.3, withinMin: 30 }, maxEntriesPerToken: 5, kill: { minN: 15, avgPct: -1.5, totalSol: -0.3 }, entry: { minFeeTvl24hPct: 15, minSpike: 0.5, belowHigh4hMinPct: 10, belowHigh4hMaxPct: 30, max24hPct: 300, minPoolAgeH: 24 } },
};

const num = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);

/** null = enter; a string = why not. Unknown data FAILS this check (a paper strategy needs positive evidence for every criterion it states). */
export function entryReject(r: EntryRule, c: PaperCandidate): string | null {
  const need = (name: string, v: number | null, ok: (x: number) => boolean, why: string): string | null => (!num(v) ? `${name} unknown` : ok(v) ? null : why);
  const checks: (string | null)[] = [need('fee/TVL 24h', c.feeTvl24hPct, (x) => x >= r.minFeeTvl24hPct, `fee/TVL 24h < ${r.minFeeTvl24hPct}`)];
  if (r.minTvlUsd !== undefined) checks.push(need('tvl', c.tvlUsd, (x) => x >= r.minTvlUsd!, `tvl < ${r.minTvlUsd}`));
  if (r.minMcapUsd !== undefined) checks.push(need('mcap', c.mcapUsd, (x) => x >= r.minMcapUsd!, `mcap < ${r.minMcapUsd}`));
  if (r.minHolders !== undefined) checks.push(need('holders', c.holders, (x) => x >= r.minHolders!, `holders < ${r.minHolders}`));
  if (r.minSpike !== undefined) checks.push(need('spike', c.spike, (x) => x >= r.minSpike!, `spike < ${r.minSpike}`));
  if (r.min1hPct !== undefined) checks.push(need('1h change', c.change1hPct, (x) => x >= r.min1hPct!, `1h < ${r.min1hPct}%`));
  if (r.max1hPct !== undefined) checks.push(need('1h change', c.change1hPct, (x) => x <= r.max1hPct!, `1h > ${r.max1hPct}%`));
  if (r.max6hAbsPct !== undefined) checks.push(need('6h change', c.change6hPct, (x) => Math.abs(x) <= r.max6hAbsPct!, `|6h| > ${r.max6hAbsPct}%`));
  if (r.min24hPct !== undefined) checks.push(need('24h change', c.change24hPct, (x) => x >= r.min24hPct!, `24h < ${r.min24hPct}%`));
  if (r.max24hPct !== undefined) checks.push(need('24h change', c.change24hPct, (x) => x <= r.max24hPct!, `24h > ${r.max24hPct}%`));
  if (r.belowHigh4hMinPct !== undefined) checks.push(need('4h-high distance', c.belowHigh4hPct, (x) => x >= r.belowHigh4hMinPct!, `< ${r.belowHigh4hMinPct}% below the 4h high`));
  if (r.belowHigh4hMaxPct !== undefined) checks.push(need('4h-high distance', c.belowHigh4hPct, (x) => x <= r.belowHigh4hMaxPct!, `> ${r.belowHigh4hMaxPct}% below the 4h high`));
  if (r.maxSpike !== undefined) checks.push(need('spike', c.spike, (x) => x <= r.maxSpike!, `spike > ${r.maxSpike}`));
  if (r.minPoolAgeH !== undefined) checks.push(need('pool age', c.poolAgeH ?? null, (x) => x >= r.minPoolAgeH!, `pool age < ${r.minPoolAgeH} h`));
  return checks.find((x) => x !== null) ?? null;
}

/** % the last close sits below the highest high of the last `n` candles (>= 0), null without data. */
export function belowHighPct(candles: ShadowCandle[], n = 48): number | null {
  const last = [...candles].sort((a, b) => a.timestamp - b.timestamp).slice(-n);
  if (last.length < 12) return null;
  const hi = Math.max(...last.map((c) => c.high));
  const close = last[last.length - 1]!.close;
  return hi > 0 && close > 0 ? Math.max(0, ((hi - close) / hi) * 100) : null;
}

/** High-low range of the last `n` 5m candles (default 12 = 1 h) in % of the last close; null without enough data. Recorded per entry, never a gate. */
export function vol1hPct(candles: ShadowCandle[], n = 12): number | null {
  const last = [...candles].sort((a, b) => a.timestamp - b.timestamp).slice(-n);
  if (last.length < n) return null;
  const close = last[last.length - 1]!.close;
  const hi = Math.max(...last.map((c) => c.high));
  const lo = Math.min(...last.map((c) => c.low));
  return close > 0 && hi > 0 && lo > 0 ? ((hi - lo) / close) * 100 : null;
}

/** Positions already opened on this token >= `max` (correlated samples), null = allowed. */
export function tokenEntryCapReject(entriesOnToken: number, max: number | undefined): string | null {
  return max !== undefined && entriesOnToken >= max ? `token already entered ${entriesOnToken}x (max ${max})` : null;
}

/** Early kill rule over the closed positions of a run: null = keep going, a string = stop opening new positions. */
export function killReason(exits: { netSol: number; netPct: number }[], k: PaperStrategy['kill']): string | null {
  if (!k || exits.length < k.minN) return null;
  const total = exits.reduce((a, e) => a + e.netSol, 0);
  const avg = exits.reduce((a, e) => a + e.netPct, 0) / exits.length;
  if (avg < k.avgPct) return `kill: avg net ${avg.toFixed(2)}% < ${k.avgPct}% after ${exits.length} positions`;
  if (total < k.totalSol) return `kill: total net ${total.toFixed(3)} SOL < ${k.totalSol} after ${exits.length} positions`;
  return null;
}

export interface PaperCosts {
  exitCostPct: number;
  gasSol: number;
  feeFactor: number;
}

const bidAskWeights = (n: number): number[] => {
  const w = Array.from({ length: n }, (_, i) => 1 + i);
  const t = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / t);
};
const uniformWeights = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

/** Bins per side that cover +-`pct` % at `binStep` (bps), at least 1. */
export const binsForRangePct = (pct: number, binStep: number): number => Math.max(1, Math.ceil(Math.log(1 + pct / 100) / Math.log(1 + binStep / 10_000)));

/** A paper position; `tvlUsd` is set only for strategies with slippage on (blitz): pool TVL at entry. */
export type PaperPosition = SimPosition & { tvlUsd?: number | null };

/**
 * Price-impact slippage of a swap of `tradeSol` into a pool with `tvlUsd` of liquidity, as a fraction: constant-product style 2 x trade / TVL (a swap of s into a pool
 * with half of its TVL on each side moves the price about 2s/TVL), capped at 50%. Unknown price/TVL = 0 (the flat exitCostPct still applies).
 */
export function slipFrac(tradeSol: number, solPriceUsd: number | null | undefined, tvlUsd: number | null | undefined): number {
  if (!(tradeSol > 0) || !(typeof solPriceUsd === 'number' && solPriceUsd > 0) || !(typeof tvlUsd === 'number' && tvlUsd > 0)) return 0;
  return Math.min(0.5, (2 * tradeSol * solPriceUsd) / tvlUsd);
}

/** Position size above `maxPct` % of the pool TVL (or an unknown size ratio) is rejected: it would move the pool and dilute its own fees. maxPct undefined/0 = off. */
export function sizeTooBigReject(capitalSol: number, solPriceUsd: number | null | undefined, tvlUsd: number | null | undefined, maxPct: number | undefined): string | null {
  if (!(typeof maxPct === 'number' && maxPct > 0)) return null;
  if (!(typeof solPriceUsd === 'number' && solPriceUsd > 0) || !(typeof tvlUsd === 'number' && tvlUsd > 0)) return 'size vs TVL unknown';
  const pct = ((capitalSol * solPriceUsd) / tvlUsd) * 100;
  return pct > maxPct ? `position ${pct.toFixed(2)}% of pool TVL > ${maxPct}%` : null;
}

export function openPaper(s: PaperStrategy, i: { id: string; pool: string; name: string | null; mint: string; binStep: number; entryTs: number; lastTs: number; entryPrice: number; feeTvl24hPct: number | null; solPriceUsd?: number | null; tvlUsd?: number | null }, costs: PaperCosts): PaperPosition {
  const C = s.capitalSol;
  const slipOn = s.maxPosPctOfTvl !== undefined;
  const base = { id: i.id, decisionId: i.id, pool: i.pool, name: i.name, mint: i.mint, binStep: i.binStep, solPriceUsd: i.solPriceUsd ?? null, ...(slipOn ? { tvlUsd: i.tvlUsd ?? null } : {}), capitalSol: C, entryTs: i.entryTs, lastTs: i.lastTs, entryPrice: i.entryPrice, feeTvl24hPct: i.feeTvl24hPct, feesSol: 0, peakPct: 0, oorSinceTs: null, flipTvlUsd: null, flipTs: null, phase: 'classic' as const };
  const n = s.rangePct ? binsForRangePct(s.rangePct, i.binStep) : s.bins;
  const weights = s.shape === 'spot' ? uniformWeights : bidAskWeights;
  if (s.kind === 'sol_ladder') return { ...base, mode: 'B', solBins: weights(n).map((x, d) => ({ k: -d, s: C * x })), tokBins: [], lo: -(n - 1), hi: 0, gasPaidSol: costs.gasSol };
  const half = C / 2;
  const entrySlip = slipOn ? slipFrac(half, i.solPriceUsd, i.tvlUsd) : 0;
  const tokens = (half * (1 - costs.exitCostPct / 100 - entrySlip)) / i.entryPrice; // the token half is bought with a swap that costs exitCostPct (+ price-impact slippage for blitz)
  return { ...base, mode: 'A', solBins: weights(n).map((x, d) => ({ k: -d, s: half * x })), tokBins: weights(n).map((x, j) => ({ k: 1 + j, tau: tokens * x })), lo: -(n - 1), hi: n, gasPaidSol: 2 * costs.gasSol };
}

export interface PaperExit {
  ts: number;
  price: number;
  reason: string;
  netSol: number;
  netPct: number;
  feesSol: number;
  /** value of the holdings at exit minus the deposit: impermanent loss + price move of the part that is exposed */
  valueChangeSol: number;
  exitCostSol: number;
  /** price-impact slippage inside the costs: entry swap (token half, two-sided) + exit swap; 0 when the strategy has no slippage model */
  slippageSol: number;
  gasSol: number;
  minutesHeld: number;
  /** comparators: hold SOL = 0 by definition; hold the same token = the whole deposit in the token from entry to exit (no entry cost) */
  holdSolSol: 0;
  holdTokenSol: number;
  /** % price move entry -> exit */
  tokenMovePct: number;
}

/** Share of the candle's [low, high] span (bin coordinate u) inside the range (lo, hi+1]; a flat candle counts 1 or 0 by its close. */
export function inRangeFraction(uLow: number, uHigh: number, uClose: number, lo: number, hi: number): number {
  const a = Math.min(uLow, uHigh);
  const b = Math.max(uLow, uHigh);
  if (b - a < 1e-9) return uClose > lo && uClose <= hi + 1 ? 1 : 0;
  return Math.max(0, Math.min(b, hi + 1) - Math.max(a, lo)) / (b - a);
}

function advancePaperV2(posIn: PaperPosition, candles: ShadowCandle[], s: PaperStrategy, costs: PaperCosts): { pos: PaperPosition; exit: PaperExit | null } {
  const pos: PaperPosition = { ...posIn };
  const C = pos.capitalSol;
  const uAt = (price: number) => uOf(price, pos.entryPrice, pos.binStep);
  /** net SOL if the position closed at price coordinate u (fees accrued so far) */
  const netAt = (u: number) => {
    const { valueSol, tokenValueSol } = valuePosition(pos, u);
    const exitCost = (tokenValueSol * costs.exitCostPct) / 100 + costs.gasSol;
    return { valueSol, exitCost, net: valueSol + pos.feesSol - exitCost - pos.gasPaidSol - C };
  };
  const close = (ts: number, price: number, reason: string, held: number) => {
    const u = uAt(price);
    const { valueSol, exitCost, net } = netAt(u);
    return { pos, exit: { ts, price, reason, netSol: net, netPct: (net / C) * 100, feesSol: pos.feesSol, valueChangeSol: valueSol - C, exitCostSol: exitCost, slippageSol: 0, gasSol: pos.gasPaidSol + costs.gasSol, minutesHeld: held, holdSolSol: 0 as const, holdTokenSol: C * (price / pos.entryPrice - 1), tokenMovePct: (price / pos.entryPrice - 1) * 100 } };
  };
  for (const c of candles) {
    const closeTs = c.timestamp + 300;
    const dtMin = Math.max((c.timestamp - pos.lastTs) / 60, 0) || 5;
    pos.lastTs = c.timestamp;
    const held = (closeTs - pos.entryTs) / 60;
    const open = Number.isFinite(c.open) && c.open > 0 ? c.open : c.close;
    const low = Number.isFinite(c.low) && c.low > 0 ? Math.min(c.low, open, c.close) : Math.min(open, c.close);
    const high = Number.isFinite(c.high) && c.high > 0 ? Math.max(c.high, open, c.close) : Math.max(open, c.close);
    const u = uAt(c.close);
    const ka = binOfU(u);
    // fee: the share of the candle's span spent inside the range (v1 used the close only)
    if (pos.feeTvl24hPct !== null) {
      const frac = inRangeFraction(uAt(low), uAt(high), u, pos.lo, pos.hi);
      pos.feesSol += valuePosition(pos, u).valueSol * (pos.feeTvl24hPct / 100) * costs.feeFactor * (dtMin / 1440) * frac;
    }
    // stop loss on the LOW, filled at the stop level (value is monotone in price), or at the open when the candle opened past it (gap)
    const slSol = (-s.slPct / 100) * C;
    if (netAt(uAt(low)).net <= slSol) {
      let fill = open;
      if (netAt(uAt(open)).net > slSol) {
        let a = low;
        let b = open;
        for (let i = 0; i < 40; i++) {
          const m = (a + b) / 2;
          if (netAt(uAt(m)).net <= slSol) a = m;
          else b = m;
        }
        fill = b;
      }
      return close(closeTs, fill, `stop loss: net <= -${s.slPct}% (candle low ${((low / pos.entryPrice - 1) * 100).toFixed(1)}% vs entry)`, held);
    }
    if (s.crashCandlePct && open > 0 && ((open - c.close) / open) * 100 > s.crashCandlePct) return close(closeTs, c.close, `crash guard: 5m candle ${(((c.close - open) / open) * 100).toFixed(1)}% > -${s.crashCandlePct}%`, held);
    if (s.fastDepth && s.kind === 'sol_ladder' && held <= s.fastDepth.withinMin && ka <= pos.lo * s.fastDepth.frac) return close(closeTs, c.close, `fast slide: ${Math.round(s.fastDepth.frac * 100)}% of the ladder depth within ${Math.round(held)} min`, held);
    const netPct = (netAt(u).net / C) * 100;
    const inRange = ka >= pos.lo && ka <= pos.hi;
    if (!inRange) pos.oorSinceTs ??= closeTs;
    else pos.oorSinceTs = null;
    const oorMin = pos.oorSinceTs !== null ? (closeTs - pos.oorSinceTs) / 60 : 0;
    pos.peakPct = Math.max(pos.peakPct, netPct);
    const reason =
      netPct >= s.tpPct ? `take profit: net ${netPct.toFixed(2)}% >= ${s.tpPct}%`
      : s.trailTriggerPct > 0 && pos.peakPct >= s.trailTriggerPct && netPct <= pos.peakPct - s.trailDropPct ? `trailing: net ${netPct.toFixed(2)}% fell ${s.trailDropPct}% below the peak ${pos.peakPct.toFixed(2)}%`
      : oorMin >= s.oorMinutes ? `out of range ${ka > pos.hi ? 'above' : 'below'} for ${Math.round(oorMin)} min`
      : held >= s.maxMinutes ? `time stop ${s.maxMinutes} min`
      : null;
    if (reason) return close(closeTs, c.close, reason, held);
  }
  return { pos, exit: null };
}

export function advancePaper(posIn: PaperPosition, candlesIn: ShadowCandle[], s: PaperStrategy, costs: PaperCosts): { pos: PaperPosition; exit: PaperExit | null } {
  if (s.simV2) return advancePaperV2(posIn, [...candlesIn].filter((c) => c.timestamp > posIn.lastTs && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.timestamp - b.timestamp), s, costs);
  const pos: PaperPosition = { ...posIn };
  const slipOn = s.maxPosPctOfTvl !== undefined && typeof pos.tvlUsd === 'number';
  const C = pos.capitalSol;
  const candles = [...candlesIn].filter((c) => c.timestamp > pos.lastTs && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.timestamp - b.timestamp);
  for (const c of candles) {
    const closeTs = c.timestamp + 300;
    const dtMin = Math.max((c.timestamp - pos.lastTs) / 60, 0) || 5;
    pos.lastTs = c.timestamp;
    const u = uOf(c.close, pos.entryPrice, pos.binStep);
    const ka = binOfU(u);
    const { valueSol, tokenValueSol } = valuePosition(pos, u);
    const inRange = ka >= pos.lo && ka <= pos.hi;
    if (inRange && pos.feeTvl24hPct !== null) pos.feesSol += valueSol * (pos.feeTvl24hPct / 100) * costs.feeFactor * (dtMin / 1440);
    const exitSlipSol = slipOn ? tokenValueSol * slipFrac(tokenValueSol, pos.solPriceUsd, pos.tvlUsd) : 0;
    const exitCost = (tokenValueSol * costs.exitCostPct) / 100 + exitSlipSol + costs.gasSol;
    const netPct = ((valueSol + pos.feesSol - exitCost - pos.gasPaidSol - C) / C) * 100;
    if (!inRange) pos.oorSinceTs ??= closeTs;
    else pos.oorSinceTs = null;
    const oorMin = pos.oorSinceTs !== null ? (closeTs - pos.oorSinceTs) / 60 : 0;
    const held = (closeTs - pos.entryTs) / 60;
    pos.peakPct = Math.max(pos.peakPct, netPct);
    const reason =
      netPct <= -s.slPct ? `stop loss: net ${netPct.toFixed(2)}% <= -${s.slPct}%`
      : netPct >= s.tpPct ? `take profit: net ${netPct.toFixed(2)}% >= ${s.tpPct}%`
      : s.trailTriggerPct > 0 && pos.peakPct >= s.trailTriggerPct && netPct <= pos.peakPct - s.trailDropPct ? `trailing: net ${netPct.toFixed(2)}% fell ${s.trailDropPct}% below the peak ${pos.peakPct.toFixed(2)}%`
      : oorMin >= s.oorMinutes ? `out of range ${ka > pos.hi ? 'above' : 'below'} for ${Math.round(oorMin)} min`
      : held >= s.maxMinutes ? `time stop ${s.maxMinutes} min`
      : null;
    if (reason) {
      const netSol = valueSol + pos.feesSol - exitCost - pos.gasPaidSol - C;
      const tokenMovePct = (c.close / pos.entryPrice - 1) * 100;
      const entrySlipSol = slipOn && pos.mode === 'A' ? (C / 2) * slipFrac(C / 2, pos.solPriceUsd, pos.tvlUsd) : 0; // entry swap of the token half, already inside valueChange
      return { pos, exit: { ts: closeTs, price: c.close, reason, netSol, netPct: (netSol / C) * 100, feesSol: pos.feesSol, valueChangeSol: valueSol - C, exitCostSol: exitCost, slippageSol: exitSlipSol + entrySlipSol, gasSol: pos.gasPaidSol + costs.gasSol, minutesHeld: held, holdSolSol: 0, holdTokenSol: C * (c.close / pos.entryPrice - 1), tokenMovePct } };
    }
  }
  return { pos, exit: null };
}

/** One position per TOKEN: blocked while the token has an open position (any pool) or within `cooldownMin` after an out-of-range-above exit of it. cooldownMin undefined = only the open check. */
export function tokenBlocked(openMints: string[], lastOorAboveMs: ReadonlyMap<string, number>, mint: string, nowMs: number, cooldownMin: number | undefined): string | null {
  if (openMints.includes(mint)) return 'token already has an open position';
  const t = lastOorAboveMs.get(mint);
  if (cooldownMin && t !== undefined && nowMs - t < cooldownMin * 60_000) return `token left out-of-range above ${Math.round((nowMs - t) / 60_000)} min ago (cooldown ${cooldownMin} min)`;
  return null;
}

/** Sanity helper for the check: price at which a ladder's lowest bin starts. */
export const ladderFloorPrice = (pos: SimPosition): number => priceOfU(pos.lo, pos.entryPrice, pos.binStep);
