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
import { addToBlacklist } from './riskManager.js';
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
 * Full auto-compound cycle: close position (claim fees + reclaim rent),
 * rebalance token ratio 50:50, and reopen a fresh position sized to
 * whatever SOL-equivalent capital survives minus the gas reserve.
 */
export async function executeAutoCompound(ctx: PoolContext): Promise<PoolContext> {
  const [position] = await getUserPositions(ctx.pool);
  if (!position) throw new Error(`[rebalanceEngine] no open position found for pool ${ctx.poolAddress}`);

  logger.info('[rebalanceEngine] closing position for compound cycle', { pool: ctx.poolAddress });
  await closePositionFull(ctx.pool, position);

  const [balX, balY] = await Promise.all([getTokenBalance(ctx.mintX), getTokenBalance(ctx.mintY)]);
  const solBalance = await getWalletSolBalance();

  const reserveLamports = new BN(Math.round(env.MIN_GAS_RESERVE_SOL * LAMPORTS_PER_SOL));
  const solAmount = ctx.xIsSol ? balX : balY;
  const otherAmount = ctx.xIsSol ? balY : balX;
  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;

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
  const minBinId = activeBin.binId - env.BIN_RANGE_RADIUS;
  const maxBinId = activeBin.binId + env.BIN_RANGE_RADIUS;

  const depositX = ctx.xIsSol ? BN.max(freshX.sub(reserveLamports), new BN(0)) : freshX;
  const depositY = ctx.xIsSol ? freshY : BN.max(freshY.sub(reserveLamports), new BN(0));

  await openPosition({ pool: ctx.pool, totalXAmount: depositX, totalYAmount: depositY, minBinId, maxBinId });

  void otherMint; // kept for future USD-value logging/telemetry
  const now = Date.now();
  ctx.rebalanceTimestamps.push(now);
  ctx.lastRebalanceAt = now;
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
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  const halfLamports = new BN(Math.round((capitalSol * LAMPORTS_PER_SOL) / 2));

  logger.info('[rebalanceEngine] opening initial position', { poolAddress, capitalSol });
  await swapExactIn(WSOL_MINT, otherMint, halfLamports);

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
  };

  const [balX, balY] = await Promise.all([getTokenBalance(mintX), getTokenBalance(mintY)]);
  const activeBin = await getActiveBin(pool);
  const minBinId = activeBin.binId - env.BIN_RANGE_RADIUS;
  const maxBinId = activeBin.binId + env.BIN_RANGE_RADIUS;

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
