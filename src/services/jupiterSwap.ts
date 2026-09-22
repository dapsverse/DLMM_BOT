import { createJupiterApiClient, type QuoteResponse } from '@jup-ag/api';
import { VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { connection, wallet } from './solana.js';
import { env } from '../config/env.js';
import { WSOL_MINT } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const jupiter = createJupiterApiClient({ basePath: env.JUPITER_API_BASE_URL });

export interface SwapResult {
  signature: string;
  outAmount: string;
}

async function quote(inputMint: string, outputMint: string, amount: BN): Promise<QuoteResponse> {
  return withRetry(
    () => jupiter.quoteGet({ inputMint, outputMint, amount: amount.toNumber(), slippageBps: env.SLIPPAGE_BPS }),
    { maxRetries: 4, baseDelayMs: 1_000, label: 'jupiter:quote' },
  );
}

/** Executes a single swap for the given quote and returns the confirmed signature. */
async function executeSwap(quoteResponse: QuoteResponse): Promise<SwapResult> {
  const { swapTransaction } = await withRetry(
    () =>
      jupiter.swapPost({
        swapRequest: {
          quoteResponse,
          userPublicKey: wallet.publicKey.toBase58(),
          dynamicComputeUnitLimit: true,
          // ponytail: default (no explicit prioritizationFeeLamports) lets Jupiter pick;
          // wire in a PriorityLevelWithMaxLamports object here if fee-spike misses show up.
        },
      }),
    { maxRetries: 3, baseDelayMs: 1_000, label: 'jupiter:swap' },
  );

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const signature = await withRetry(
    async () => {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      return sig;
    },
    { maxRetries: 2, baseDelayMs: 1_500, label: 'jupiter:sendSwapTx' },
  );

  logger.info('[jupiter] swap executed', { signature, outAmount: quoteResponse.outAmount });
  return { signature, outAmount: quoteResponse.outAmount };
}

export async function swapExactIn(inputMint: string, outputMint: string, amount: BN): Promise<SwapResult> {
  const q = await quote(inputMint, outputMint, amount);
  return executeSwap(q);
}

/**
 * Auto-compound step: given a pool's token X and token Y amounts (already
 * held in the wallet after claim+close), swaps whichever side is USD-heavier
 * so the wallet ends up ~50:50 by value, ready to re-deposit as LP capital.
 *
 * valueXUsd/valueYUsd are pre-computed by the caller (from a price source)
 * since this module has no pricing logic of its own — keeps this function a
 * pure "given imbalance, fix it" step instead of duplicating pricing.
 */
export async function balanceTokenRatio(params: {
  mintX: string;
  mintY: string;
  amountX: BN;
  amountY: BN;
  valueXUsd: number;
  valueYUsd: number;
}): Promise<{ swapped: boolean; result?: SwapResult }> {
  const { mintX, mintY, amountX, amountY, valueXUsd, valueYUsd } = params;
  const totalUsd = valueXUsd + valueYUsd;
  if (totalUsd <= 0) return { swapped: false };

  const imbalanceUsd = Math.abs(valueXUsd - valueYUsd);
  // Not worth a swap (fees would exceed the rebalancing benefit) if within 2% of even.
  if (imbalanceUsd / totalUsd < 0.02) {
    logger.debug('[jupiter] token ratio already ~50:50, skipping swap');
    return { swapped: false };
  }

  const heavierIsX = valueXUsd > valueYUsd;
  const excessUsd = imbalanceUsd / 2; // amount to move from heavy side to light side
  const fraction = excessUsd / (heavierIsX ? valueXUsd : valueYUsd);

  const fromMint = heavierIsX ? mintX : mintY;
  const toMint = heavierIsX ? mintY : mintX;
  const fromAmount = heavierIsX ? amountX : amountY;

  const swapAmount = fromAmount.muln(Math.round(fraction * 1_000_000)).divn(1_000_000);
  if (swapAmount.lten(0)) return { swapped: false };

  const result = await swapExactIn(fromMint, toMint, swapAmount);
  return { swapped: true, result };
}

/** Hard-exit / emergency path: dumps 100% of a token balance to SOL. */
export async function emergencySwapAllToSol(mint: string, amount: BN): Promise<SwapResult | null> {
  if (mint === WSOL_MINT || amount.lten(0)) return null;
  logger.warn('[jupiter] emergency swap to SOL', { mint, amount: amount.toString() });
  return swapExactIn(mint, WSOL_MINT, amount);
}

export function jupiterClient() {
  return jupiter;
}

export { WSOL_MINT };
export type { QuoteResponse };
