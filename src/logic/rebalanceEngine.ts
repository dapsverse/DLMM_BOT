import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { env } from '../config/env.js';
import { LAMPORTS_PER_SOL } from '../config/constants.js';
import {
  getUserPositions,
  openPosition,
  openLadderPosition,
  StrategyType,
  closePositionFull,
  getActiveBin,
  getFreshActiveBinId,
  openPool,
  placeLimitOrder,
  getLimitOrderProgress,
  cancelLimitOrderFull,
  supportsLimitOrder,
  type DlmmPool,
} from '../services/meteoraDLMM.js';
import { binsForMove, tokenPriceChangePct, shouldAbortEntry, needsFlowRecheck } from './limitOrderMath.js';
import { settlePendingSwapBack, DUST_RAW, type PendingSwapBack } from './pendingSwapBack.js';
import { balanceTokenRatio, emergencySwapAllToSol, swapExactIn, WSOL_MINT } from '../services/jupiterSwap.js';
import { connection, getWalletSolBalance, getTokenBalance, waitForTokenBalance } from '../services/solana.js';
import { isPoolStillEligible, getCurrentPriceUsd, recordChaseGuardExit, type ScannerConfig } from '../services/meteoraScanner.js';
import { addToBlacklist, rangeCeilingProfitOverride } from './riskManager.js';
import { computeBinRadius } from './binRange.js';
import { ladderRangeStatus } from './ladderRange.js';
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
  /** Set for a SOL-only ladder position (meridian mode): number of bins below the open price. Absent = classic 50:50 position. */
  ladderBins?: number;
  /** token-only spot strategy: 100% token deposited as a spot distribution ABOVE the price (ladderBins = its width); absent = SOL-only bid-ask ladder */
  tokenSpot?: boolean;
  /** token_spot only: price has been inside (or above) the range at least once, which switches the OOR wait from the first-reach timeout to the after-reach one */
  tokenSpotReached?: boolean;
  /** bid-ask flip (meridian mode): the SOL ladder was closed and its token redeposited as a token-only bid-ask above the price */
  flipPhase?: boolean;
  /** SOL taken out at the flip, left in the wallet and counted in the cycle PnL (see logic/flip.ts pnlBasisSol) */
  bankedSol?: number;
  /** wallet SOL spent by the entry (deposit + rent + gas, measured across the entry tx); absent when not measured reliably (see logic/realizedPnl.ts) */
  openSpentSol?: number;
  /** epoch ms the position was opened (ladder entries) */
  openedAtMs?: number;
  /** AI screener's stated thesis for this entry */
  aiEntryReason?: string;
  aiEntryConviction?: number;
  /** pool display name, for the outcome log */
  poolName?: string;
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
  /** out of range with the TOKEN price below the range (bin ids fall with the token price when the token is X, rise when SOL is X) */
  tokenBelowRange: boolean;
}

/**
 * Live bin-range check against the position's own DLMM pool object — reuses
 * ctx.pool (already held, no wallet involved in this read) rather than
 * spinning up a fresh DLMM instance like rpc.ts's getActiveBinId does for
 * the wallet-free callers (paper-trade, scanner).
 */
export async function getBinRangeStatus(ctx: PoolContext): Promise<BinRangeStatus> {
  const activeBin = await getActiveBin(ctx.pool);
  if (ctx.ladderBins !== undefined && isTokenSide(ctx)) {
    // deposited side is the memecoin; price rising through the range sells it into SOL (fellThrough). Out of range the OTHER way = still all token.
    const st = ladderRangeStatus(activeBin.binId, ctx.centerBinId, ctx.ladderBins, !ctx.xIsSol);
    return { currentBinId: activeBin.binId, isOutOfRange: st.isOutOfRange, tokenBelowRange: st.isOutOfRange && !st.tokenBelowRange };
  }
  if (ctx.ladderBins !== undefined) return { currentBinId: activeBin.binId, ...ladderRangeStatus(activeBin.binId, ctx.centerBinId, ctx.ladderBins, ctx.xIsSol) };
  const radius = computeBinRadius(ctx.binStep);
  const isOutOfRange = ctx.centerBinId === null || Math.abs(activeBin.binId - ctx.centerBinId) > radius;
  const tokenBelowRange =
    isOutOfRange && ctx.centerBinId !== null && (ctx.xIsSol ? activeBin.binId > ctx.centerBinId + radius : activeBin.binId < ctx.centerBinId - radius);
  return { currentBinId: activeBin.binId, isOutOfRange, tokenBelowRange };
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
  /** principal of the non-SOL side priced in SOL (0 once the token is fully sold into SOL) */
  otherPrincipalSol: number;
}

/** Reads the live open position and prices principal + unclaimed fees in SOL. */
export async function getPositionHealthSnapshot(ctx: PoolContext): Promise<PositionHealthSnapshot> {
  const [position] = await getUserPositions(ctx.pool);
  if (!position) return { currentValueSol: 0, unclaimedFeesSol: 0, otherPrincipalSol: 0 };

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

  return { currentValueSol, unclaimedFeesSol, otherPrincipalSol: principalOtherSol };
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
  if (env.ENTRY_STRATEGY_MODE === 'meridian') {
    // ladder geometry from the chain: the open-time active bin is the ladder's top edge (SOL=Y) or bottom edge (SOL=X)
    const [position] = await getUserPositions(pool);
    if (position) {
      ctx.ladderBins = position.positionData.upperBinId - position.positionData.lowerBinId + 1;
      ctx.centerBinId = xIsSol ? position.positionData.lowerBinId : position.positionData.upperBinId;
    }
  }
  return ctx;
}

/**
 * meridian mode entry: SOL-only bid-ask ladder `env.LADDER_BINS` bins below the active bin, ONE tx, no entry swap.
 * Capital is capped by what the wallet can fund after the gas reserve and the position rent (same pre-flight as openInitialPosition).
 */
export async function openLadderEntry(
  pool: DlmmPool,
  poolAddress: string,
  mintX: string,
  mintY: string,
  xIsSol: boolean,
  capitalSol: number,
  binStep: number,
  reserveSolAccount: string,
  bins: number = env.LADDER_BINS,
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  const walletSol = await getWalletSolBalance();
  const maxFundableSol = walletSol - computeGasReserveSol(walletSol) - POSITION_RENT_BUFFER_SOL;
  if (isCapitalUnderfunded(capitalSol, maxFundableSol)) {
    throw new Error(`[rebalanceEngine] requested capital ${capitalSol} SOL is under ${MIN_CAPITAL_FUND_RATIO * 100}% of the ${maxFundableSol.toFixed(4)} SOL the wallet can fund — refusing ladder entry`);
  }
  const effectiveCapitalSol = Math.min(capitalSol, maxFundableSol);
  if (effectiveCapitalSol <= 0) throw new Error(`[rebalanceEngine] wallet ${walletSol} SOL cannot fund a ladder after gas reserve + rent`);
  const otherMintDecimals = await getMintDecimals(otherMint);
  logger.info('[rebalanceEngine] opening SOL-only ladder', { poolAddress, capitalSol: effectiveCapitalSol, bins, otherMintDecimals });
  const result = await openLadderPosition(pool, xIsSol, new BN(Math.round(effectiveCapitalSol * LAMPORTS_PER_SOL)), bins);
  const openSpentSol = sanitizeSpent(walletSol - (await getWalletSolBalance()), effectiveCapitalSol);
  return {
    poolAddress,
    pool,
    mintX,
    mintY,
    xIsSol,
    initialDepositSol: effectiveCapitalSol,
    rebalanceTimestamps: [],
    lastRebalanceAt: 0,
    volume1hBaselineUsd: 0,
    volume1hBaselineSetAtMs: 0,
    binStep,
    centerBinId: result.centerBinId,
    outOfRangeSinceMs: null,
    inRangeSinceMs: null,
    peakProfitPct: 0,
    otherMintDecimals,
    reserveSolAccount,
    ladderBins: bins,
    openedAtMs: Date.now(),
    openSpentSol,
  };
}

/**
 * meridian mode, strategy `token_spot`: swap 100% of the capital into the token, then deposit it ALL as a flat (spot) distribution
 * ABOVE the price in ONE tx (mirror of the SOL-only ladder). Sells into a rise, loses if the price falls. Same pre-flight as the
 * ladder entry; if the deposit fails after the swap the token is swapped straight back to SOL.
 */
export async function openTokenSpotEntry(
  pool: DlmmPool,
  poolAddress: string,
  mintX: string,
  mintY: string,
  xIsSol: boolean,
  capitalSol: number,
  binStep: number,
  reserveSolAccount: string,
  bins: number = env.LADDER_BINS,
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  const walletSol = await getWalletSolBalance();
  const maxFundableSol = walletSol - computeGasReserveSol(walletSol) - POSITION_RENT_BUFFER_SOL;
  if (isCapitalUnderfunded(capitalSol, maxFundableSol)) {
    throw new Error(`[rebalanceEngine] requested capital ${capitalSol} SOL is under ${MIN_CAPITAL_FUND_RATIO * 100}% of the ${maxFundableSol.toFixed(4)} SOL the wallet can fund — refusing token-spot entry`);
  }
  const effectiveCapitalSol = Math.min(capitalSol, maxFundableSol);
  if (effectiveCapitalSol <= 0) throw new Error(`[rebalanceEngine] wallet ${walletSol} SOL cannot fund a token-spot entry after gas reserve + rent`);
  const otherMintDecimals = await getMintDecimals(otherMint);
  logger.info('[rebalanceEngine] opening token-only spot (100% token above the price)', { poolAddress, capitalSol: effectiveCapitalSol, bins, otherMintDecimals });
  const swapOut = new BN((await swapExactIn(WSOL_MINT, otherMint, new BN(Math.round(effectiveCapitalSol * LAMPORTS_PER_SOL)))).outAmount);
  let result;
  try {
    await waitForTokenBalance(otherMint, swapOut.muln(95).divn(100));
    const tokenAmount = await getTokenBalance(otherMint);
    // deposited token is X when the memecoin is X (i.e. SOL is Y): buildLadderTx's flag means "deposited side is X"
    result = await openLadderPosition(pool, !xIsSol, tokenAmount, bins, StrategyType.Spot, env.TOKEN_SPOT_START_OFFSET_BINS);
  } catch (err) {
    logger.error('[rebalanceEngine] token-spot deposit failed after swap — swapping the token back to SOL', { poolAddress, otherMint, error: err instanceof Error ? err.message : String(err) });
    const stuck = await getTokenBalance(otherMint);
    if (stuck.gtn(0)) await swapBackOrPend(otherMint, stuck, 'token-spot entry rollback');
    throw err;
  }
  const openSpentSol = sanitizeSpent(walletSol - (await getWalletSolBalance()), effectiveCapitalSol);
  return {
    poolAddress,
    pool,
    mintX,
    mintY,
    xIsSol,
    initialDepositSol: effectiveCapitalSol,
    rebalanceTimestamps: [],
    lastRebalanceAt: 0,
    volume1hBaselineUsd: 0,
    volume1hBaselineSetAtMs: 0,
    binStep,
    centerBinId: result.centerBinId,
    outOfRangeSinceMs: null,
    inRangeSinceMs: null,
    peakProfitPct: 0,
    otherMintDecimals,
    reserveSolAccount,
    ladderBins: bins,
    tokenSpot: true,
    openedAtMs: Date.now(),
    openSpentSol,
  };
}

/**
 * Bid-ask flip (meridian strategy 1): close the SOL ladder (claims fees), wait for the token to land in the wallet, then redeposit ALL
 * of it token-only as a bid-ask above the price in ONE tx (no Jupiter swap). The SOL that came out of the close (principal + SOL fees)
 * stays in the wallet as `ctx.bankedSol` and is counted in the cycle PnL. `initialDepositSol` and `peakProfitPct` are untouched.
 * If the redeposit fails after the close, the token is swapped back to SOL and the error rethrown (caller reconciles state).
 */
export async function executeFlip(ctx: PoolContext, onState?: () => void): Promise<PoolContext> {
  if (ctx.ladderBins === undefined || ctx.tokenSpot || ctx.flipPhase) throw new Error('[rebalanceEngine] executeFlip: not a SOL ladder position');
  const [position] = await getUserPositions(ctx.pool);
  if (!position) throw new Error('[rebalanceEngine] executeFlip: no open position on chain');
  const { feeX, feeY, totalXAmount, totalYAmount } = position.positionData;
  const solRaw = new BN(ctx.xIsSol ? totalXAmount : totalYAmount).add(new BN(ctx.xIsSol ? feeX : feeY));
  const expectedOther = new BN(ctx.xIsSol ? totalYAmount : totalXAmount).add(new BN(ctx.xIsSol ? feeY : feeX));
  if (!expectedOther.gtn(0)) throw new Error('[rebalanceEngine] executeFlip: position holds no token to flip');
  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const depositIsX = !ctx.xIsSol; // the deposited token is X when the memecoin is X (SOL is Y)
  const bankedSol = Number(solRaw.toString()) / LAMPORTS_PER_SOL;
  logger.warn('[rebalanceEngine] FLIP: closing the SOL ladder to redeposit its token above the price', {
    pool: ctx.poolAddress,
    bankedSol,
    expectedTokenRaw: expectedOther.toString(),
  });
  try {
    await closePositionFull(ctx.pool, position);
  } catch (err) {
    // the close may have landed although its confirmation threw: trust the chain, not the exception
    const [still] = await getUserPositions(ctx.pool);
    if (still) throw err;
    logger.warn('[rebalanceEngine] FLIP: close reported an error but the position is gone on chain, continuing', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
  }
  // From here the SOL is banked. Record it BEFORE the redeposit and persist, so a crash or a redeposit that lands but throws never loses it
  // (otherwise the cycle PnL misses ~20% of the value and the stop loss fires falsely).
  ctx.flipPhase = true;
  ctx.bankedSol = bankedSol;
  onState?.();
  let result;
  try {
    const held = await waitForTokenBalance(otherMint, expectedOther.muln(95).divn(100));
    // never redeposit more than the close returned: older dust of the same mint would inflate the position above its basis
    result = await openLadderPosition(ctx.pool, depositIsX, BN.min(held, expectedOther), ctx.ladderBins, StrategyType.BidAsk, env.TOKEN_SPOT_START_OFFSET_BINS);
  } catch (err) {
    const [landed] = await getUserPositions(ctx.pool);
    if (landed) {
      // the deposit landed although the call threw: adopt the position that exists on chain
      ctx.centerBinId = flipCenterFromBounds(landed.positionData.lowerBinId, landed.positionData.upperBinId, depositIsX);
      ctx.outOfRangeSinceMs = null;
      ctx.inRangeSinceMs = null;
      logger.warn('[rebalanceEngine] FLIP: redeposit threw but the position exists on chain, adopting it', { pool: ctx.poolAddress, centerBinId: ctx.centerBinId, error: err instanceof Error ? err.message : String(err) });
      return ctx;
    }
    ctx.flipPhase = false;
    ctx.bankedSol = undefined;
    logger.error('[rebalanceEngine] FLIP redeposit failed after the close — swapping the token back to SOL', {
      pool: ctx.poolAddress,
      otherMint,
      error: err instanceof Error ? err.message : String(err),
    });
    let stuck = await getTokenBalance(otherMint);
    if (!stuck.gtn(0)) {
      // a stale read (same race as the BATON incident): wait for the real balance, else record the expected amount as pending
      try {
        stuck = await waitForTokenBalance(otherMint, expectedOther.muln(95).divn(100));
      } catch {
        pendingSwapBack = { mint: otherMint, amount: expectedOther.toString() };
      }
    }
    if (stuck.gtn(0)) await swapBackOrPend(otherMint, stuck, 'flip redeposit rollback');
    throw err;
  }
  ctx.centerBinId = result.centerBinId;
  ctx.outOfRangeSinceMs = null;
  ctx.inRangeSinceMs = null;
  logger.warn('[rebalanceEngine] FLIP complete: token-only bid-ask is live above the price', { pool: ctx.poolAddress, centerBinId: result.centerBinId, bankedSol });
  return ctx;
}

export { estimateCycleGasCostSol } from './costEstimate.js';
import { estimateBinRentSol } from './costEstimate.js';
import { isTokenSide, flipCenterFromBounds } from './flip.js';
import { sanitizeSpent } from './realizedPnl.js';

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

/**
 * Entry capital must be a real share of what the wallet can fund. 2026-10-11: a stale currentCapitalSol
 * (0.143, read while a token swap was still pending) opened a 0.143 SOL position with ~0.95 SOL idle.
 * Below this fraction of the fundable SOL we heal the capital from the wallet (index.ts) or refuse the entry.
 */
export const MIN_CAPITAL_FUND_RATIO = 0.5;

export function isCapitalUnderfunded(capitalSol: number, fundableSol: number): boolean {
  return fundableSol > 0 && capitalSol < fundableSol * MIN_CAPITAL_FUND_RATIO;
}

/** Capital the bot may deploy from a wallet balance: balance minus gas reserve, clamped to MAX_CAPITAL_SOL when set. */
export function walletCapitalSol(solBalance: number): number {
  const c = Math.max(solBalance - computeGasReserveSol(solBalance), 0);
  return env.MAX_CAPITAL_SOL > 0 ? Math.min(c, env.MAX_CAPITAL_SOL) : c;
}

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
    if (toSwap.gtn(0)) await swapBackOrPend(otherMint, toSwap, 'compoundCycle abandon');
    return null;
  }

  const solBalance = await getWalletSolBalance();
  const reserveLamports = new BN(Math.round(computeGasReserveSol(solBalance) * LAMPORTS_PER_SOL));
  const solAmount = ctx.xIsSol ? balX : balY;
  const fullSpendableLamports = BN.max(solAmount.sub(reserveLamports), new BN(0));
  const otherValueSol = await otherTokenValueInSol(ctx, otherAmount);
  // MAX_CAPITAL_SOL: idle wallet SOL beyond the cap stays out of the reopen (never shrinks the position itself).
  let spendableSolLamports = fullSpendableLamports;
  if (env.MAX_CAPITAL_SOL > 0) {
    const capTotalSol = Math.max(env.MAX_CAPITAL_SOL, preClose.currentValueSol + preClose.unclaimedFeesSol);
    const capLamports = new BN(Math.round(Math.max(capTotalSol - otherValueSol, 0) * LAMPORTS_PER_SOL));
    spendableSolLamports = BN.min(fullSpendableLamports, capLamports);
  }
  const heldBackLamports = fullSpendableLamports.sub(spendableSolLamports);

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
  const reservedDeposit = reserveGasFromSolSide(freshX, freshY, ctx.xIsSol);
  const { depositX, depositY } = heldBackLamports.gtn(0)
    ? capSolDeposit(reservedDeposit.depositX, reservedDeposit.depositY, ctx.xIsSol, (ctx.xIsSol ? reservedDeposit.depositX : reservedDeposit.depositY).sub(heldBackLamports))
    : reservedDeposit;

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
      if (stuck.gtn(0)) await swapBackOrPend(otherMint, stuck, 'reopen rollback');
    } catch (balErr) {
      logger.error('[rebalanceEngine] reopen rollback could not read the token balance — token may be stuck in wallet', {
        otherMint,
        error: balErr instanceof Error ? balErr.message : String(balErr),
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
  /** called after an entry-bid wait, before the position opens: false aborts the entry (fail-closed) */
  recheck?: () => Promise<boolean>,
): Promise<PoolContext> {
  const otherMint = xIsSol ? mintY : mintX;
  // Pre-flight BEFORE any swap: a failure after the swap costs a full round-trip of spread.
  // capitalSol may already be wallet-minus-reserve (nextCapital after an exit), so cap it by what the
  // wallet can really fund instead of adding the reserve on top again.
  const walletSol = await getWalletSolBalance();
  const maxFundableSol = walletSol - computeGasReserveSol(walletSol) - POSITION_RENT_BUFFER_SOL;
  if (isCapitalUnderfunded(capitalSol, maxFundableSol)) {
    throw new Error(`[rebalanceEngine] requested capital ${capitalSol} SOL is under ${MIN_CAPITAL_FUND_RATIO * 100}% of the ${maxFundableSol.toFixed(4)} SOL the wallet can fund — refusing to enter with most of the SOL idle`);
  }
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
  // Token share: first as a limit bid below the price (no Jupiter spread; live entries dip right after entry), the unfilled remainder at market.
  let limitGot = new BN(0);
  let remainingLamports = tokenShareLamports;
  if (env.ENTRY_LIMIT_BID_PCT > 0 && supportsLimitOrder(pool)) {
    const bid = await acquireViaBid(pool, poolAddress, xIsSol, otherMint, tokenShareLamports, binStep, recheck);
    if (bid) {
      limitGot = bid.tokenRaw;
      remainingLamports = tokenShareLamports.sub(bid.filledLamports);
    }
  }
  let swapOut = new BN(0);
  if (remainingLamports.gt(tokenShareLamports.divn(20))) {
    swapOut = new BN((await swapExactIn(WSOL_MINT, otherMint, remainingLamports)).outAmount);
  }

  // Don't trust a single immediate balance read after the swap — see
  // waitForTokenBalance's doc comment for the live incident (a stale read
  // here silently deposited 0 of the non-SOL side, producing a SOL-only
  // position that then correctly-but-confusingly read as "50% down").
  // 95% of the swap's own expected outAmount as the threshold — leaves
  // room for quote-vs-actual slippage without masking a genuinely stale 0.
  const expectedOtherAmount = limitGot.add(swapOut).muln(95).divn(100);
  if (expectedOtherAmount.gtn(0)) await waitForTokenBalance(otherMint, expectedOtherAmount);

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
      await swapBackOrPend(otherMint, stuckBalance, 'entry rollback');
    }
    throw err;
  }
  logger.info('[rebalanceEngine] initial position opened', { poolAddress, estBinRentSol: estimateBinRentSol(radius) });
  return ctx;
}

// ── Limit-order legs (2026-10-14) ────────────────────────────────────────────────────────────────────────────
// A bid below the price replaces the entry swap; an ask above the price replaces the exit swap after a down-break.
// The single order slot is persisted by index.ts and settled at the start of every flat tick, so a restart or a failed
// cancel never strands the capital (a maker fill earns ~50% of the pool fee, see meteoraDLMM.ts).
export interface PendingLimitOrder {
  kind: 'entryBid' | 'exitAsk';
  pool: string;
  order: string;
  xIsSol: boolean;
  /** the pool's non-SOL mint */
  mint: string;
  amountRaw: string;
  /** token balance that is not part of this order (kept fee portion / pre-existing balance) */
  keepRaw: string;
  deadlineMs: number;
}

let pendingLimitOrder: PendingLimitOrder | null = null;

export function getPendingLimitOrder(): PendingLimitOrder | null {
  return pendingLimitOrder;
}

export function restorePendingLimitOrder(p: PendingLimitOrder | null): void {
  pendingLimitOrder = p;
}

const LIMIT_POLL_MS = 20_000;
const FILLED_FRACTION = 0.999;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const goalOf = (kind: PendingLimitOrder['kind']): 'buyToken' | 'sellToken' => (kind === 'entryBid' ? 'buyToken' : 'sellToken');

/** Token balance once it stops changing (a withdraw's own balance can lag the confirmed tx on a load-balanced RPC). */
async function readSettledBalance(mint: string): Promise<BN> {
  let last = await getTokenBalance(mint);
  for (let i = 0; i < 4; i++) {
    await sleep(1_500);
    const next = await getTokenBalance(mint);
    if (next.eq(last)) return next;
    last = next;
  }
  return last;
}

async function placeOrderTracked(
  kind: PendingLimitOrder['kind'],
  pool: DlmmPool,
  poolAddress: string,
  xIsSol: boolean,
  mint: string,
  amount: BN,
  offsetBins: number,
  waitMin: number,
  keep: BN,
  binCount = 2,
): Promise<{ pending: PendingLimitOrder; activeBinId: number }> {
  const placed = await placeLimitOrder(pool, goalOf(kind), xIsSol, amount, offsetBins, binCount);
  pendingLimitOrder = {
    kind,
    pool: poolAddress,
    order: placed.order.toBase58(),
    xIsSol,
    mint,
    amountRaw: amount.toString(),
    keepRaw: keep.toString(),
    deadlineMs: Date.now() + waitMin * 60_000,
  };
  return { pending: pendingLimitOrder, activeBinId: placed.activeBinId };
}

/** Withdraws everything from the order. fraction = filled share; tokenRaw = token the wallet holds beyond `keepRaw` afterwards (entry: the bought token, exit: the unsold token). */
async function cancelPendingOrder(p: PendingLimitOrder, pool: DlmmPool): Promise<{ fraction: number; tokenRaw: BN }> {
  const order = new PublicKey(p.order);
  const goal = goalOf(p.kind);
  const prog = await getLimitOrderProgress(pool, order, goal, p.xIsSol);
  const fraction = prog?.fraction ?? 0;
  if (prog) await cancelLimitOrderFull(pool, order, goal, p.xIsSol);
  const balance = await readSettledBalance(p.mint);
  const tokenRaw = BN.max(balance.sub(new BN(p.keepRaw)), new BN(0));
  return { fraction, tokenRaw };
}

async function acquireViaBid(
  pool: DlmmPool,
  poolAddress: string,
  xIsSol: boolean,
  otherMint: string,
  tokenShareLamports: BN,
  binStep: number,
  recheck?: () => Promise<boolean>,
): Promise<{ tokenRaw: BN; filledLamports: BN } | null> {
  let p: PendingLimitOrder;
  let activeBinAtPlace: number;
  try {
    const before = await getTokenBalance(otherMint);
    // Spread over the bins from 1 bin below the price down to ENTRY_LIMIT_BID_PCT below it (3..12 bins): a wide order fills partially far more often than a 2-bin sliver (UI test 2026-10-14: ~50% in 32 min).
    const binCount = Math.min(12, Math.max(3, binsForMove(env.ENTRY_LIMIT_BID_PCT, binStep, 'down')));
    ({ pending: p, activeBinId: activeBinAtPlace } = await placeOrderTracked('entryBid', pool, poolAddress, xIsSol, otherMint, tokenShareLamports, 1, env.ENTRY_LIMIT_WAIT_MIN, before, binCount));
  } catch (err) {
    logger.warn('[rebalanceEngine] entry bid could not be placed — buying at market instead', { poolAddress, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  logger.info('[rebalanceEngine] entry bid placed, waiting for a fill', { poolAddress, bidPct: env.ENTRY_LIMIT_BID_PCT, waitMin: env.ENTRY_LIMIT_WAIT_MIN });
  const order = new PublicKey(p.order);
  while (Date.now() < p.deadlineMs) {
    await sleep(LIMIT_POLL_MS);
    const prog = await getLimitOrderProgress(pool, order, 'buyToken', xIsSol);
    if (!prog || prog.fraction >= FILLED_FRACTION) break;
  }
  // Errors from here on leave pendingLimitOrder set: the next flat tick cancels it (processPendingLimitOrder).
  const { fraction, tokenRaw } = await cancelPendingOrder(p, pool);
  pendingLimitOrder = null;
  logger.info('[rebalanceEngine] entry bid settled', { poolAddress, filledFraction: fraction, tokenRaw: tokenRaw.toString() });
  // Mostly unfilled and the token ran away: do not chase it at market, let the caller rescan.
  const priceChangePct = tokenPriceChangePct(activeBinAtPlace, await getFreshActiveBinId(pool), binStep, xIsSol);
  if (shouldAbortEntry(fraction, priceChangePct, env.ENTRY_LIMIT_MAX_CHASE_PCT)) {
    if (tokenRaw.gten(DUST_RAW)) await swapBackOrPend(otherMint, tokenRaw, 'entry bid ran-away abort');
    throw new Error(`[rebalanceEngine] entry aborted: bid ${(fraction * 100).toFixed(0)}% filled and the price is ${priceChangePct.toFixed(1)}% above the bid time (max ${env.ENTRY_LIMIT_MAX_CHASE_PCT}%) — rescanning`);
  }
  if (recheck && needsFlowRecheck(fraction)) {
    let ok = false;
    try {
      ok = await recheck();
    } catch {
      ok = false;
    }
    if (!ok) {
      if (tokenRaw.gten(DUST_RAW)) await swapBackOrPend(otherMint, tokenRaw, 'entry bid recheck failed');
      throw new Error('[rebalanceEngine] entry re-check failed after the limit wait — entry aborted, capital back in SOL');
    }
  }
  return { tokenRaw, filledLamports: tokenShareLamports.muln(Math.round(fraction * 10_000)).divn(10_000) };
}

/**
 * Called at the start of every flat tick. 'waiting' = an exit ask is still inside its window (entries stay blocked: the capital is in the order).
 * An order past its deadline, fully filled, vanished, or any leftover entry bid (never resumed after a restart) is cancelled, and whatever token comes back is sold via Jupiter (pending swap-back on failure).
 */
let lastLimitCheckAtMs = 0;

export async function processPendingLimitOrder(): Promise<'none' | 'waiting' | 'done'> {
  const p = pendingLimitOrder;
  if (!p) return 'none';
  // an ask inside its window is only polled once a minute (each poll is several RPC calls)
  if (p.kind === 'exitAsk' && Date.now() < p.deadlineMs && Date.now() - lastLimitCheckAtMs < 60_000) return 'waiting';
  lastLimitCheckAtMs = Date.now();
  const pool = await openPool(p.pool);
  const prog = await getLimitOrderProgress(pool, new PublicKey(p.order), goalOf(p.kind), p.xIsSol);
  const settle = p.kind === 'entryBid' || prog === null || prog.fraction >= FILLED_FRACTION || Date.now() >= p.deadlineMs;
  if (!settle) return 'waiting';
  const { fraction, tokenRaw } = await cancelPendingOrder(p, pool);
  pendingLimitOrder = null;
  logger.warn('[rebalanceEngine] limit order settled', { kind: p.kind, pool: p.pool, filledFraction: fraction, tokenLeftRaw: tokenRaw.toString() });
  if (tokenRaw.gten(DUST_RAW)) await swapBackOrPend(p.mint, tokenRaw, `${p.kind} settle`);
  return 'done';
}

/**
 * Swap-back that failed AFTER an irreversible close. Retried by index.ts on every flat tick until it
 * lands (CRAWL 2026-10-12: one failed swap-back left ~0.5 SOL of token stranded, wallet read 0.59 vs 1.09).
 * Persisted by index.ts in the state file so a restart keeps retrying.
 */
let pendingSwapBack: PendingSwapBack | null = null;

/**
 * Swap a leftover token to SOL after an irreversible close. On failure the amount is recorded as pending
 * (retried every flat tick, persisted, blocks entries) instead of being lost: live 2026-10-13 a compoundCycle
 * abandon swap failed 4x ("block height exceeded") and, unlike closeAndConvertToSol, left nothing to retry.
 */
async function swapBackOrPend(mint: string, amount: BN, label: string): Promise<boolean> {
  try {
    await emergencySwapAllToSol(mint, amount);
    return true;
  } catch (err) {
    pendingSwapBack = { mint, amount: amount.toString() };
    logger.error(`[rebalanceEngine] ${label}: swap-back failed, recorded as pending`, {
      mint,
      amount: amount.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function getPendingSwapBack(): PendingSwapBack | null {
  return pendingSwapBack;
}

export function restorePendingSwapBack(p: PendingSwapBack | null): void {
  pendingSwapBack = p;
}

/** Throws if the swap still fails (pending stays set); no-op when nothing is pending. */
export async function retryPendingSwapBack(): Promise<void> {
  if (!pendingSwapBack) return;
  logger.warn('[rebalanceEngine] retrying pending swap-back', { ...pendingSwapBack });
  pendingSwapBack = await settlePendingSwapBack(pendingSwapBack, { getBalance: getTokenBalance, swap: emergencySwapAllToSol });
  logger.info('[rebalanceEngine] pending swap-back settled');
}

/** Proceeds of the most recent exit (see closeAndConvertToSol); read by index.ts when it records the outcome. */
let lastClose: { pool: string; receivedSol: number | null } | null = null;
export function getLastClose(): { pool: string; receivedSol: number | null } | null {
  return lastClose;
}

/**
 * Closes the current position (claim fees + reclaim rent) and converts
 * everything to SOL. Shared by executeHardExit (adds a blacklist after)
 * and executeCleanExit (no blacklist - used by SWITCH and TAKE_PROFIT,
 * neither of which are risk violations).
 */
async function closeAndConvertToSol(ctx: PoolContext, logPrefix: string, ask?: { pct: number; waitMin: number }): Promise<number> {
  const [position] = await getUserPositions(ctx.pool);
  let feeOtherRaw = new BN(0);
  let expectedOtherAmount = new BN(0);
  let solBeforeClose: number | null = null;
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
    // meridian mode sells the whole token side (no fee-sized portion kept)
    const sellAll = env.MERIDIAN_RULES && env.ENTRY_STRATEGY_MODE === 'meridian' && ctx.ladderBins !== undefined;
    const realFeeOther = new BN(ctx.xIsSol ? feeY : feeX);
    feeOtherRaw = sellAll ? new BN(0) : realFeeOther;
    expectedOtherAmount = new BN(ctx.xIsSol ? totalYAmount : totalXAmount).add(realFeeOther);
    logger.warn(`[rebalanceEngine] ${logPrefix}: closing position`, { pool: ctx.poolAddress });
    solBeforeClose = await getWalletSolBalance();
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
  let askPlaced = false;
  if (toSwap.gtn(0) && ask && ask.pct > 0 && supportsLimitOrder(ctx.pool)) {
    try {
      await placeOrderTracked('exitAsk', ctx.pool, ctx.poolAddress, ctx.xIsSol, otherMint, toSwap, binsForMove(ask.pct, ctx.binStep, 'up'), ask.waitMin, toKeepAsToken);
      askPlaced = true;
      logger.warn(`[rebalanceEngine] ${logPrefix}: token put on an ask limit order instead of a market swap`, { pool: ctx.poolAddress, askPct: ask.pct, waitMin: ask.waitMin, amountRaw: toSwap.toString() });
    } catch (err) {
      logger.warn(`[rebalanceEngine] ${logPrefix}: ask limit order failed, selling at market`, { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (toSwap.gtn(0) && !askPlaced) {
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
      pendingSwapBack = { mint: otherMint, amount: toSwap.toString() };
      logger.error(`[rebalanceEngine] ${logPrefix}: leftover-token swap-back failed, continuing with SOL-only balance`, {
        pool: ctx.poolAddress,
        otherMint,
        stuckAmount: toSwap.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const solBalance = await getWalletSolBalance();
  const nextCapital = walletCapitalSol(solBalance);
  // proceeds of this exit (close + token swap), measured over seconds; incomplete (null) when a swap-back is still pending or the close was not run here
  lastClose = { pool: ctx.poolAddress, receivedSol: solBeforeClose !== null && !pendingSwapBack ? solBalance - solBeforeClose : null };
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
export async function executeCleanExit(ctx: PoolContext, reason: 'SWITCH' | 'TAKE_PROFIT' | 'FLOW_EXIT' | 'AI_EXIT' | 'STOP_LOSS', chaseGuardPools: Map<string, number>, armChaseGuard = true): Promise<number> {
  if (armChaseGuard) await recordExitForChaseGuard(ctx, chaseGuardPools);
  return closeAndConvertToSol(ctx, reason);
}

/** Manual close (Telegram /close, bot stopped): close, then sell the token side on an ask askPct above the price (0 = Jupiter now); fee-sized token portion kept. Returns the next capital. */
export async function executeManualClose(ctx: PoolContext, askPct = 0): Promise<number> {
  return closeAndConvertToSol(ctx, 'MANUAL_CLOSE', askPct > 0 ? { pct: askPct, waitMin: env.DOWNBREAK_ASK_WAIT_MIN } : undefined);
}

/**
 * Exit after the token price stayed below the range for MAX_IDLE_OUT_OF_RANGE_MINUTES: close, put the token on an ask
 * DOWNBREAK_ASK_PCT above the price (Jupiter after DOWNBREAK_ASK_WAIT_MIN). No chase guard: re-entering the same pool is allowed.
 */
export async function executeDownBreakExit(ctx: PoolContext): Promise<number> {
  return closeAndConvertToSol(ctx, 'DOWN_BREAK', { pct: env.DOWNBREAK_ASK_PCT, waitMin: env.DOWNBREAK_ASK_WAIT_MIN });
}
