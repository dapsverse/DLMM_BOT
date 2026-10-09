import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const FLOW_TX_CHUNK_SIZE = 25;
const FLOW_TX_CHUNK_DELAY_MS = 200;

export interface DollarFlowResult {
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  /** buyVolumeUsd / (buyVolumeUsd + sellVolumeUsd) — below MIN_DOLLAR_BUY_RATIO (env.ts) is treated as sell-dominant/distribution. */
  buyRatioUsd: number;
  txSampled: number;
}

/**
 * Classifies a list of raw SOL-reserve balance deltas (lamports, positive =
 * buy, negative = sell) into a DollarFlowResult. Pure, no I/O — split out
 * from getDollarVolumeBuyRatio below so the actual classify/aggregate
 * logic is unit-testable without mocking the RPC connection. Exported for
 * a self-check. Returns null if there's no net activity to classify
 * (same "unknown, don't block" meaning as the async wrapper returning null).
 */
/** Below this many classified transactions, the result is too noisy to act on — see its use below for the live incident that motivated it. */
export const MIN_DOLLAR_FLOW_SAMPLE_SIZE = 5;

export function classifyDollarFlow(deltasLamports: number[], solPriceUsd: number): DollarFlowResult | null {
  let buyVolumeUsd = 0;
  let sellVolumeUsd = 0;
  let txSampled = 0;

  for (const deltaLamports of deltasLamports) {
    if (deltaLamports === 0) continue;
    const deltaUsd = (Math.abs(deltaLamports) / 1e9) * solPriceUsd;
    if (deltaLamports > 0) buyVolumeUsd += deltaUsd;
    else sellVolumeUsd += deltaUsd;
    txSampled++;
  }

  const total = buyVolumeUsd + sellVolumeUsd;
  if (total <= 0) return null;
  // Found live 2026-10-08 (BATON-SOL): a single $3.08 sample (txSampled:1,
  // largely because most of the pool's real swap activity routes through
  // address lookup tables that getDollarVolumeBuyRatio wasn't resolving at
  // the time — since fixed, see its doc comment) produced a 100%
  // sell-dominant read and triggered a real exit on a healthy position.
  // Acting on a near-zero sample is worse than not acting at all — treat
  // as unknown (same "don't block on unknown" policy as the rest of the
  // screen) until enough transactions have actually been classified.
  if (txSampled < MIN_DOLLAR_FLOW_SAMPLE_SIZE) return null;

  return { buyVolumeUsd, sellVolumeUsd, buyRatioUsd: buyVolumeUsd / total, txSampled };
}

/**
 * Computes a DOLLAR-volume-weighted buy/sell ratio for a pool by reading
 * its own SOL-side reserve account's recent balance deltas directly
 * on-chain — a genuinely different signal from MeteoraPair.buyRatio1h
 * (a tx-COUNT ratio), which is blind to "many small buys vs a few large
 * sells" distribution patterns. Found live 2026-10-08: HIGGS-SOL's tx
 * counts favored buys at every window while price fell hard the whole
 * time — the count-based ratio called that healthy. DexScreener/Meteora's
 * public APIs expose only tx counts and an undifferentiated total volume,
 * no $ split by side, so this is the only way to get a real answer.
 *
 * Direction: a BUY (trader pays SOL for the token) increases the pool's
 * own SOL reserve balance; a SELL decreases it. Valuing by the SOL leg
 * only (not the token leg) means no token price lookup is needed.
 *
 * Windowed by actual TIME (default last 1 hour — matches the "1h" framing
 * of every other signal in this codebase, e.g. buyRatio1h), not a raw
 * transaction count. Found live 2026-10-08: an earlier count-based design
 * ("last 60 tx, whatever span that covers") was too sensitive on a hot
 * pool — 60 tx there spanned only ~8 minutes, reacting to a brief flurry
 * instead of an hour's real picture. A naive full-1h window risks an
 * UNBOUNDED transaction count on a hot pool though (that same pool would
 * need ~450+ tx to cover a full hour) — `maxTx` hard-caps the batch size
 * regardless. getSignaturesForAddress's own `blockTime` is read for free
 * (no extra RPC call) to find which signatures actually fall inside the
 * window BEFORE fetching any transaction details — only those get
 * batch-fetched via getTransactions (PLURAL — one batched JSON-RPC request
 * for every sampled signature, not N separate getTransaction round-trips;
 * found live 2026-10-08 this was an easy, free efficiency win too, same
 * session). See call sites (index.ts) for why this is scoped to only the
 * pre-entry top candidate and the currently-held position's periodic
 * check, never the full ~200-pool scan — this session already hit several
 * RPC 429-storms from unscoped per-pool RPC work.
 *
 * Returns null (treated as "unknown, don't block" by callers, same
 * permissive-on-unknown policy as the rest of the screen) if the reserve
 * account has no sampled activity or the RPC call fails outright.
 *
 * Resolves account indices via getAccountKeys({accountKeysFromLookups})
 * instead of just staticAccountKeys — found live 2026-10-08 (BATON-SOL):
 * most modern swap transactions (Jupiter-routed especially) load commonly-
 * used accounts like a pool's own reserve via an Address Lookup Table
 * rather than referencing them statically, so staticAccountKeys alone
 * missed nearly all real activity (confirmed: a real position's reserve
 * account sampled only 1 matching transaction out of up to 60 signatures).
 * The combined [static, lookup-writable, lookup-readonly] order matches
 * how preBalances/postBalances are indexed.
 */
export async function getDollarVolumeBuyRatio(
  reserveSolAccount: string,
  solPriceUsd: number,
  windowMs = 60 * 60_000,
  maxTx = 300,
): Promise<DollarFlowResult | null> {
  try {
    const pubkey = new PublicKey(reserveSolAccount);
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: maxTx });
    if (sigs.length === 0) return null;

    const cutoffSec = (Date.now() - windowMs) / 1000;
    const inWindow = sigs.filter((s) => !s.err && s.blockTime !== null && s.blockTime !== undefined && s.blockTime >= cutoffSec);
    if (inWindow.length === 0) return null;

    // No silent truncation: if the maxTx cap itself was hit AND the oldest
    // signature we got is still inside the window, there was MORE real
    // activity in the window than we sampled — the result below is a
    // partial picture, not the full hour.
    const oldestBlockTime = sigs[sigs.length - 1]?.blockTime;
    const partial = sigs.length >= maxTx && oldestBlockTime !== null && oldestBlockTime !== undefined && oldestBlockTime >= cutoffSec;
    // Actual time span the sampled signatures cover (min), capped at the window — a partial read covers far less than windowMs.
    const coveredMin = oldestBlockTime ? +Math.min(windowMs / 60_000, (Date.now() / 1000 - oldestBlockTime) / 60).toFixed(1) : null;
    if (partial) {
      logger.warn('[flowAnalysis] maxTx cap hit before the time window was fully covered — result is a partial window', {
        reserveSolAccount,
        maxTx,
        windowMs,
      });
    }

    // One batched JSON-RPC request for every in-window signature, not N
    // sequential getTransaction round-trips — see this function's doc
    // comment.
    const signaturesToFetch = inWindow.map((s) => s.signature);
    // Chunked + retried (2026-10-08): ONE getTransactions call for up to 300
    // signatures 429'd on every attempt for 6+ hours (136 consecutive
    // failures), and with the entry gate fail-closed that meant the bot could
    // never enter anything. Small chunks with backoff stay under the RPC's
    // rate limit; a chunk that still fails after retries throws -> null ->
    // fail-closed, same as before.
    const txs: Awaited<ReturnType<typeof connection.getTransactions>> = [];
    for (let i = 0; i < signaturesToFetch.length; i += FLOW_TX_CHUNK_SIZE) {
      const chunk = signaturesToFetch.slice(i, i + FLOW_TX_CHUNK_SIZE);
      txs.push(...(await withRetry(() => connection.getTransactions(chunk, { maxSupportedTransactionVersion: 1 }), { maxRetries: 4, baseDelayMs: 600, isRetryable: () => true, label: 'flowAnalysis:getTransactions' })));
      await new Promise((r) => setTimeout(r, FLOW_TX_CHUNK_DELAY_MS));
    }

    const deltasLamports: number[] = [];

    for (const tx of txs) {
      if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) continue;

      const accountKeys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const allKeys = [
        ...accountKeys.staticAccountKeys,
        ...(accountKeys.accountKeysFromLookups?.writable ?? []),
        ...(accountKeys.accountKeysFromLookups?.readonly ?? []),
      ];
      const idx = allKeys.findIndex((k) => k.toBase58() === reserveSolAccount);
      if (idx < 0) continue;

      const preBal = tx.meta.preBalances[idx];
      const postBal = tx.meta.postBalances[idx];
      if (preBal === undefined || postBal === undefined) continue;
      deltasLamports.push(postBal - preBal);
    }

    const result = classifyDollarFlow(deltasLamports, solPriceUsd);
    // Log EVERY reading (pass or fail) so the signal's real value can be evaluated later.
    logger.info('[flowAnalysis] reading', {
      reserveSolAccount,
      buyRatioUsd: result ? +result.buyRatioUsd.toFixed(3) : null,
      buyVolumeUsd: result ? +result.buyVolumeUsd.toFixed(2) : null,
      sellVolumeUsd: result ? +result.sellVolumeUsd.toFixed(2) : null,
      txSampled: result?.txSampled ?? deltasLamports.length,
      sigsInWindow: inWindow.length,
      coveredMin,
      partial,
    });
    return result;
  } catch (err) {
    logger.error('[flowAnalysis] getDollarVolumeBuyRatio failed, treating as unknown', {
      reserveSolAccount,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
