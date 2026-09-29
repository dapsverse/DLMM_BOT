import axios from 'axios';
import { HTTP_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { isRateLimitError, withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const RUGCHECK_REPORT_URL = 'https://api.rugcheck.xyz/v1/tokens';

interface RugCheckReport {
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
}

/**
 * True if the mint's mint-authority has been revoked (null on-chain) —
 * replaces rpc.ts's old isMintAuthorityRevoked (direct Solana RPC call,
 * one round-trip per candidate pool). That RPC-per-pool pattern was the
 * dominant load causing sustained Helius 429s once multiple paper-trade
 * instances ran in parallel (confirmed live 2026-09-29). RugCheck's
 * single-token report endpoint is free, unauthenticated, and moves this
 * load to a separate rate-limit bucket entirely (its bulk endpoint needs
 * a paid plan — confirmed live, 401 "requires a paid Rugcheck plan" — so
 * this stays a per-mint call like the RPC version, just to a different
 * service). Verified schema live against a revoked mint (BONK: both
 * `token.mintAuthority`/`token.freezeAuthority` come back null) and a
 * non-revoked one (USDC: both non-null pubkey strings).
 * Returns `null` on any failure — same fail-closed policy as the RPC
 * version this replaces (caller treats null as "don't trust this token").
 */
export async function isMintAuthorityRevokedViaRugCheck(mintAddress: string): Promise<boolean | null> {
  try {
    const res = await withRetry(() => axios.get<RugCheckReport>(`${RUGCHECK_REPORT_URL}/${mintAddress}/report`, { timeout: 10_000 }), {
      maxRetries: 2,
      baseDelayMs: HTTP_RETRY_BASE_DELAY_MS,
      isRetryable: isRateLimitError,
      label: 'rugcheck:report',
    });
    return res.data.token?.mintAuthority === null;
  } catch (err) {
    logger.debug(`[rugcheck] report lookup failed for ${mintAddress}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
