import { createRequire } from 'node:module';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { connection, wallet, getDynamicPriorityFeeMicroLamports } from './solana.js';
import { COMPUTE_UNIT_LIMIT } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { orderSpec, spreadBins, filledFraction, type OrderGoal } from '../logic/limitOrderMath.js';
import { flipAnchorBin } from '../logic/flip.js';

/**
 * ponytail: @meteora-ag/dlmm has TWO separate packaging bugs, both worked
 * around below.
 *
 * 1. Its published dist/index.d.ts is broken — raw Anchor IDL JSON
 *    (`var address = "..."; var metadata = {...}`) leaks into the ambient
 *    declaration file, which desyncs the TS parser badly enough that the
 *    default export's TYPE resolves to `typeof import(...)` (the whole
 *    module namespace) instead of the `DLMM` class — `DLMM.create` then
 *    fails to type-check even though it exists at runtime and works fine.
 *    Confirmed by extracting the real method signatures straight from the
 *    class body text in that same .d.ts (the corruption starts ~1000 lines
 *    after the class, grep/sed still reads it fine even though tsc chokes).
 *    Fix: hand-type just the slice of the SDK this file calls, cast the
 *    package's default export to that shape once (`DLMM` below), and never
 *    import a type from '@meteora-ag/dlmm' directly.
 *
 * 2. Its published dist/index.mjs (the ESM build) crashes at import time
 *    under plain Node/tsx ESM resolution: internally it does
 *    `import { BN } from "@coral-xyz/anchor"`, but that package's ESM entry
 *    doesn't actually expose a `BN` named export (confirmed live — BN is
 *    missing from the resolved module object, a real bug in that package's
 *    dual CJS/ESM setup, not something we did). The CJS build
 *    (dist/index.js) doesn't have this problem. Fix: load via
 *    `createRequire` instead of a normal ESM `import`.
 *
 * Re-verify both against `node_modules/@meteora-ag/dlmm` on every SDK
 * upgrade — drop whichever workaround a release finally makes unnecessary.
 */
const require = createRequire(import.meta.url);
const DLMMPkg = require('@meteora-ag/dlmm');

/**
 * Max bins a single transaction can safely initialize/add-liquidity-to —
 * re-exported from the SDK's own constant rather than hardcoded, so a
 * version bump that changes it doesn't silently drift. Found live
 * 2026-10-07 (real bot's first entry attempt): computeBinRadius (binRange.ts)
 * could produce a radius up to env.MAX_BIN_RADIUS (50) — a 101-bin position
 * on a wide range — but initializePositionAndAddLiquidityByStrategy only
 * supports MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX (26) bins per tx; exceeding it
 * fails simulation with "Failed to reallocate account data" (InvalidRealloc)
 * on the InitializePosition instruction, not something withPriorityFee or
 * retries can work around — it's a hard per-tx ceiling.
 */
export const MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX: number = DLMMPkg.MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX;

export enum StrategyType {
  Spot = 0,
  Curve = 1,
  BidAsk = 2,
}

export interface BinLiquidity {
  binId: number;
  pricePerToken: string;
}

export interface PositionData {
  totalXAmount: string;
  totalYAmount: string;
  lowerBinId: number;
  upperBinId: number;
  feeX: BN;
  feeY: BN;
}

export interface LbPosition {
  publicKey: PublicKey;
  positionData: PositionData;
}

export interface DlmmPool {
  /** Pool address (SDK instance field). */
  pubkey?: PublicKey;
  /** Raw on-chain pair state (mints, reserve accounts, bin step) — used to rebuild a PoolContext on boot. */
  lbPair: { tokenXMint: PublicKey; tokenYMint: PublicKey; reserveX: PublicKey; reserveY: PublicKey; binStep: number };
  refetchStates(): Promise<void>;
  getActiveBin(): Promise<BinLiquidity>;
  placeLimitOrder(params: {
    owner: PublicKey;
    payer: PublicKey;
    sender: PublicKey;
    limitOrder: PublicKey;
    params: { isAskSide: boolean; relativeBin: null; bins: { id: number; amount: BN }[] };
  }): Promise<Transaction>;
  cancelLimitOrder(params: { limitOrderPubkey: PublicKey; owner: PublicKey; rentReceiver: PublicKey; binIds: number[] }): Promise<Transaction>;
  getLimitOrder(limitOrder: PublicKey): Promise<{
    publicKey: PublicKey;
    limitOrderData: {
      totalDepositAmountX: string;
      totalDepositAmountY: string;
      totalUnfilledAmountX: string;
      totalUnfilledAmountY: string;
      limitOrderBinData: { binId: number; empty: boolean }[];
    };
  }>;
  getPositionsByUserAndLbPair(
    userPubKey?: PublicKey,
  ): Promise<{ activeBin: BinLiquidity; userPositions: LbPosition[] }>;
  initializePositionAndAddLiquidityByStrategy(params: {
    positionPubKey: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: StrategyType; singleSidedX?: boolean };
    user: PublicKey;
    slippage?: number;
  }): Promise<Transaction>;
  createExtendedEmptyPosition(lowerBinId: number, upperBinId: number, position: PublicKey, owner: PublicKey): Promise<Transaction>;
  addLiquidityByStrategyChunkable(params: {
    positionPubKey: PublicKey;
    totalXAmount: BN;
    totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: StrategyType; singleSidedX?: boolean };
    user: PublicKey;
    slippage?: number;
  }): Promise<Transaction[]>;
  claimSwapFee(params: { owner: PublicKey; position: LbPosition }): Promise<Transaction[]>;
  removeLiquidity(params: {
    user: PublicKey;
    position: PublicKey;
    fromBinId: number;
    toBinId: number;
    bps: BN;
    shouldClaimAndClose?: boolean;
    skipUnwrapSOL?: boolean;
  }): Promise<Transaction[]>;
}

interface DlmmStatic {
  create(connection: import('@solana/web3.js').Connection, dlmmAddress: PublicKey): Promise<DlmmPool>;
  getAllLbPairPositionsByUser(connection: import('@solana/web3.js').Connection, userPubKey: PublicKey): Promise<Map<string, unknown>>;
}

const DLMM = DLMMPkg as unknown as DlmmStatic;

export interface OpenPositionParams {
  pool: DlmmPool;
  totalXAmount: BN;
  totalYAmount: BN;
  /** Bin radius only, NOT a precomputed minBinId/maxBinId — see openPosition's doc comment for why. */
  binRadius: number;
}

export interface OpenPositionResult {
  positionPubkey: PublicKey;
  signature: string;
  /** Active bin id actually used for this position's range — may differ from any snapshot the caller took before calling, since this is fetched fresh on every retry attempt. */
  centerBinId: number;
}

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();

/**
 * Strips any ComputeBudget instructions already present, so the caller can
 * safely add its own without creating duplicates. Found live 2026-10-07
 * (real bot's first-ever position-open): @meteora-ag/dlmm's
 * initializePositionAndAddLiquidityByStrategy already estimates and embeds
 * its own SetComputeUnitLimit/SetComputeUnitPrice instructions into the
 * Transaction it returns (visible in its own stack —
 * getEstimatedComputeUnitUsageWithBuffer/getEstimatedComputeUnitIxWithBuffer).
 * Blindly unshifting a SECOND pair on top, as withPriorityFee used to,
 * produces a transaction with duplicate ComputeBudget instructions —
 * Solana's runtime rejects that outright with "Transaction contains a
 * duplicate instruction that is not allowed", failing simulation before the
 * tx is ever broadcast (every real position-open attempt tonight failed
 * this way). Pure/exported for a self-check.
 */
export function stripComputeBudgetInstructions<T extends { programId: PublicKey }>(instructions: T[]): T[] {
  return instructions.filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID);
}

async function withPriorityFee(tx: Transaction, writableAccounts: PublicKey[], computeUnitLimit = COMPUTE_UNIT_LIMIT): Promise<Transaction> {
  const microLamports = await getDynamicPriorityFeeMicroLamports(writableAccounts);
  tx.instructions = stripComputeBudgetInstructions(tx.instructions);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
  );
  return tx;
}

/**
 * Refreshes blockhash and re-signs from a clean signature state on EVERY
 * attempt, inside the retry closure — not just once before the first try.
 * Found live 2026-10-07 (real bot's first-ever run): retrying
 * sendAndConfirmTransaction on the SAME already-signed Transaction object
 * (stale blockhash, stale tx.signatures from the failed attempt) produced
 * "Transaction contains a duplicate instruction (2) that is not allowed" on
 * every retry — a known class of issue with reusing a legacy Transaction
 * object across multiple send attempts. Clearing signatures + refreshing
 * blockhash before each attempt avoids resending stale signed state.
 */
async function sendTx(tx: Transaction, extraSigners: Keypair[] = [], label = 'tx'): Promise<string> {
  tx.feePayer = wallet.publicKey;

  return withRetry(
    async () => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.signatures = [];
      tx.sign(wallet, ...extraSigners);
      const raw = tx.serialize();
      const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      // Rebroadcast the same signed tx every 2s while waiting: sent-once txs were silently dropped on 2026-10-13/14
      // ("block height exceeded", signature never on chain) for swaps and a cancelLimitOrder alike. A landed tx makes resends a no-op.
      const rebroadcast = setInterval(() => {
        connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      }, 2_000);
      try {
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) throw new Error(`tx ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      } finally {
        clearInterval(rebroadcast);
      }
      return signature;
    },
    { maxRetries: 3, baseDelayMs: 1_000, label },
  );
}

/** Pools the user manages by hand (PROTECTED_POOLS, comma-separated): the bot must never enter, close or recover them. */
export function isProtectedPool(addr: string): boolean {
  return (process.env.PROTECTED_POOLS ?? '').split(',').some((a) => a.trim() === addr);
}

function assertNotProtected(pool: DlmmPool): void {
  const addr = pool.pubkey?.toBase58();
  if (addr && isProtectedPool(addr)) throw new Error(`pool ${addr} is protected (PROTECTED_POOLS): bot must not touch it`);
}

export async function openPool(poolAddress: string): Promise<DlmmPool> {
  return DLMM.create(connection, new PublicKey(poolAddress));
}

/** Addresses of every pool where this wallet holds an open position (one program-account scan; boot-time only). */
export async function getAllPositionPoolAddresses(): Promise<string[]> {
  const map = await withRetry(() => DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey), { maxRetries: 3, baseDelayMs: 2_000, label: 'getAllLbPairPositionsByUser' });
  return [...map.keys()].filter((a) => !isProtectedPool(a));
}

/** Pool addresses where an arbitrary wallet (not ours) holds open positions. Read-only. */
export async function getWalletPoolAddresses(walletAddress: string): Promise<string[]> {
  const map = await withRetry(() => DLMM.getAllLbPairPositionsByUser(connection, new PublicKey(walletAddress)), { maxRetries: 2, baseDelayMs: 2_000, label: 'getWalletPoolAddresses' });
  return [...map.keys()];
}

export async function getActiveBin(pool: DlmmPool): Promise<BinLiquidity> {
  return pool.getActiveBin();
}

/** Fresh active bin id (refetches the cached pair state first). */
export async function getFreshActiveBinId(pool: DlmmPool): Promise<number> {
  await pool.refetchStates();
  return (await pool.getActiveBin()).binId;
}

/** All open positions this wallet holds on the given pool. */
export async function getUserPositions(pool: DlmmPool): Promise<LbPosition[]> {
  if (pool.pubkey && isProtectedPool(pool.pubkey.toBase58())) return [];
  const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
  return userPositions;
}

/**
 * Opens a new DLMM position with a BidAsk-shaped range around the active
 * bin ([activeBin - radius, activeBin + radius]) and deposits both token
 * amounts. BidAsk concentrates liquidity at the range edges (like resting
 * limit orders on both sides) — Meteora's own docs recommend it over Spot
 * (even distribution) specifically for volatile pairs, since it captures
 * more fee when price jumps across bins; Curve (concentrated at center) is
 * explicitly NOT recommended for volatile pairs. Caller is responsible for
 * pre-balancing X/Y 50:50 via jupiterSwap.balanceTokenRatio before calling
 * this.
 */
/**
 * Opens a new DLMM position, fetching the active bin FRESH on every retry
 * attempt (inside the retry closure), not once beforehand. Found live
 * 2026-10-07 (DARK-SOL, pumping fast): the old version computed
 * minBinId/maxBinId ONCE from a single getActiveBin() snapshot, then
 * sendTx's own retry loop only refreshed the blockhash/signature on each
 * attempt — the bin-range parameters baked into the deposit instruction
 * itself stayed frozen. During a fast price move, every retry kept
 * resending the SAME now-stale bin range, failing identically 4 times in a
 * row with ExceededBinSlippageTolerance (the active bin had moved further
 * than the fixed range's own slippage tolerance allows) — a doomed retry
 * loop, not a transient one. Fetching the active bin fresh inside the
 * retry closure means each attempt reflects the current price, giving
 * retries an actual chance to succeed instead of repeating a guaranteed
 * failure. A fresh position keypair is generated per attempt too (cheap,
 * and removes any chance of colliding with a prior attempt's account).
 */
export async function openPosition(params: OpenPositionParams): Promise<OpenPositionResult> {
  const { pool, totalXAmount, totalYAmount, binRadius } = params;
  assertNotProtected(pool);

  return withRetry(
    async () => {
      const positionKeypair = Keypair.generate();
      // The SDK builds the deposit ix from its CACHED lbPair.activeId (3-bin slippage window);
      // getActiveBin() reads fresh but never updates that cache. Without a refetch every retry
      // sends the same stale activeId -> ExceededBinSlippageTolerance (0x1774) once price moved.
      await pool.refetchStates();
      const activeBin = await getActiveBin(pool);
      const minBinId = activeBin.binId - binRadius;
      const maxBinId = activeBin.binId + binRadius;

      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk },
      });

      await withPriorityFee(tx, [wallet.publicKey, positionKeypair.publicKey]);
      const signature = await sendTx(tx, [positionKeypair], 'openPosition');
      logger.info('[dlmm] position opened', {
        position: positionKeypair.publicKey.toBase58(),
        signature,
        centerBinId: activeBin.binId,
      });

      return { positionPubkey: positionKeypair.publicKey, signature, centerBinId: activeBin.binId };
    },
    { maxRetries: 3, baseDelayMs: 1_000, label: 'openPositionFreshBin' },
  );
}

/** Simulated 681k CU for a 69-bin ladder create+add in one tx (2026-10-15); headroom on top. */
export const LADDER_COMPUTE_UNIT_LIMIT = 900_000;

export interface LadderTx {
  tx: Transaction;
  positionKeypair: Keypair;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
}

/**
 * Builds ONE transaction that creates an extended position and deposits SOL only, as a bid-ask ladder BELOW the price
 * (meridian-style): bins [active-(n-1), active] when SOL is token Y, [active, active+(n-1)] when SOL is token X (token
 * price falling = bin id rising there). No token side, so no entry swap. SDK emits create + add as two txs; their
 * instructions are merged (verified by simulateTransaction: 1116 bytes, 681k CU for 69 bins). Refetches pool state first.
 */
export async function buildLadderTx(pool: DlmmPool, xIsSol: boolean, solLamports: BN, bins: number, user: PublicKey = wallet.publicKey, strategyType: StrategyType = StrategyType.BidAsk, offsetBins = 0, anchorBoundBinId?: number): Promise<LadderTx> {
  // `xIsSol` here means "the single deposited token is X": SOL for the SOL-only ladder, the memecoin for the token-only spot position.
  await pool.refetchStates();
  const activeBinId = (await getActiveBin(pool)).binId;
  // offsetBins > 0 starts the range that many bins away from the anchor on the deposited side (token_spot: just above the price). The anchor is the active
  // bin, except for the flip, which passes the old ladder's price-bottom bin so the asks never start below where the DCA-in ended (logic/flip.ts flipAnchorBin).
  const anchorBinId = flipAnchorBin(activeBinId, anchorBoundBinId, xIsSol);
  const minBinId = xIsSol ? anchorBinId + offsetBins : anchorBinId - offsetBins - (bins - 1);
  const maxBinId = xIsSol ? anchorBinId + offsetBins + (bins - 1) : anchorBinId - offsetBins;
  const positionKeypair = Keypair.generate();
  const create = await pool.createExtendedEmptyPosition(minBinId, maxBinId, positionKeypair.publicKey, user);
  const adds = await pool.addLiquidityByStrategyChunkable({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: xIsSol ? solLamports : new BN(0),
    totalYAmount: xIsSol ? new BN(0) : solLamports,
    strategy: { minBinId, maxBinId, strategyType, singleSidedX: xIsSol },
    user,
    slippage: 1,
  });
  if (adds.length !== 1) throw new Error(`[dlmm] ladder deposit needs ${adds.length} txs, expected 1 (bins=${bins})`);
  const tx = new Transaction();
  tx.add(...stripComputeBudgetInstructions([...create.instructions, ...(adds[0]?.instructions ?? [])]));
  return { tx, positionKeypair, minBinId, maxBinId, activeBinId };
}

/** Opens the SOL-only ladder (see buildLadderTx), rebuilding from a fresh active bin on every retry. */
export async function openLadderPosition(pool: DlmmPool, xIsSol: boolean, solLamports: BN, bins: number, strategyType: StrategyType = StrategyType.BidAsk, offsetBins = 0, anchorBoundBinId?: number): Promise<OpenPositionResult> {
  assertNotProtected(pool);
  return withRetry(
    async () => {
      const { tx, positionKeypair, minBinId, maxBinId, activeBinId } = await buildLadderTx(pool, xIsSol, solLamports, bins, wallet.publicKey, strategyType, offsetBins, anchorBoundBinId);
      await withPriorityFee(tx, [wallet.publicKey, positionKeypair.publicKey], LADDER_COMPUTE_UNIT_LIMIT);
      const signature = await sendTx(tx, [positionKeypair], 'openLadder');
      logger.info('[dlmm] ladder position opened', { position: positionKeypair.publicKey.toBase58(), signature, minBinId, maxBinId, activeBinId });
      // centerBinId is the range's anchor edge (== active bin when offsetBins is 0), see ladderBounds
      return { positionPubkey: positionKeypair.publicKey, signature, centerBinId: xIsSol ? minBinId : maxBinId };
    },
    { maxRetries: 3, baseDelayMs: 1_000, label: 'openLadderFreshBin' },
  );
}

/** Claims accrued swap fees without touching principal/liquidity. */
export async function claimFees(pool: DlmmPool, position: LbPosition): Promise<string[]> {
  const txs = await pool.claimSwapFee({ owner: wallet.publicKey, position });
  const signatures: string[] = [];
  for (const tx of txs) {
    await withPriorityFee(tx, [wallet.publicKey]);
    signatures.push(await sendTx(tx, [], 'claimFees'));
  }
  logger.info('[dlmm] fees claimed', { position: position.publicKey.toBase58(), signatures });
  return signatures;
}

/**
 * Fully drains and closes a position: removes 100% of liquidity, claims any
 * remaining fees, and closes the position account so rent-exempt SOL
 * returns to the wallet (`shouldClaimAndClose: true` bundles the rent
 * reclaim — the SDK has no separate "close account" instruction).
 */
export async function closePositionFull(pool: DlmmPool, position: LbPosition): Promise<string[]> {
  assertNotProtected(pool);
  const { lowerBinId, upperBinId } = position.positionData;

  const txs = await pool.removeLiquidity({
    user: wallet.publicKey,
    position: position.publicKey,
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10_000), // 100%
    shouldClaimAndClose: true,
  });

  const signatures: string[] = [];
  for (const tx of txs) {
    // 69-bin ladders with fees need far more than the default limit: ClaimFee2 ran out of CUs (live 2026-10-16, 388 failed simulations)
    await withPriorityFee(tx, [wallet.publicKey], LADDER_COMPUTE_UNIT_LIMIT);
    signatures.push(await sendTx(tx, [], 'closePosition'));
  }
  logger.info('[dlmm] position fully closed + rent reclaimed', {
    position: position.publicKey.toBase58(),
    signatures,
  });
  return signatures;
}

// ── Limit orders (SDK 1.9.14 placeLimitOrder / cancelLimitOrder) ─────────────────────────────────────────────
// Added 2026-10-14: entry bid below price (no Jupiter spread) and exit ask above price after a down-break.
// A maker fill earns only ~50% of the pool fee (live baton-SOL order: bonus ~0.3% of the filled amount).

/** Pools created before the limit-order program version don't support them. */
export function supportsLimitOrder(pool: DlmmPool): boolean {
  try {
    return Boolean((DLMMPkg as { isSupportLimitOrder: (s: unknown) => boolean }).isSupportLimitOrder(pool.lbPair));
  } catch {
    return false;
  }
}

export interface PlacedLimitOrder {
  /** active bin id at placement */
  activeBinId: number;
  order: PublicKey;
  binIds: number[];
  signature: string;
}

/**
 * Places `amount` (raw units of the deposited mint) as an order `offsetBins` away from the active bin, spread over `count` bins.
 * buyToken deposits SOL, sellToken deposits the token; the side/direction depend on which leg is SOL (see limitOrderMath.orderSpec).
 */
export async function placeLimitOrder(pool: DlmmPool, goal: OrderGoal, xIsSol: boolean, amount: BN, offsetBins: number, count = 2): Promise<PlacedLimitOrder> {
  await pool.refetchStates();
  const active = await getActiveBin(pool);
  const spec = orderSpec(xIsSol, goal);
  const bins = spreadBins(active.binId, spec.dir, offsetBins, count, amount);
  const orderKeypair = Keypair.generate();
  const tx = await pool.placeLimitOrder({
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    sender: wallet.publicKey,
    limitOrder: orderKeypair.publicKey,
    params: { isAskSide: spec.isAskSide, relativeBin: null, bins },
  });
  await withPriorityFee(tx, [wallet.publicKey, orderKeypair.publicKey]);
  const signature = await sendTx(tx, [orderKeypair], 'placeLimitOrder');
  logger.info('[dlmm] limit order placed', { goal, order: orderKeypair.publicKey.toBase58(), activeBin: active.binId, bins: bins.map((b) => b.id), amount: amount.toString(), signature });
  return { activeBinId: active.binId, order: orderKeypair.publicKey, binIds: bins.map((b) => b.id), signature };
}

export interface LimitOrderProgress {
  /** 0..1 of the deposited side that has been filled */
  fraction: number;
  /** bin ids still on the account */
  binIds: number[];
}

/**
 * null = the order account is confirmed gone (checked twice, 2s apart, to ride out a lagging RPC). An RPC/parse failure THROWS:
 * reading it as "gone" would make callers drop a live order that still holds capital.
 */
export async function getLimitOrderProgress(pool: DlmmPool, order: PublicKey, goal: OrderGoal, xIsSol: boolean): Promise<LimitOrderProgress | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await connection.getAccountInfo(order, 'confirmed');
    if (info) {
      const { limitOrderData: d } = await pool.getLimitOrder(order);
      const depositIsX = orderSpec(xIsSol, goal).depositIsX;
      return {
        fraction: depositIsX ? filledFraction(d.totalDepositAmountX, d.totalUnfilledAmountX) : filledFraction(d.totalDepositAmountY, d.totalUnfilledAmountY),
        binIds: d.limitOrderBinData.map((b) => b.binId),
      };
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/** Withdraws everything (unfilled deposit + filled proceeds) to the wallet and closes the account. Returns false if the account is already gone. */
export async function cancelLimitOrderFull(pool: DlmmPool, order: PublicKey, goal: OrderGoal, xIsSol: boolean): Promise<boolean> {
  const progress = await getLimitOrderProgress(pool, order, goal, xIsSol);
  if (!progress) return false;
  const tx = await pool.cancelLimitOrder({ limitOrderPubkey: order, owner: wallet.publicKey, rentReceiver: wallet.publicKey, binIds: progress.binIds });
  await withPriorityFee(tx, [wallet.publicKey]);
  const signature = await sendTx(tx, [], 'cancelLimitOrder');
  logger.info('[dlmm] limit order cancelled/withdrawn', { order: order.toBase58(), filledFraction: progress.fraction, signature });
  return true;
}
