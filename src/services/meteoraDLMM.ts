import { createRequire } from 'node:module';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { connection, wallet, getDynamicPriorityFeeMicroLamports } from './solana.js';
import { COMPUTE_UNIT_LIMIT } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

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
  getActiveBin(): Promise<BinLiquidity>;
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
}

const DLMM = DLMMPkg as unknown as DlmmStatic;

export interface OpenPositionParams {
  pool: DlmmPool;
  totalXAmount: BN;
  totalYAmount: BN;
  minBinId: number;
  maxBinId: number;
}

export interface OpenPositionResult {
  positionPubkey: PublicKey;
  signature: string;
}

async function withPriorityFee(tx: Transaction, writableAccounts: PublicKey[]): Promise<Transaction> {
  const microLamports = await getDynamicPriorityFeeMicroLamports(writableAccounts);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  );
  return tx;
}

async function sendTx(tx: Transaction, extraSigners: Keypair[] = [], label = 'tx'): Promise<string> {
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return withRetry(
    () => sendAndConfirmTransaction(connection, tx, [wallet, ...extraSigners], { commitment: 'confirmed' }),
    { maxRetries: 3, baseDelayMs: 1_000, label },
  );
}

export async function openPool(poolAddress: string): Promise<DlmmPool> {
  return DLMM.create(connection, new PublicKey(poolAddress));
}

export async function getActiveBin(pool: DlmmPool): Promise<BinLiquidity> {
  return pool.getActiveBin();
}

/** All open positions this wallet holds on the given pool. */
export async function getUserPositions(pool: DlmmPool): Promise<LbPosition[]> {
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
export async function openPosition(params: OpenPositionParams): Promise<OpenPositionResult> {
  const { pool, totalXAmount, totalYAmount, minBinId, maxBinId } = params;
  const positionKeypair = Keypair.generate();

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk },
  });

  await withPriorityFee(tx, [wallet.publicKey, positionKeypair.publicKey]);
  const signature = await sendTx(tx, [positionKeypair], 'openPosition');
  logger.info('[dlmm] position opened', { position: positionKeypair.publicKey.toBase58(), signature });

  return { positionPubkey: positionKeypair.publicKey, signature };
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
    await withPriorityFee(tx, [wallet.publicKey]);
    signatures.push(await sendTx(tx, [], 'closePosition'));
  }
  logger.info('[dlmm] position fully closed + rent reclaimed', {
    position: position.publicKey.toBase58(),
    signatures,
  });
  return signatures;
}
