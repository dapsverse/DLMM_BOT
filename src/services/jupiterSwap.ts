import { createJupiterApiClient, type QuoteResponse } from '@jup-ag/api';
import { VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { connection, wallet, waitForTokenBalance } from './solana.js';
import { env } from '../config/env.js';
import { WSOL_MINT } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const jupiter = createJupiterApiClient({ basePath: env.JUPITER_API_BASE_URL });

export interface SwapResult {
  signature: string;
  outAmount: string;
}

async function quote(inputMint: string, outputMint: string, amount: BN, slippageBps: number): Promise<QuoteResponse> {
  return withRetry(
    () => jupiter.quoteGet({ inputMint, outputMint, amount: amount.toNumber(), slippageBps }),
    { maxRetries: 4, baseDelayMs: 1_000, label: 'jupiter:quote' },
  );
}

/**
 * Executes a swap and returns the confirmed signature. Each retry attempt
 * fetches a FRESH quote AND rebuilds + re-signs a fresh swap transaction
 * inside the retry closure. Fresh tx: a VersionedTransaction's blockhash is
 * baked into its compiled message (found live 2026-10-07/08: resending one
 * object made every retry doomed). Fresh quote: on a fast-moving memecoin a
 * stale quote fails again with Jupiter 6001 (slippage exceeded) — seen live
 * 2026-10-10, 2 of 4 swaps in one session.
 */
async function executeSwap(inputMint: string, outputMint: string, amount: BN, slippageBps: number): Promise<SwapResult> {
  let attempt = 0;
  const { signature, outAmount } = await withRetry(
    async () => {
      const n = attempt++;
      const quoteResponse = await quote(inputMint, outputMint, amount, slippageBps);
      const { swapTransaction } = await jupiter.swapPost({
        swapRequest: {
          quoteResponse,
          userPublicKey: wallet.publicKey.toBase58(),
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            // Escalate on retries: 4 swaps in a row never landed on 2026-10-13 at a fixed 'high' level.
            priorityLevelWithMaxLamports: { priorityLevel: n === 0 ? 'high' : 'veryHigh', maxLamports: env.JUPITER_MAX_PRIORITY_FEE_LAMPORTS * (n + 1) },
          },
        },
      });
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([wallet]);

      const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      // Rebroadcast the same signed tx every 2s while waiting: all 4 attempts of the 2026-10-13 exit were sent once
      // and never landed (signatures not found on chain, network fees 0). Resending a landed tx is a no-op.
      const raw = tx.serialize();
      const rebroadcast = setInterval(() => {
        connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      }, 2_000);
      let confirmation;
      try {
        confirmation = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      } finally {
        clearInterval(rebroadcast);
      }
      // A tx can land and still fail on-chain (e.g. Jupiter 6001 slippage): confirmTransaction resolves
      // without throwing, so check the result or a failed swap gets logged as executed.
      if (confirmation.value.err) {
        throw new Error(`swap tx ${sig} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      return { signature: sig, outAmount: quoteResponse.outAmount };
    },
    { maxRetries: 3, baseDelayMs: 1_500, label: 'jupiter:sendSwapTx' },
  );

  logger.info('[jupiter] swap executed', { signature, outAmount });
  return { signature, outAmount };
}

export async function swapExactIn(
  inputMint: string,
  outputMint: string,
  amount: BN,
  slippageBps: number = env.JUPITER_MAX_SLIPPAGE_BPS,
): Promise<SwapResult> {
  return executeSwap(inputMint, outputMint, amount, slippageBps);
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
/**
 * Pure planner: which side to swap and what fraction of it, to move the non-SOL token share of
 * (valueX + valueY) to `targetTokenShare` (0.5 = old 50:50 behaviour; math is identical at 0.5).
 * Returns null when already within 2% of target. `tokenIsX` = the non-SOL mint is mintX.
 */
export function planRatioSwap(
  valueX: number,
  valueY: number,
  tokenIsX: boolean,
  targetTokenShare: number,
): { fromX: boolean; fraction: number } | null {
  const total = valueX + valueY;
  if (total <= 0) return null;
  const tokenValue = tokenIsX ? valueX : valueY;
  const solValue = total - tokenValue;
  const diff = tokenValue / total - targetTokenShare;
  if (Math.abs(diff) < 0.02) return null; // not worth a swap (fees would exceed the benefit)
  if (diff > 0) {
    // too much token: sell part of the token side for SOL
    return { fromX: tokenIsX, fraction: (tokenValue - targetTokenShare * total) / tokenValue };
  }
  // too little token: buy token with part of the SOL side
  return { fromX: !tokenIsX, fraction: (targetTokenShare * total - tokenValue) / solValue };
}

export async function balanceTokenRatio(params: {
  mintX: string;
  mintY: string;
  amountX: BN;
  amountY: BN;
  valueXUsd: number;
  valueYUsd: number;
}): Promise<{ swapped: boolean; result?: SwapResult }> {
  const { mintX, mintY, amountX, amountY, valueXUsd, valueYUsd } = params;
  const tokenIsX = mintY === WSOL_MINT ? true : mintX === WSOL_MINT ? false : null;
  // Non-SOL/non-SOL pair (not expected in range mode): fall back to plain 50:50 on X.
  const plan = planRatioSwap(valueXUsd, valueYUsd, tokenIsX ?? true, tokenIsX === null ? 0.5 : env.TOKEN_SHARE_PCT / 100);
  if (!plan || plan.fraction <= 0) {
    logger.debug('[jupiter] token ratio already near target, skipping swap');
    return { swapped: false };
  }

  const fromMint = plan.fromX ? mintX : mintY;
  const toMint = plan.fromX ? mintY : mintX;
  const fromAmount = plan.fromX ? amountX : amountY;

  const swapAmount = fromAmount.muln(Math.round(plan.fraction * 1_000_000)).divn(1_000_000);
  if (swapAmount.lten(0)) return { swapped: false };

  const result = await swapExactIn(fromMint, toMint, swapAmount);
  // Same read-after-write RPC staleness race as openInitialPosition (see
  // waitForTokenBalance's doc comment in solana.ts) — compoundCycle reads
  // balances again right after this resolves, so confirm the swap's own
  // output actually landed before returning control to the caller.
  const expectedMinimum = new BN(result.outAmount).muln(95).divn(100);
  await waitForTokenBalance(toMint, expectedMinimum);
  return { swapped: true, result };
}

/** Hard-exit / emergency path: dumps 100% of a token balance to SOL. */
export async function emergencySwapAllToSol(mint: string, amount: BN): Promise<SwapResult | null> {
  if (mint === WSOL_MINT || amount.lten(0)) return null;
  logger.warn('[jupiter] emergency swap to SOL', { mint, amount: amount.toString() });
  // Exit dumps get wider slippage: QI-SOL swap-back failed 2x with 0x1771 at 300 bps while the token was being sold off (2026-10-10).
  return swapExactIn(mint, WSOL_MINT, amount, env.JUPITER_EXIT_SLIPPAGE_BPS);
}

export function jupiterClient() {
  return jupiter;
}

export { WSOL_MINT };
export type { QuoteResponse };
