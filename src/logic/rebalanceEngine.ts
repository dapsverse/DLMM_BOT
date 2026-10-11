import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { env } from '../config/env.js';
import { LAMPORTS_PER_SOL } from '../config/constants.js';
import {
  getUserPositions,
  openPosition,
  closePositionFull,
  getActiveBin,
  type DlmmPool,
} from '../services/meteoraDLMM.js';
import { balanceTokenRatio, emergencySwapAllToSol, swapExactIn, WSOL_MINT } from '../services/jupiterSwap.js';
import { connection, getWalletSolBalance, getTokenBalance, waitForTokenBalance } from '../services/solana.js';
import { isPoolStillEligible, getCurrentPriceUsd, recordChaseGuardExit, type ScannerConfig } from '../services/meteoraScanner.js';
import { addToBlacklist, rangeCeilingProfitOverride } from './riskManager.js';
import { computeBinRadius } from './binRange.js';
import { computeOutOfRangeTracking } from './outOfRangeTracking.js';
import { logger } from '../utils/logger.js';
import type { PersistedPosition } from '../services/stateStore.js';

/**
 * ponytail: prices everything in SOL terms (not USD) so the engine needs no
 * external price feed for its own decisions — only the scanner talks to
 * DexScreener/Meteora for USD-denominated pool filters. Assumes one side of
 * the pool is WSOL, true for the memecoin-vs-SOL pools this bot targets.
 * Upgrade path if USDC-quoted pools are ever added: inject a SOL/USD price
 * source and convert at the edges instead of throughout the engine.
 */

export interface PoolContext {
  poolAddress: string;
  pool: DlmmPool;
  mintX: string;
  mintY: string;
  xIsSol: boolean; // true if mintX is WSOL, false if mintY is WSOL
  initialDepositSol: number;
  rebalanceTimestamps: number[];
  lastRebalanceAt: number;
  volume1hBaselineUsd: number;
  /** Epoch-ms volume1hBaselineUsd was last set (fresh entry, switch, or an Option-A periodic refresh — see env.VOLUME_BASELINE_REFRESH_MS/VOLUME_DROP_GRACE_MS). */
  volume1hBaselineSetAtMs: number;
  /** Pool's bin_step — constant for the pool's lifetime, used to derive the bin radius (see logic/binRange.ts). */
  binStep: number;
  /** Active bin id when the position was opened/last compounded. */
  centerBinId: number | null;
  /** When the position first went out-of-range (epoch ms) — null while in-range (subject to OUT_OF_RANGE_RESET_GRACE_MS debounce, see updateOutOfRangeTracking). */
  outOfRangeSinceMs: number | null;
  /** When the position most recently came BACK in-range (epoch ms) — null while out-of-range or while fully settled in-range. Only used to debounce outOfRangeSinceMs resets. */
  inRangeSinceMs: number | null;
  /** Highest unrealized profit % this position has ever reached, since openInitialPosition. Not reset on compoundCycle (initialDepositSol itself is never reset on compound either — this mirrors that existing basis). Reset only by starting a fresh PoolContext (new entry or switch). */
  peakProfitPct: number;
  /** Decimals of the non-SOL mint — fetched once at entry, used by otherTokenValueInSol so it converts raw token amounts correctly regardless of the mint's actual decimals (most memecoins use 6, NOT the 9 SOL/WSOL uses). */
  otherMintDecimals: number;
  /** Pool's own on-chain SOL-side reserve account — constant for the pool's lifetime, used by flowAnalysis.ts's getDollarVolumeBuyRatio for the held position's periodic dollar-flow check (index.ts). */
  reserveSolAccount: string;
}

/**
 * Decimals of an SPL mint — works for both the legacy Token program and
 * Token-2022 (getParsedAccountInfo's built-in parser handles either
 * transparently, no need to know which one up front). Found live
 * 2026-10-07 (real bot's first position): otherTokenValueInSol used to
 * hardcode LAMPORTS_PER_SOL (10^9) to convert the non-SOL side's raw
 * amount to a whole-token count, assuming it shared SOL's 9 decimals.
 * Most memecoins (this one included — a pump.fun Token-2022 mint) use 6
 * decimals, undercounting that side's value by 1000x — enough to make a
 * brand-new, healthy position read as "49.90% unrealized loss" within one
 * tick and get HARD_EXIT'd 16 seconds after opening.
 */
async function getMintDecimals(mint: string): Promise<number> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data;
  if (!parsed || typeof parsed !== 'object' || !('parsed' in parsed)) {
    throw new Error(`[rebalanceEngine] could not read decimals for mint ${mint} — unparseable account data`);
  }
  return (parsed as { parsed: { info: { decimals: number } } }).parsed.info.decimals;
}

/**
 * Converts a raw (not-yet-decimal-adjusted) token amount to its SOL value,
 * given that mint's own decimals and the SOL-per-whole-token price. Pure,
 * no I/O — exported for a self-check. Use the token's OWN decimals here,
 * never LAMPORTS_PER_SOL (SOL's decimals, 9) — see getMintDecimals's doc
 * comment for the live incident this fixes (most memecoins use 6).
 */
export function rawAmountToSol(rawAmount: BN, decimals: number, priceInSol: number): number {
  return (Number(rawAmount.toString()) / 10 ** decimals) * priceInSol;
}

/**
 * Splits a post-close non-SOL token balance into "swap to SOL" (principal)
 * and "keep as token" (fee) portions, instead of converting the whole
 * balance to SOL on every close. Discussed 2026-10-07/08 after watching a
 * real position (DARK-SOL) close with bin mechanics having ALREADY swept
 * nearly all of its principal into SOL as price rose — the tiny leftover
 * non-SOL balance was almost entirely fee, not principal. User's call: on
 * ANY close, deliberately leave the fee-sized portion of the non-SOL side
 * as raw token (their own choice when/whether to sell it) rather than
 * auto-dumping it into SOL — only the principal portion keeps recompounding
 * through currentCapitalSol. feeOtherRaw is read from the position's own
 * positionData.feeX/feeY BEFORE closing (see getPositionHealthSnapshot for
 * the same pattern) — already-correct raw units, same basis as
 * totalXAmount/totalYAmount, no new unit-conversion risk. Clamped so it
 * never tries to keep more than what's actually in the wallet (e.g. a tiny
 * amount of extra fee can accrue between reading feeOtherRaw and the close
 * tx landing — that goes into toSwap, not toKeepAsToken, erring toward
 * swapping slightly more rather than keeping slightly more). Pure, no I/O —
 * exported for a self-check.
 */
export function splitFeeFromOtherBalance(feeOtherRaw: BN, totalOtherRaw: BN): { toSwap: BN; toKeepAsToken: BN } {
  const toKeepAsToken = BN.min(feeOtherRaw, totalOtherRaw);
  const toSwap = totalOtherRaw.sub(toKeepAsToken);
  return { toSwap, toKeepAsToken };
}

/** Non-SOL token amount, expressed in SOL, using the pool's active-bin price. */
async function otherTokenValueInSol(ctx: PoolContext, otherAmount: BN): Promise<number> {
  if (otherAmount.lten(0)) return 0;
  const activeBin = await getActiveBin(ctx.pool);
  const pricePerToken = Number(activeBin.pricePerToken); // price of X in terms of Y
  const priceOtherInSol = ctx.xIsSol ? 1 / pricePerToken : pricePerToken;
  return rawAmountToSol(otherAmount, ctx.otherMintDecimals, priceOtherInSol);
}

export function isCooldownActive(ctx: PoolContext, now = Date.now()): boolean {
  return now - ctx.lastRebalanceAt < env.REBALANCE_COOLDOWN_MS;
}

export interface BinRangeStatus {
  currentBinId: number;
  isOutOfRange: boolean;
}

/**
 * Live bin-range check against the position's own DLMM pool object — reuses
 * ctx.pool (already held, no wallet involved in this read) rather than
 * spinning up a fresh DLMM instance like rpc.ts's getActiveBinId does for
 * the wallet-free callers (paper-trade, scanner).
 */
export async function getBinRangeStatus(ctx: PoolContext): Promise<BinRangeStatus> {
  const activeBin = await getActiveBin(ctx.pool);
  const radius = computeBinRadius(ctx.binStep);
  const isOutOfRange = ctx.centerBinId === null || Math.abs(activeBin.binId - ctx.centerBinId) > radius;
  return { currentBinId: activeBin.binId, isOutOfRange };
}

/** Call once per health-check tick to keep ctx.outOfRangeSinceMs/inRangeSinceMs accurate (debounced — see logic/outOfRangeTracking.ts, shared with paper-trade). */
export function updateOutOfRangeTracking(ctx: PoolContext, isOutOfRange: boolean, now = Date.now()): void {
  const next = computeOutOfRangeTracking(ctx, isOutOfRange, now);
  ctx.outOfRangeSinceMs = next.outOfRangeSinceMs;
  ctx.inRangeSinceMs = next.inRangeSinceMs;
}

export interface PositionHealthSnapshot {
  currentValueSol: number;
  unclaimedFeesSol: number;
}

/** Reads the live open position and prices principal + unclaimed fees in SOL. */
export async function getPositionHealthSnapshot(ctx: PoolContext): Promise<PositionHealthSnapshot> {
  const [position] = await getUserPositions(ctx.pool);
  if (!position) return { currentValueSol: 0, unclaimedFeesSol: 0 };

  const { totalXAmount, totalYAmount, feeX, feeY } = position.positionData;
  const principalSolSide = new BN(ctx.xIsSol ? totalXAmount : totalYAmount);
  const principalOtherSide = new BN(ctx.xIsSol ? totalYAmount : totalXAmount);
  const feeSolSide = new BN(ctx.xIsSol ? feeX : feeY);
  const feeOtherSide = new BN(ctx.xIsSol ? feeY : feeX);

  const [principalOtherSol, feeOtherSol] = await Promise.all([
    otherTokenValueInSol(ctx, principalOtherSide),
    otherTokenValueInSol(ctx, feeOtherSide),
  ]);

  const currentValueSol = Number(principalSolSide.toString()) / LAMPORTS_PER_SOL + principalOtherSol;
  const unclaimedFeesSol = Number(feeSolSide.toString()) / LAMPORTS_PER_SOL + feeOtherSol;

  return { currentValueSol, unclaimedFeesSol };
}


/** PoolContext -> persistable form (drops the SDK pool handle). */
export function positionToPersisted(ctx: PoolContext): PersistedPosition {
  const { pool: _pool, ...rest } = ctx;
  return { ...rest, rebalanceTimestamps: [...ctx.rebalanceTimestamps] };
}

/** Persisted bookkeeping + a freshly opened SDK pool handle -> live PoolContext. */
export function contextFromPersisted(pos: PersistedPosition, pool: DlmmPool): PoolContext {
  return { ...pos, rebalanceTimestamps: [...pos.rebalanceTimestamps], pool };
}

/**
 * Boot fallback when no usable state describes an open position (first run of the persistence feature,
 * deleted/corrupt state file): rebuild a PoolContext from on-chain pair state alone. The deposit basis
 * (stop-loss / take-profit) cannot be known, so it is set to the position's CURRENT value + unclaimed fees
 * and peak profit restarts at 0 — callers must log this loudly. Never opens or closes anything.
 */
export async function rebuildContextFromChain(pool: DlmmPool, poolAddress: string): Promise<PoolContext> {
  const mintX = pool.lbPair.tokenXMint.toBase58();
  const mintY = pool.lbPair.tokenYMint.toBase58();
  const xIsSol = mintX === WSOL_MINT;
  if (!xIsSol && mintY !== WSOL_MINT) throw new Error(`[rebalanceEngine] pool ${poolAddress} has no SOL side — cannot rebuild context`);
  const otherMint = xIsSol ? mintY : mintX;
  const ctx: PoolContext = {
    poolAddress,
    pool,
    mintX,
    mintY,
    xIsSol,
    initialDepositSol: 0,
    rebalanceTimestamps: [],
    lastRebalanceAt: 0,
    volume1hBaselineUsd: 0,
    volume1hBaselineSetAtMs: 0,
    binStep: pool.lbPair.binStep,
    centerBinId: null,
    outOfRangeSinceMs: null,
    inRangeSinceMs: null,
    peakProfitPct: 0,
    otherMintDecimals: await getMintDecimals(otherMint),
    reserveSolAccount: (xIsSol ? pool.lbPair.reserveX : pool.lbPair.reserveY).toBase58(),
  };
  const { currentValueSol, unclaimedFeesSol } = await getPositionHealthSnapshot(ctx);
  ctx.initialDepositSol = currentValueSol + unclaimedFeesSol;
  return ctx;
}

export { estimateCycleGasCostSol } from './costEstimate.js';
import { estimateBinRentSol } from './costEstimate.js';

// claimFeesOnly (fee-threshold REBALANCE while still in-range) removed
// 2026-09-26 — see riskManager.ts's removal note. Fees are now only ever
// realized as part of an already-necessary transaction (compoundCycle's
// close+reopen, or an exit) — closePositionFull below claims fees as part
// of closing, no separate claim step needed.

/**
 * Full compound cycle: close position (claim fees + reclaim rent), then
 * either —
 *  - the pool still passes the entry screen: rebalance 50:50 and reopen a
 *    fresh position here at the new active bin (the normal auto-compound
 *    path), or
 *  - it no longer does (e.g. no longer trending, degraded liquidity):
 *    convert everything to SOL and return null instead of reopening —
 *    caller should treat this like a freed-up slot and scan for a
 *    different pool next tick. Not a violation (no blacklist), the pool
 *    just isn't the best home for this capital right now.
 * Only called for the idle-forced case (out-of-range too long) or when the
 * pool needs a fresh screen check — a fee-threshold rebalance while still
 * in-range goes through claimFeesOnly instead (see above), never here.
 * currentProfitPct (caller-computed, same basis as evaluatePosition's
 * peakProfitPct — see index.ts) enables the 'range' mode profit-aware
 * override below; defaults to 0 (no override) for any caller that doesn't
 * track it.
 */

/**
 * Equity-scaled gas reserve — max(MIN_GAS_RESERVE_SOL floor,
 * equitySol * MIN_GAS_RESERVE_PCT/100). Idea borrowed 2026-10-08 from
 * comparing against CryptoGnome/dlmmbot's reserveSol(): a flat reserve
 * value goes stale as the wallet's actual balance drifts — this project
 * manually re-tuned MIN_GAS_RESERVE_SOL by hand after nearly every restart
 * the night real money went live. Pure, no I/O — exported for a self-check.
 */
/**
 * Rent for the new position account + ATAs, paid from the wallet ON TOP of
 * the deposit (InitializePosition). Found live 2026-10-08 (live-1791441428):
 * a ~0.03 SOL gas reserve was smaller than this rent, so every entry died in
 * simulation with "Transfer: insufficient lamports X, need X+13.4M" AFTER
 * the pre-swap had already landed — 10 swap/rollback round trips, ~0.146 SOL
 * lost to spread. Measured from the failed sims' own numbers: 0.0434 SOL on 19 of 20, 0.0582 on one (wider position — rent scales with bin count), so 0.07 keeps ~0.012 headroom over the worst seen. Position rent is refundable on close.
 */
export const POSITION_RENT_BUFFER_SOL = 0.07;

export function computeGasReserveSol(equitySol: number): number {
  return Math.max(env.MIN_GAS_RESERVE_SOL, equitySol * (env.MIN_GAS_RESERVE_PCT / 100));
}

/**
 * Subtracts the equity-scaled gas reserve (computeGasReserveSol) from
 * whichever side is SOL before a deposit — a fresh on-chain balance query
 * for the SOL side includes the gas/slippage reserve, which must stay
 * untouched. The SOL-side balance passed in doubles as the equity figure
 * for the reserve calc (this bot holds no SOL anywhere else). Shared by
 * openInitialPosition and compoundCycle so both compute this identically
 * (pulled out 2026-10-07 after openInitialPosition was found to be missing
 * this entirely — see its own doc comment for the live incident). Pure,
 * no I/O — exported for a self-check.
 */
export function reserveGasFromSolSide(balX: BN, balY: BN, xIsSol: boolean): { depositX: BN; depositY: BN } {
  const solBalanceLamports = xIsSol ? balX : balY;
  const equitySol = Number(solBalanceLamports.toString()) / LAMPORTS_PER_SOL;
  const reserveLamports = new BN(Math.round((computeGasReserveSol(equitySol) + POSITION_RENT_BUFFER_SOL) * LAMPORTS_PER_SOL));
  const depositX = xIsSol ? BN.max(balX.sub(reserveLamports), new BN(0)) : balX;
  const depositY = xIsSol ? balY : BN.max(balY.sub(reserveLamports), new BN(0));
  return { depositX, depositY };
}
/**
 * Caps the SOL-side deposit at `maxSolLamports`. openInitialPosition used to deposit the WHOLE wallet SOL
 * (minus reserve) while ctx.initialDepositSol was only `capitalSol` — after a restart with a bigger wallet the
 * basis (stop-loss %, take-profit tiers, profit %) was understated vs the real deposit (2QxYG3, 2026-10-11:
 * basis 1.0 vs ~1.236 deposited). Pure, exported for a self-check.
 */
export function capSolDeposit(depositX: BN, depositY: BN, xIsSol: boolean, maxSolLamports: BN): { depositX: BN; depositY: BN } {
  const cap = BN.max(maxSolLamports, new BN(0));
  return { depositX: xIsSol ? BN.min(depositX, cap) : depositX, depositY: xIsSol ? depositY : BN.min(depositY, cap) };
}

/**
 * SOL that entered the position from OUTSIDE it during a compound (idle wallet SOL, a top-up) — everything
 * deployed beyond what the closed position was worth. Added to the deposit basis so profit/stop-loss keep
 * measuring the position's own performance. Returns 0 within a noise band (friction, price move between
 * the two reads). `spendableSol` is wallet SOL minus the gas reserve; the position rent that the reopen
 * will pay on top is subtracted here. Pure, exported for a self-check.
 */
export function externalCapitalSol(spendableSol: number, otherValueSol: number, preCloseTotalSol: number): number {
  const deployable = spendableSol - POSITION_RENT_BUFFER_SOL + otherValueSol;
  const ext = deployable - preCloseTotalSol;
  return ext > 0.03 + 0.02 * preCloseTotalSol ? ext : 0;
}

export async function compoundCycle(ctx: PoolContext, scannerConfig: ScannerConfig, currentProfitPct = 0): Promise<PoolContext | null> {
  const [position] = await getUserPositions(ctx.pool);
  if (!position) throw new Error(`[rebalanceEngine] no open position found for pool ${ctx.poolAddress}`);

  // Read BEFORE closing. feeOtherRaw: see splitFeeFromOtherBalance's doc
  // comment, only used if this cycle ends up abandoning the pool (the
  // normal reopen path keeps 100% of principal+fee in LP). expectedOtherAmount
  // (principal+fee combined, the OTHER side's full pre-close claimable
  // total): used as waitForTokenBalance's threshold right below — see its
  // doc comment for the live incident (BATON-SOL, 2026-10-08) this fixes:
  // reading the other-side balance immediately after closePositionFull,
  // with no staleness guard, returned a STALE near-zero value (7 raw units)
  // instead of the TRUE post-close balance (8712+ whole tokens) — the
  // same read-after-write RPC race waitForTokenBalance already fixed for
  // the entry/rebalance-swap paths, just never applied to THIS read site.
  const { feeX, feeY, totalXAmount, totalYAmount } = position.positionData;
  const feeOtherRaw = new BN(ctx.xIsSol ? feeY : feeX);
  const expectedOtherAmount = new BN(ctx.xIsSol ? totalYAmount : totalXAmount).add(feeOtherRaw);

  const preClose = await getPositionHealthSnapshot(ctx); // for the external-capital check after the close
  logger.info('[rebalanceEngine] closing position for compound cycle', { pool: ctx.poolAddress });
  await closePositionFull(ctx.pool, position);

  const { eligible: eligibleRaw, reasons: rejectionReasons } = await isPoolStillEligible(ctx.poolAddress, scannerConfig);
  // Profit-aware override for 'range' mode — see rangeCeilingProfitOverride
  // (riskManager.ts) and RANGE_CEILING_PROFIT_OVERRIDE_PCT (env.ts) for the
  // full rationale/incident. A held range position that fails re-screen
  // ONLY on the volatility ceiling (started trending, nothing actually went
  // wrong) shouldn't get abandoned mid-pump before the trailing-take-profit
  // tiers ever get a chance to arm.
  const rangeProfitOverride = rangeCeilingProfitOverride(rejectionReasons, scannerConfig.entryStrategyMode, currentProfitPct);
  const stillEligible = eligibleRaw || rangeProfitOverride;
  if (rangeProfitOverride) {
    logger.info('[rebalanceEngine] range-ceiling profit override — recentering instead of leaving', {
      pool: ctx.poolAddress,
      currentProfitPct,
      rejectionReasons,
    });
  }

  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const solSideMint = ctx.xIsSol ? ctx.mintX : ctx.mintY;
  const [otherAmount, solSideAmount] = await Promise.all([
    expectedOtherAmount.gtn(0) ? waitForTokenBalance(otherMint, expectedOtherAmount.muln(95).divn(100)) : getTokenBalance(otherMint),
    getTokenBalance(solSideMint),
  ]);
  const balX = ctx.xIsSol ? solSideAmount : otherAmount;
  const balY = ctx.xIsSol ? otherAmount : solSideAmount;

  if (!stillEligible) {
    logger.info('[rebalanceEngine] pool no longer passes entry screen — converting to SOL for a fresh scan', {
      pool: ctx.poolAddress,
      reasons: rejectionReasons,
    });
    // Short cooldown (LEFT_POOL_COOLDOWN_MS), not the long HARD_EXIT
    // blacklist — see env.ts doc comment: without even a short cooldown, a
    // pool that just failed re-screen but is still top-ranked gets
    // re-entered next tick, whipsawing (confirmed live in paper-trade).
    addToBlacklist(scannerConfig.blacklistPools, ctx.poolAddress, Date.now(), env.LEFT_POOL_COOLDOWN_MS);
    await recordExitForChaseGuard(ctx, scannerConfig.chaseGuardPools);
    const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(feeOtherRaw, otherAmount);
    if (toKeepAsToken.gtn(0)) {
      logger.info('[rebalanceEngine] keeping fee portion as token, user\'s call to sell manually', {
        pool: ctx.poolAddress,
        otherMint,
        keptRaw: toKeepAsToken.toString(),
      });
    }
    if (toSwap.gtn(0)) await emergencySwapAllToSol(otherMint, toSwap);
    return null;
  }

  const solBalance = await getWalletSolBalance();
  const reserveLamports = new BN(Math.round(computeGasReserveSol(solBalance) * LAMPORTS_PER_SOL));
  const solAmount = ctx.xIsSol ? balX : balY;
  const spendableSolLamports = BN.max(solAmount.sub(reserveLamports), new BN(0));
  const otherValueSol = await otherTokenValueInSol(ctx, otherAmount);

  logger.info('[rebalanceEngine] post-close balances', {
    solBalance,
    spendableSol: spendableSolLamports.toString(),
    otherAmount: otherAmount.toString(),
    otherValueSolEstimate: otherValueSol,
  });

  const externalSol = externalCapitalSol(Number(spendableSolLamports.toString()) / LAMPORTS_PER_SOL, otherValueSol, preClose.currentValueSol + preClose.unclaimedFeesSol);
  if (externalSol > 0) {
    logger.warn('[rebalanceEngine] capital beyond the closed position is being deployed (idle wallet SOL / top-up) — raising deposit basis', {
      pool: ctx.poolAddress,
      externalSol,
      basisBefore: ctx.initialDepositSol,
    });
    ctx.initialDepositSol += externalSol;
  }

  await balanceTokenRatio({
    mintX: ctx.mintX,
    mintY: ctx.mintY,
    amountX: balX,
    amountY: balY,
    valueXUsd: ctx.xIsSol ? Number(spendableSolLamports.toString()) / LAMPORTS_PER_SOL : otherValueSol,
    valueYUsd: ctx.xIsSol ? otherValueSol : Number(spendableSolLamports.toString()) / LAMPORTS_PER_SOL,
  });

  // Re-check balances after swap before reopening.
  const [freshX, freshY] = await Promise.all([getTokenBalance(ctx.mintX), getTokenBalance(ctx.mintY)]);
  const radius = computeBinRadius(ctx.binStep);
  const { depositX, depositY } = reserveGasFromSolSide(freshX, freshY, ctx.xIsSol);

  // binRadius only (not a precomputed minBinId/maxBinId) — openPosition
  // fetches the active bin itself, FRESH, inside its own retry loop. See
  // its doc comment: reusing a bin range computed once outside the retry
  // loop is what caused repeated ExceededBinSlippageTolerance failures
  // during fast price moves (confirmed live 2026-10-07, DARK-SOL).
  let result;
  try {
    result = await openPosition({ pool: ctx.pool, totalXAmount: depositX, totalYAmount: depositY, binRadius: radius });
  } catch (err) {
    // The old position is already closed and balanceTokenRatio already swapped ~half into the
    // token: without this rollback that token sits in the wallet untracked (live 2026-10-09,
    // BATON-SOL, ~0.6 SOL stuck, kill-switch tripped). Same pattern as openInitialPosition.
    const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
    logger.error('[rebalanceEngine] reopen failed after rebalance swap — swapping token balance back to SOL', {
      pool: ctx.poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const stuck = await getTokenBalance(otherMint);
      if (stuck.gtn(0)) await emergencySwapAllToSol(otherMint, stuck);
    } catch (swapBackErr) {
      logger.error('[rebalanceEngine] reopen rollback swap-back ALSO failed — token stuck in wallet', {
        otherMint,
        error: swapBackErr instanceof Error ? swapBackErr.message : String(swapBackErr),
      });
    }
    throw err;
  }

  const now = Date.now();
  ctx.rebalanceTimestamps.push(now);
  ctx.lastRebalanceAt = now;
  ctx.centerBinId = result.centerBinId;
  ctx.outOfRangeSinceMs = null;
  ctx.inRangeSinceMs = null;
  logger.info('[rebalanceEngine] compound cycle complete', {
    pool: ctx.poolAddress,
    estBinRentSol: estimateBinRentSol(radius),
  });
  return ctx;
}

/**
 * First-time entry into a freshly picked pool: starting from pure SOL
 * capital, swaps half into the pool's non-SOL side, then opens the initial
 * position around the current active bin.
 */
export async function openInitialPosition(
  pool: DlmmPool,
  poolAddress: string,
  mintX: string,
  mintY: string,
  xIsSol: boolean,
  capitalSol: number,
  binStep: number,
  reserveSolAccount: string,
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  // Pre-flight BEFORE any swap: a failure after the swap costs a full round-trip of spread.
  // capitalSol may already be wallet-minus-reserve (nextCapital after an exit), so cap it by what the
  // wallet can really fund instead of adding the reserve on top again.
  const walletSol = await getWalletSolBalance();
  const maxFundableSol = walletSol - computeGasReserveSol(walletSol) - POSITION_RENT_BUFFER_SOL;
  const effectiveCapitalSol = Math.min(capitalSol, maxFundableSol);
  if (effectiveCapitalSol < capitalSol * 0.9) {
    throw new Error(`[rebalanceEngine] wallet ${walletSol} SOL can fund only ${Math.max(0, effectiveCapitalSol).toFixed(4)} SOL < 90% of requested ${capitalSol} (after gas reserve + position rent) — skipping entry before swap`);
  }
  if (effectiveCapitalSol < capitalSol) {
    logger.warn('[rebalanceEngine] capital capped by wallet funds', { requested: capitalSol, effectiveCapitalSol });
  }
  capitalSol = effectiveCapitalSol;
  const tokenShareLamports = new BN(Math.round((capitalSol * LAMPORTS_PER_SOL * env.TOKEN_SHARE_PCT) / 100)); // SOL swapped into the token (50 = half)
  const otherMintDecimals = await getMintDecimals(otherMint);

  logger.info('[rebalanceEngine] opening initial position', { poolAddress, capitalSol, otherMintDecimals });
  const swapResult = await swapExactIn(WSOL_MINT, otherMint, tokenShareLamports);

  // Don't trust a single immediate balance read after the swap — see
  // waitForTokenBalance's doc comment for the live incident (a stale read
  // here silently deposited 0 of the non-SOL side, producing a SOL-only
  // position that then correctly-but-confusingly read as "50% down").
  // 95% of the swap's own expected outAmount as the threshold — leaves
  // room for quote-vs-actual slippage without masking a genuinely stale 0.
  const expectedOtherAmount = new BN(swapResult.outAmount).muln(95).divn(100);
  await waitForTokenBalance(otherMint, expectedOtherAmount);

  const [balX, balY] = await Promise.all([getTokenBalance(mintX), getTokenBalance(mintY)]);
  const radius = computeBinRadius(binStep);

  // Reserve MIN_GAS_RESERVE_SOL on the SOL side before depositing — balX/balY
  // above is the FULL on-chain balance, which for the SOL side includes the
  // gas/slippage reserve that must stay untouched. compoundCycle already
  // did this correctly; this path (first-ever entry) didn't, and it was
  // never exercised until the real bot's first live run (2026-10-07) —
  // confirmed live: it tried to deposit the ENTIRE wallet SOL balance,
  // leaving nothing for rent/fees, and failed simulation with "insufficient
  // lamports". See reserveGasFromSolSide's doc comment.
  const reserved = reserveGasFromSolSide(balX, balY, xIsSol);
  // Deposit only the SOL that belongs to this entry (capital minus what was swapped into the token), not the whole wallet.
  const capped = capSolDeposit(reserved.depositX, reserved.depositY, xIsSol, new BN(Math.round(capitalSol * LAMPORTS_PER_SOL)).sub(tokenShareLamports));
  const { depositX, depositY } = capped;

  const ctx: PoolContext = {
    poolAddress,
    pool,
    mintX,
    mintY,
    xIsSol,
    initialDepositSol: capitalSol,
    rebalanceTimestamps: [],
    lastRebalanceAt: 0,
    volume1hBaselineUsd: 0,
    volume1hBaselineSetAtMs: 0, // placeholder — index.ts sets the real value right after this call, alongside volume1hBaselineUsd
    binStep,
    centerBinId: null, // set from openPosition's actual result below — see its doc comment for why it's fetched fresh inside the retry loop, not precomputed here
    outOfRangeSinceMs: null,
    inRangeSinceMs: null,
    peakProfitPct: 0,
    otherMintDecimals,
    reserveSolAccount,
  };

  try {
    const result = await openPosition({ pool, totalXAmount: depositX, totalYAmount: depositY, binRadius: radius });
    ctx.centerBinId = result.centerBinId;
  } catch (err) {
    // Found live 2026-10-07 (real bot's first entry attempt): the swap above
    // already landed before this point — if openPosition then fails (e.g.
    // the InvalidRealloc bug this same session found, or any other
    // simulation/send failure), the swapped-into otherMint balance used to
    // just sit in the wallet with no rollback, un-tracked by
    // currentCapitalSol, a real stuck-funds state (confirmed live: ~half
    // capital sat as 11538 tokens of an abandoned pool's mint until manually
    // swapped back). Best-effort swap it straight back to SOL before
    // rethrowing, so a failed entry always leaves the wallet in the same
    // all-SOL state it started in.
    logger.error('[rebalanceEngine] openPosition failed after swap — swapping stuck balance back to SOL', {
      poolAddress,
      otherMint,
      error: err instanceof Error ? err.message : String(err),
    });
    const stuckBalance = await getTokenBalance(otherMint);
    if (stuckBalance.gtn(0)) {
      try {
        await emergencySwapAllToSol(otherMint, stuckBalance);
      } catch (swapBackErr) {
        logger.error('[rebalanceEngine] rollback swap-back ALSO failed — funds remain stuck, manual intervention needed', {
          otherMint,
          stuckBalance: stuckBalance.toString(),
          error: swapBackErr instanceof Error ? swapBackErr.message : String(swapBackErr),
        });
      }
    }
    throw err;
  }
  logger.info('[rebalanceEngine] initial position opened', { poolAddress, estBinRentSol: estimateBinRentSol(radius) });
  return ctx;
}

/**
 * Closes the current position (claim fees + reclaim rent) and converts
 * everything to SOL. Shared by executeHardExit (adds a blacklist after)
 * and executeCleanExit (no blacklist - used by SWITCH and TAKE_PROFIT,
 * neither of which are risk violations).
 */
async function closeAndConvertToSol(ctx: PoolContext, logPrefix: string): Promise<number> {
  const [position] = await getUserPositions(ctx.pool);
  let feeOtherRaw = new BN(0);
  let expectedOtherAmount = new BN(0);
  if (position) {
    // Read BEFORE closing. feeOtherRaw: see splitFeeFromOtherBalance's doc
    // comment. expectedOtherAmount (principal+fee, the OTHER side's full
    // pre-close claimable total): waitForTokenBalance's threshold below —
    // see its doc comment in compoundCycle for the live incident
    // (BATON-SOL, 2026-10-08) this fixes: reading the other-side balance
    // immediately after closePositionFull, with no staleness guard,
    // returned a STALE near-zero value instead of the TRUE post-close
    // balance, leaving thousands of dollars of tokens un-swapped and
    // un-tracked.
    const { feeX, feeY, totalXAmount, totalYAmount } = position.positionData;
    feeOtherRaw = new BN(ctx.xIsSol ? feeY : feeX);
    expectedOtherAmount = new BN(ctx.xIsSol ? totalYAmount : totalXAmount).add(feeOtherRaw);
    logger.warn(`[rebalanceEngine] ${logPrefix}: closing position`, { pool: ctx.poolAddress });
    await closePositionFull(ctx.pool, position);
  }

  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const otherAmount = expectedOtherAmount.gtn(0)
    ? await waitForTokenBalance(otherMint, expectedOtherAmount.muln(95).divn(100))
    : await getTokenBalance(otherMint);
  const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(feeOtherRaw, otherAmount);
  if (toKeepAsToken.gtn(0)) {
    logger.info(`[rebalanceEngine] ${logPrefix}: keeping fee portion as token, user's call to sell manually`, {
      pool: ctx.poolAddress,
      otherMint,
      keptRaw: toKeepAsToken.toString(),
    });
  }
  if (toSwap.gtn(0)) {
    try {
      await emergencySwapAllToSol(otherMint, toSwap);
    } catch (err) {
      // Found live 2026-10-07 (real bot's first SWITCH): a transient
      // RPC/Jupiter hiccup here (quote 5xx, blockhash expiry under load)
      // used to throw all the way up through executeHardExit/
      // executeCleanExit — but closePositionFull above had ALREADY
      // succeeded on-chain (irreversible) by this point. index.ts has no
      // try/catch around its executeHardExit/executeCleanExit calls, so the
      // throw left currentPool still pointing at the now-closed position —
      // every subsequent tick's health check then read currentValueSol as 0
      // (no position found) and misread it as a 100% loss, looping
      // HARD_EXIT/blacklist/retry on a pool with no position left, for 5
      // minutes until a retry's own swap attempt happened to succeed.
      // Swallow here instead: the position close is the irreversible step
      // that matters for state tracking; a leftover unconverted token
      // balance is a smaller, recoverable problem, not worth corrupting
      // currentPool/currentCapitalSol over.
      logger.error(`[rebalanceEngine] ${logPrefix}: leftover-token swap-back failed, continuing with SOL-only balance`, {
        pool: ctx.poolAddress,
        otherMint,
        stuckAmount: toSwap.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const solBalance = await getWalletSolBalance();
  const nextCapital = Math.max(solBalance - computeGasReserveSol(solBalance), 0);
  logger.warn(`[rebalanceEngine] ${logPrefix} complete`, { pool: ctx.poolAddress, solBalance, nextCapital });
  return nextCapital;
}

/** Records this exit's price against the chase guard (see ScannerConfig.chaseGuardPools) — also logs the exit price (null = pool outside the top-200 window); best-effort, a failed price lookup just skips arming the guard rather than blocking the exit. */
async function recordExitForChaseGuard(ctx: PoolContext, chaseGuardPools: Map<string, number>): Promise<void> {
  const mint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const exitPriceUsd = await getCurrentPriceUsd(ctx.poolAddress);
  logger.info('[rebalanceEngine] exit price', { pool: ctx.poolAddress, mint, exitPriceUsd });
  if (exitPriceUsd !== null) recordChaseGuardExit(chaseGuardPools, mint, exitPriceUsd);
}

/**
 * Hard-exit flow: close position, dump 100% of the non-SOL side to SOL,
 * blacklist the pool for BLACKLIST_DURATION_MS, and return the leftover SOL
 * capital available for the next pool.
 */
export async function executeHardExit(ctx: PoolContext, blacklistPools: Map<string, number>, chaseGuardPools: Map<string, number>): Promise<number> {
  addToBlacklist(blacklistPools, ctx.poolAddress);
  await recordExitForChaseGuard(ctx, chaseGuardPools);
  return closeAndConvertToSol(ctx, 'HARD_EXIT');
}

/**
 * Close position and convert to SOL WITHOUT blacklisting - used for both
 * SWITCH (leaving to chase a better opportunity) and TAKE_PROFIT (locking
 * in gains). Neither is a risk violation, so the pool stays a fully valid
 * candidate for the very next scan.
 */
export async function executeCleanExit(ctx: PoolContext, reason: 'SWITCH' | 'TAKE_PROFIT', chaseGuardPools: Map<string, number>): Promise<number> {
  await recordExitForChaseGuard(ctx, chaseGuardPools);
  return closeAndConvertToSol(ctx, reason);
}
