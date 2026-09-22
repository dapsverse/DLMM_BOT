import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
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

/**
 * True if the mint's mint-authority has been revoked (set to null on-chain)
 * — i.e. supply is fixed forever, the dev can't print more tokens on top of
 * holders. This is a *different* authority than freeze-authority (which
 * only controls whether individual accounts can be frozen); Meteora's pool
 * API doesn't expose mint-authority at all, so this has to hit the RPC
 * directly. Tries the classic Token program first, then Token-2022 (many
 * newer memecoins use 2022 for transfer-fee/hook extensions).
 * Returns `null` if the mint can't be read at all (fail-closed: caller
 * should treat null as "don't trust this token", not as "assume safe").
 */
export async function isMintAuthorityRevoked(mintAddress: string): Promise<boolean | null> {
  const mint = new PublicKey(mintAddress);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const info = await withRetry(() => getMint(connection, mint, 'confirmed', programId), {
        maxRetries: 2,
        baseDelayMs: RPC_RETRY_BASE_DELAY_MS,
        label: 'getMint',
      });
      return info.mintAuthority === null;
    } catch {
      // wrong token program for this mint, or transient RPC error — try next program / give up below
      continue;
    }
  }
  logger.debug(`[rpc] could not read mint account for ${mintAddress} under either token program`);
  return null;
}

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
