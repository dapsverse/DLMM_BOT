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
}

export interface PaperCandidate {
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
  // D: high-frequency paper scalp (Master 2026-11-05: NOT selective): near-open entry filter, concentrated two-sided 6+6 bins, 0.5 SOL x up to 8 open (4 SOL max exposure), 5 min cooldown, tight TP/SL, 60 min time stop
  blitz: { name: 'blitz', kind: 'two_sided', bins: 6, capitalSol: 0.5, tpPct: 2, slPct: 3, trailTriggerPct: 1.2, trailDropPct: 0.6, maxMinutes: 60, oorMinutes: 10, maxOpen: 8, cooldownMin: 5, entry: { minFeeTvl24hPct: 0, min1hPct: -30, max1hPct: 100, min24hPct: -70, max24hPct: 1000 } },
  hotyield: { name: 'hotyield', kind: 'sol_ladder', bins: 69, capitalSol: 1, tpPct: 3, slPct: 8, trailTriggerPct: 0, trailDropPct: 0, maxMinutes: 180, oorMinutes: 15, maxOpen: 3, cooldownMin: 60, entry: { minFeeTvl24hPct: 40, minSpike: 1.5, min1hPct: -5, max1hPct: 25, max24hPct: 300 } },
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

export interface PaperCosts {
  exitCostPct: number;
  gasSol: number;
  feeFactor: number;
}

const weights = (n: number): number[] => {
  const w = Array.from({ length: n }, (_, i) => 1 + i);
  const t = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / t);
};

export function openPaper(s: PaperStrategy, i: { id: string; pool: string; name: string | null; mint: string; binStep: number; entryTs: number; lastTs: number; entryPrice: number; feeTvl24hPct: number | null }, costs: PaperCosts): SimPosition {
  const C = s.capitalSol;
  const base = { id: i.id, decisionId: i.id, pool: i.pool, name: i.name, mint: i.mint, binStep: i.binStep, solPriceUsd: null, capitalSol: C, entryTs: i.entryTs, lastTs: i.lastTs, entryPrice: i.entryPrice, feeTvl24hPct: i.feeTvl24hPct, feesSol: 0, peakPct: 0, oorSinceTs: null, flipTvlUsd: null, flipTs: null, phase: 'classic' as const };
  const n = s.bins;
  if (s.kind === 'sol_ladder') return { ...base, mode: 'B', solBins: weights(n).map((x, d) => ({ k: -d, s: C * x })), tokBins: [], lo: -(n - 1), hi: 0, gasPaidSol: costs.gasSol };
  const half = C / 2;
  const tokens = (half * (1 - costs.exitCostPct / 100)) / i.entryPrice; // the token half is bought with a swap that costs exitCostPct
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
  gasSol: number;
  minutesHeld: number;
  /** comparators: hold SOL = 0 by definition; hold the same token = the whole deposit in the token from entry to exit (no entry cost) */
  holdSolSol: 0;
  holdTokenSol: number;
  /** % price move entry -> exit */
  tokenMovePct: number;
}

export function advancePaper(posIn: SimPosition, candlesIn: ShadowCandle[], s: PaperStrategy, costs: PaperCosts): { pos: SimPosition; exit: PaperExit | null } {
  const pos: SimPosition = { ...posIn };
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
    const exitCost = (tokenValueSol * costs.exitCostPct) / 100 + costs.gasSol;
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
      return { pos, exit: { ts: closeTs, price: c.close, reason, netSol, netPct: (netSol / C) * 100, feesSol: pos.feesSol, valueChangeSol: valueSol - C, exitCostSol: exitCost, gasSol: pos.gasPaidSol + costs.gasSol, minutesHeld: held, holdSolSol: 0, holdTokenSol: C * (c.close / pos.entryPrice - 1), tokenMovePct } };
    }
  }
  return { pos, exit: null };
}

/** Sanity helper for the check: price at which a ladder's lowest bin starts. */
export const ladderFloorPrice = (pos: SimPosition): number => priceOfU(pos.lo, pos.entryPrice, pos.binStep);
