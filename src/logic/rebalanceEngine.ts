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
import { connection, wallet, getWalletSolBalance } from '../services/solana.js';
import { isPoolStillEligible, type ScannerConfig } from '../services/meteoraScanner.js';
import { addToBlacklist } from './riskManager.js';
import { computeBinRadius } from './binRange.js';
import { logger } from '../utils/logger.js';

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
  /** Pool's bin_step — constant for the pool's lifetime, used to derive the bin radius (see logic/binRange.ts). */
  binStep: number;
  /** Active bin id when the position was opened/last compounded. */
  centerBinId: number | null;
  /** When the position first went out-of-range (epoch ms) — null while in-range. */
  outOfRangeSinceMs: number | null;
}

async function getTokenBalance(mint: string): Promise<BN> {
  if (mint === WSOL_MINT) {
    const lamports = await connection.getBalance(wallet.publicKey);
    return new BN(lamports);
  }
  const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  const total = resp.value.reduce((sum, acc) => {
    const amount = acc.account.data.parsed.info.tokenAmount.amount as string;
    return sum.add(new BN(amount));
  }, new BN(0));
  return total;
}

/** Non-SOL token amount, expressed in SOL, using the pool's active-bin price. */
async function otherTokenValueInSol(ctx: PoolContext, otherAmount: BN): Promise<number> {
  if (otherAmount.lten(0)) return 0;
  const activeBin = await getActiveBin(ctx.pool);
  const pricePerToken = Number(activeBin.pricePerToken); // price of X in terms of Y
  const priceOtherInSol = ctx.xIsSol ? 1 / pricePerToken : pricePerToken;
  // NOTE: assumes both tokens use standard decimals already baked into pricePerToken
  // by the SDK. Verify against actual mint decimals before trusting on mainnet.
  return (Number(otherAmount.toString()) / LAMPORTS_PER_SOL) * priceOtherInSol;
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

/** Call once per health-check tick to keep ctx.outOfRangeSinceMs accurate (set on first out-of-range tick, cleared once back in range). */
export function updateOutOfRangeTracking(ctx: PoolContext, isOutOfRange: boolean, now = Date.now()): void {
  if (isOutOfRange && ctx.outOfRangeSinceMs === null) {
    ctx.outOfRangeSinceMs = now;
  } else if (!isOutOfRange) {
    ctx.outOfRangeSinceMs = null;
  }
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

export { estimateCycleGasCostSol } from './costEstimate.js';

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
 * This runs for BOTH a fee-threshold-triggered rebalance and an
 * idle-forced one (out-of-range too long while in profit) — same
 * mechanical action either way, `reasons` is just why riskManager decided
 * to trigger it.
 */
export async function compoundCycle(ctx: PoolContext, scannerConfig: ScannerConfig): Promise<PoolContext | null> {
  const [position] = await getUserPositions(ctx.pool);
  if (!position) throw new Error(`[rebalanceEngine] no open position found for pool ${ctx.poolAddress}`);

  logger.info('[rebalanceEngine] closing position for compound cycle', { pool: ctx.poolAddress });
  await closePositionFull(ctx.pool, position);

  const stillEligible = await isPoolStillEligible(ctx.poolAddress, scannerConfig);

  const [balX, balY] = await Promise.all([getTokenBalance(ctx.mintX), getTokenBalance(ctx.mintY)]);
  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const otherAmount = ctx.xIsSol ? balY : balX;

  if (!stillEligible) {
    logger.info('[rebalanceEngine] pool no longer passes entry screen — converting to SOL for a fresh scan', {
      pool: ctx.poolAddress,
    });
    if (otherAmount.gtn(0)) await emergencySwapAllToSol(otherMint, otherAmount);
    return null;
  }

  const solBalance = await getWalletSolBalance();
  const reserveLamports = new BN(Math.round(env.MIN_GAS_RESERVE_SOL * LAMPORTS_PER_SOL));
  const solAmount = ctx.xIsSol ? balX : balY;
  const spendableSolLamports = BN.max(solAmount.sub(reserveLamports), new BN(0));
  const otherValueSol = await otherTokenValueInSol(ctx, otherAmount);

  logger.info('[rebalanceEngine] post-close balances', {
    solBalance,
    spendableSol: spendableSolLamports.toString(),
    otherAmount: otherAmount.toString(),
    otherValueSolEstimate: otherValueSol,
  });

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
  const activeBin = await getActiveBin(ctx.pool);
  const radius = computeBinRadius(ctx.binStep);
  const minBinId = activeBin.binId - radius;
  const maxBinId = activeBin.binId + radius;

  const depositX = ctx.xIsSol ? BN.max(freshX.sub(reserveLamports), new BN(0)) : freshX;
  const depositY = ctx.xIsSol ? freshY : BN.max(freshY.sub(reserveLamports), new BN(0));

  await openPosition({ pool: ctx.pool, totalXAmount: depositX, totalYAmount: depositY, minBinId, maxBinId });

  const now = Date.now();
  ctx.rebalanceTimestamps.push(now);
  ctx.lastRebalanceAt = now;
  ctx.centerBinId = activeBin.binId;
  ctx.outOfRangeSinceMs = null;
  logger.info('[rebalanceEngine] compound cycle complete', { pool: ctx.poolAddress });
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
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  const halfLamports = new BN(Math.round((capitalSol * LAMPORTS_PER_SOL) / 2));

  logger.info('[rebalanceEngine] opening initial position', { poolAddress, capitalSol });
  await swapExactIn(WSOL_MINT, otherMint, halfLamports);

  const [balX, balY] = await Promise.all([getTokenBalance(mintX), getTokenBalance(mintY)]);
  const activeBin = await getActiveBin(pool);
  const radius = computeBinRadius(binStep);
  const minBinId = activeBin.binId - radius;
  const maxBinId = activeBin.binId + radius;

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
    binStep,
    centerBinId: activeBin.binId,
    outOfRangeSinceMs: null,
  };

  await openPosition({ pool, totalXAmount: balX, totalYAmount: balY, minBinId, maxBinId });
  logger.info('[rebalanceEngine] initial position opened', { poolAddress });
  return ctx;
}

/**
 * Hard-exit flow: close position, dump 100% of the non-SOL side to SOL,
 * blacklist the pool for BLACKLIST_DURATION_MS, and return the leftover SOL
 * capital available for the next pool.
 */
export async function executeHardExit(ctx: PoolContext, blacklistPools: Map<string, number>): Promise<number> {
  const [position] = await getUserPositions(ctx.pool);
  if (position) {
    logger.warn('[rebalanceEngine] HARD_EXIT: closing position', { pool: ctx.poolAddress });
    await closePositionFull(ctx.pool, position);
  }

  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const otherAmount = await getTokenBalance(otherMint);
  if (otherAmount.gtn(0)) {
    await emergencySwapAllToSol(otherMint, otherAmount);
  }

  addToBlacklist(blacklistPools, ctx.poolAddress);

  const solBalance = await getWalletSolBalance();
  const nextCapital = Math.max(solBalance - env.MIN_GAS_RESERVE_SOL, 0);
  logger.warn('[rebalanceEngine] HARD_EXIT complete', { pool: ctx.poolAddress, solBalance, nextCapital });
  return nextCapital;
}
