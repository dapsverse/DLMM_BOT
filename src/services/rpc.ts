import { Connection, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { env } from '../config/env.js';
import { FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS, RPC_MAX_RETRIES, RPC_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

/**
 * Wallet-independent RPC reads. Split out from solana.ts on purpose: that
 * module decodes the wallet's private key eagerly at import time, which
 * would force even read-only tooling (e.g. `npm run scan`, a dry-run
 * mint-authority check) to need a real signing key just to import it.
 * Anything here must stay read-only and must not import solana.ts.
 */

export const connection = new Connection(env.RPC_URL, {
  commitment: 'confirmed',
  wsEndpoint: env.RPC_WS_URL || undefined,
});

// isMintAuthorityRevoked (direct Solana RPC mint-account read) removed
// 2026-09-29 — was the dominant load causing sustained Helius 429s once
// multiple paper-trade instances ran in parallel. Replaced by
// rugcheck.ts's isMintAuthorityRevokedViaRugCheck, which gets the same
// data (mint-authority null-or-not) from RugCheck's free report API
// instead, off Helius entirely.

/**
 * ponytail: @meteora-ag/dlmm has TWO separate problems, both worked around
 * here:
 * 1. Its published .d.ts is corrupted (see the longer writeup in
 *    meteoraDLMM.ts) — the default export's TYPE resolves to the whole
 *    module namespace, not the DLMM class, so `DLMM.create(...)` fails to
 *    type-check even though it works at runtime. Fixed with a one-line
 *    cast (below), duplicated here (not imported from meteoraDLMM.ts)
 *    because that file pulls in solana.ts's eager wallet decode — this
 *    file must stay wallet-free for read-only callers like paperTrade.ts.
 * 2. Its published dist/index.mjs (the ESM build) crashes at import time
 *    under plain Node/tsx ESM resolution: internally it does
 *    `import { BN } from "@coral-xyz/anchor"`, but that package's ESM
 *    entry doesn't actually expose a `BN` named export (confirmed via
 *    `node -e "import('@coral-xyz/anchor').then(m=>console.log(m))"` — BN
 *    is missing from the resolved module, a real bug in that package's
 *    dual CJS/ESM setup). The CJS build (dist/index.js) doesn't have this
 *    problem — CJS `require()` just reads whatever properties exist on
 *    `module.exports`, no static named-export analysis involved. Fix:
 *    force loading via `createRequire` instead of a normal ESM `import`.
 */
const require = createRequire(import.meta.url);
const DLMMPkg = require('@meteora-ag/dlmm');

interface DlmmActiveBinReader {
  getActiveBin(): Promise<{ binId: number }>;
}
interface DlmmStaticReader {
  create(connection: Connection, dlmmAddress: PublicKey): Promise<DlmmActiveBinReader>;
}
const DLMM = DLMMPkg as unknown as DlmmStaticReader;

/** Live active bin id for a pool — read-only, no wallet needed. Null on RPC/lookup failure. */
export async function getActiveBinId(poolAddress: string): Promise<number | null> {
  try {
    const pool = await withRetry(() => DLMM.create(connection, new PublicKey(poolAddress)), {
      maxRetries: 2,
      baseDelayMs: RPC_RETRY_BASE_DELAY_MS,
      label: 'DLMM.create',
    });
    const bin = await withRetry(() => pool.getActiveBin(), {
      maxRetries: 2,
      baseDelayMs: RPC_RETRY_BASE_DELAY_MS,
      label: 'getActiveBin',
    });
    return bin.binId;
  } catch (err) {
    logger.debug(`[rpc] failed to read active bin for ${poolAddress}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Dynamic priority fee (micro-lamports/CU), median of recent fees paid by
 * accounts this tx will touch. Falls back to a static default if the RPC
 * returns nothing (common on quiet devnets / fresh accounts).
 */
export async function getDynamicPriorityFeeMicroLamports(accounts: PublicKey[] = []): Promise<number> {
  try {
    const samples = await withRetry(
      () => connection.getRecentPrioritizationFees(accounts.length ? { lockedWritableAccounts: accounts } : undefined),
      { maxRetries: RPC_MAX_RETRIES, baseDelayMs: RPC_RETRY_BASE_DELAY_MS, label: 'getRecentPrioritizationFees' },
    );
    if (!samples.length) return FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS;

    const fees = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
    const mid = Math.floor(fees.length / 2);
    const median = fees.length % 2 ? fees[mid]! : Math.round(((fees[mid - 1] ?? 0) + (fees[mid] ?? 0)) / 2);
    return Math.max(median, FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS);
  } catch (err) {
    logger.warn('[rpc] failed to fetch dynamic priority fee, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS;
  }
}
