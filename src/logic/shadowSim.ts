/**
 * SHADOW SIMULATION: paper positions for the shadow selector. No wallet, no transaction: pure maths on 5m candles.
 *   A = two-sided 50:50 bid-ask centered on the price (classic position), B = SOL-only bid-ask ladder that flips to a token-only ask ladder.
 * Each shadow decision opens ONE simulated position of `capitalSol` (default 1 SOL) in its mode; it exits with the SAME rule code the real bot uses:
 *   - ladder / A: meridian's rules (`meridianExitSignal`: TP, trailing with the PnL floor, pumped-far-above, out-of-range wait, low yield) + the cycle stop loss
 *   - B flip phase: only the stop loss, pool-TVL collapse and "sold out above the range" (`flipExitSignal`), as flip.ts
 *   - a due flip (price under the lowest bin) wins over meridian's rules, as `selectExitSignal`
 *
 * Model (documented assumptions, see the PR): constant-sum bins. Bin k covers the bin coordinate u in (k, k+1], price P(u) = p0 * (1+binStep/10000)^(u-1),
 * entry at u = 1 (top of bin 0). Holdings are a pure function of the current price (no path dependence, fees aside).
 *   - bid-ask weights: linear, heavier away from the price (SOL side: 1 + depth below; token side: 1 + distance above the start)
 *   - a bin converts at the geometric middle of the part of it the price crossed (no slippage inside the bin)
 *   - fees: while the active bin is in range, value * (pool fee/TVL 24h at entry) * (minutes / 1440) * feeFactor: pool average yield, no concentration bonus
 *   - costs: selling tokens costs `exitCostPct` of their value (+ gas per tx), A pays that on the 50% swap at entry too; the flip pays gas only
 *   - evaluated at 5m candle closes (the bot's 2-tick confirmation = 1 candle here); the exit price is the close
 * Imports no wallet, swap or transaction module.
 */
import { meridianExitSignal, trailingBlockedByFloor, type MeridianExitConfig } from './meridianExit.js';
import { flipExitSignal } from './flip.js';
import type { ShadowCandle } from './shadowStrategy.js';

/** @meteora-ag/dlmm MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX (26) -> radius cap (26-1)/2; the repo's own binRange.ts clamps the same way but cannot be imported here (it pulls the wallet). */
export const SDK_SAFE_MAX_RADIUS = 12;

export interface SimParams {
  capitalSol: number;
  ladderBins: number;
  targetRangePct: number;
  minRadius: number;
  maxRadius: number;
  slPct: number;
  exit: MeridianExitConfig;
  trailingFloorPct: number;
  flipOorAboveMin: number;
  flipTvlCollapsePct: number;
  exitCostPct: number;
  exitCostGasSol: number;
  feeFactor: number;
  maxHours: number;
}

export interface SolBin {
  k: number;
  s: number;
}
export interface TokBin {
  k: number;
  tau: number;
}

export interface SimPosition {
  id: string;
  decisionId: string;
  mode: 'A' | 'B';
  pool: string;
  name: string | null;
  mint: string;
  binStep: number;
  solPriceUsd: number | null;
  capitalSol: number;
  /** epoch seconds of the entry and the start time of the last processed candle */
  entryTs: number;
  lastTs: number;
  entryPrice: number;
  feeTvl24hPct: number | null;
  phase: 'ladder' | 'flip' | 'classic';
  solBins: SolBin[];
  tokBins: TokBin[];
  /** lowest / highest bin id of the whole range (A: both halves; B ladder: the SOL ladder; B flip: the token ladder) */
  lo: number;
  hi: number;
  feesSol: number;
  gasPaidSol: number;
  peakPct: number;
  oorSinceTs: number | null;
  flipTvlUsd: number | null;
  flipTs: number | null;
}

export interface SimExit {
  ts: number;
  price: number;
  reason: string;
  pnlSol: number;
  pnlUsd: number | null;
  pnlPct: number;
  valueSol: number;
  feesSol: number;
  minutesHeld: number;
  flipped: boolean;
}

export interface StepContext {
  /** pool TVL (USD) now, only meaningful for the last candle of the batch; null = unknown */
  tvlUsd: number | null;
  /** pool fee/TVL 24h (%) now for the low-yield rule; null = unknown */
  feeTvl24hPct: number | null;
}

const lnStep = (binStep: number) => Math.log(1 + binStep / 10_000);
export const uOf = (price: number, p0: number, binStep: number): number => 1 + Math.log(price / p0) / lnStep(binStep);
export const priceOfU = (u: number, p0: number, binStep: number): number => p0 * Math.exp((u - 1) * lnStep(binStep));
/** bin k covers u in (k, k+1] */
export const binOfU = (u: number): number => Math.ceil(u) - 1;

/** Bin radius of the classic position, as binRange.computeBinRadius (without importing the wallet-loading module). */
export function simBinRadius(binStep: number, p: Pick<SimParams, 'targetRangePct' | 'minRadius' | 'maxRadius'>): number {
  const raw = Math.log(1 + p.targetRangePct / 100) / Math.log(1 + binStep / 10_000);
  return Math.round(Math.min(Math.max(raw, p.minRadius), Math.min(p.maxRadius, SDK_SAFE_MAX_RADIUS)));
}

function solValue(bins: SolBin[], u: number, price: (x: number) => number): { sol: number; tokens: number } {
  let sol = 0;
  let tokens = 0;
  for (const b of bins) {
    if (u >= b.k + 1) sol += b.s; // price at/above the bin: untouched
    else if (u <= b.k) tokens += b.s / price(b.k + 0.5); // price under the bin: fully converted at its middle
    else {
      const x = u - b.k; // partly crossed: the SOL left is x, the rest was converted from the top edge down to u
      sol += x * b.s;
      tokens += ((1 - x) * b.s) / price((b.k + 1 + u) / 2);
    }
  }
  return { sol, tokens };
}

function tokValue(bins: TokBin[], u: number, price: (x: number) => number): { sol: number; tokens: number } {
  let sol = 0;
  let tokens = 0;
  for (const b of bins) {
    if (u <= b.k) tokens += b.tau; // price under the bin: nothing sold yet
    else if (u >= b.k + 1) sol += b.tau * price(b.k + 0.5); // price over the bin: sold at its middle
    else {
      const x = u - b.k;
      sol += x * b.tau * price((b.k + u) / 2);
      tokens += (1 - x) * b.tau;
    }
  }
  return { sol, tokens };
}

/** Position value in SOL at the bin coordinate u. */
export function valuePosition(pos: SimPosition, u: number): { valueSol: number; tokenValueSol: number } {
  const price = (x: number) => priceOfU(x, pos.entryPrice, pos.binStep);
  const a = solValue(pos.solBins, u, price);
  const b = tokValue(pos.tokBins, u, price);
  const tokenValueSol = (a.tokens + b.tokens) * price(u);
  return { valueSol: a.sol + b.sol + tokenValueSol, tokenValueSol };
}

const weights = (n: number): number[] => Array.from({ length: n }, (_, i) => 1 + i);
const norm = (w: number[]): number[] => {
  const t = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / t);
};

export interface OpenInput {
  id: string;
  decisionId: string;
  mode: 'A' | 'B';
  pool: string;
  name: string | null;
  mint: string;
  binStep: number;
  solPriceUsd: number | null;
  entryTs: number;
  lastTs: number;
  entryPrice: number;
  feeTvl24hPct: number | null;
}

export function openSim(i: OpenInput, p: SimParams): SimPosition {
  const C = p.capitalSol;
  const base = { ...i, capitalSol: C, feesSol: 0, peakPct: 0, oorSinceTs: null, flipTvlUsd: null, flipTs: null };
  if (i.mode === 'B') {
    const n = p.ladderBins;
    const w = norm(weights(n)); // depth 0 (top bin) .. n-1: heavier deeper
    const solBins = w.map((x, d) => ({ k: -d, s: C * x }));
    return { ...base, phase: 'ladder', solBins, tokBins: [], lo: -(n - 1), hi: 0, gasPaidSol: p.exitCostGasSol };
  }
  // A: SOL half in bins -R..0 below the price, token half (bought with 0.5*C at the swap cost) in bins 1..R+1 above it
  const R = simBinRadius(i.binStep, p);
  const n = R + 1;
  const wS = norm(weights(n));
  const wT = norm(weights(n));
  const half = C / 2;
  const tokens = (half * (1 - p.exitCostPct / 100)) / i.entryPrice;
  return {
    ...base,
    phase: 'classic',
    solBins: wS.map((x, d) => ({ k: -d, s: half * x })),
    tokBins: wT.map((x, j) => ({ k: 1 + j, tau: tokens * x })),
    lo: -R,
    hi: R + 1,
    gasPaidSol: 2 * p.exitCostGasSol, // swap + deposit
  };
}

const exitCostSol = (tokenValueSol: number, p: SimParams) => (tokenValueSol * p.exitCostPct) / 100 + p.exitCostGasSol;

export interface StepResult {
  pos: SimPosition;
  exit: SimExit | null;
  /** the position flipped during this step */
  flipped: boolean;
}

/** Advance a position over the candles that started after `pos.lastTs` (any order). Pure: returns a new position. */
export function advanceSim(posIn: SimPosition, candlesIn: ShadowCandle[], ctx: StepContext, p: SimParams): StepResult {
  const pos: SimPosition = { ...posIn, solBins: [...posIn.solBins], tokBins: [...posIn.tokBins] };
  const candles = [...candlesIn].filter((c) => c.timestamp > pos.lastTs && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.timestamp - b.timestamp);
  let flipped = false;
  const C = pos.capitalSol;
  const exitCfg = p.exit;
  for (let idx = 0; idx < candles.length; idx++) {
    const c = candles[idx]!;
    const lastCandle = idx === candles.length - 1;
    const closeTs = c.timestamp + 300;
    const dtMin = Math.max((c.timestamp - pos.lastTs) / 60, 0) || 5;
    pos.lastTs = c.timestamp;
    const u = uOf(c.close, pos.entryPrice, pos.binStep);
    const ka = binOfU(u);
    const { valueSol, tokenValueSol } = valuePosition(pos, u);
    const inRange = ka >= pos.lo && ka <= pos.hi;
    if (inRange && pos.feeTvl24hPct !== null) pos.feesSol += valueSol * (pos.feeTvl24hPct / 100) * p.feeFactor * (dtMin / 1440);
    const cost = exitCostSol(tokenValueSol, p);
    const pnlPct = ((valueSol + pos.feesSol - cost - C) / C) * 100;
    pos.peakPct = Math.max(pos.peakPct, pnlPct);
    if (!inRange) pos.oorSinceTs ??= closeTs;
    else pos.oorSinceTs = null;
    const minutesOutOfRange = pos.oorSinceTs !== null ? (closeTs - pos.oorSinceTs) / 60 : null;
    const ageMinutes = (closeTs - pos.entryTs) / 60;
    const tokenBelow = !inRange && ka < pos.lo; // below the range: all token (ladder, A) / still all token waiting for the bounce (flip)
    const stopLoss = pnlPct <= -p.slPct ? `stop loss: cycle PnL ${pnlPct.toFixed(2)}% <= -${p.slPct}%` : null;

    let signal: string | null = null;
    if (stopLoss) signal = stopLoss;
    else if (pos.phase === 'flip') {
      signal = flipExitSignal(
        { isOutOfRange: !inRange, tokenBelowRange: tokenBelow, minutesOutOfRange, tvlUsd: lastCandle ? ctx.tvlUsd : null, flipTvlUsd: pos.flipTvlUsd },
        { oorAboveExitMin: p.flipOorAboveMin, tvlCollapsePct: p.flipTvlCollapsePct },
      );
    } else if (pos.mode === 'B' && tokenBelow) {
      // FLIP: the whole SOL side is token. Close the ladder and redeposit the tokens as an ask ladder above the OLD bottom (start = old bottom + 1 bin)
      const tokens = solValue(pos.solBins, u, (x) => priceOfU(x, pos.entryPrice, pos.binStep)).tokens;
      const n = p.ladderBins;
      const start = pos.lo + 1;
      const tau = norm(weights(n)).map((x) => tokens * x);
      pos.tokBins = tau.map((t, j) => ({ k: start + j, tau: t }));
      pos.solBins = [];
      pos.phase = 'flip';
      pos.lo = start;
      pos.hi = start + n - 1;
      pos.gasPaidSol += 2 * p.exitCostGasSol; // close + redeposit
      pos.flipTvlUsd = ctx.tvlUsd;
      pos.flipTs = closeTs;
      pos.oorSinceTs = null;
      flipped = true;
      continue;
    } else {
      const above = Math.max(ka - pos.hi, 0);
      signal = meridianExitSignal(
        { pnlPct, peakPnlPct: pos.peakPct, binsAbove: above, isOutOfRange: !inRange, minutesOutOfRange, feePerTvl24hPct: ageMinutes >= exitCfg.minAgeBeforeYieldCheckMin ? ctx.feeTvl24hPct : null, ageMinutes },
        exitCfg,
      );
      if (signal && trailingBlockedByFloor(signal, pnlPct, p.trailingFloorPct)) {
        pos.peakPct = pnlPct; // the dump outran the confirmation: keep the position and re-arm, as the bot does
        signal = null;
      }
    }
    if (!signal && closeTs - pos.entryTs >= p.maxHours * 3600) signal = `sim timeout: ${p.maxHours}h, closed at market (the real bot has no time stop)`;
    if (signal) {
      const pnlSol = valueSol + pos.feesSol - cost - C - pos.gasPaidSol;
      return {
        pos,
        flipped,
        exit: {
          ts: closeTs,
          price: c.close,
          reason: signal,
          pnlSol,
          pnlUsd: pos.solPriceUsd ? pnlSol * pos.solPriceUsd : null,
          pnlPct: (pnlSol / C) * 100,
          valueSol,
          feesSol: pos.feesSol,
          minutesHeld: (closeTs - pos.entryTs) / 60,
          flipped: pos.phase === 'flip',
        },
      };
    }
  }
  return { pos, exit: null, flipped };
}

/** One simulated position per pool at a time, and a cap on how many are open at once. */
export function canOpenSim(open: Pick<SimPosition, 'pool'>[], pool: string, maxOpen: number): boolean {
  return open.length < maxOpen && !open.some((p) => p.pool === pool);
}
