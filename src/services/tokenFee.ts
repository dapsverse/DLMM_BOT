import { PublicKey } from '@solana/web3.js';
import { HTTP_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { transferFeeBps } from '../logic/transferFee.js';
import { isRateLimitError, withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { connection } from './rpc.js';

const cache = new Map<string, number>();

/** Transfer fee of a mint in bps (cached: it only changes via an authority-signed update). null on any failure (fail-closed). */
export async function getTransferFeeBps(mint: string): Promise<number | null> {
  const hit = cache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const res = await withRetry(() => connection.getParsedAccountInfo(new PublicKey(mint)), {
      maxRetries: 3,
      baseDelayMs: HTTP_RETRY_BASE_DELAY_MS,
      isRetryable: isRateLimitError,
      label: 'tokenFee:getMint',
    });
    const data = res.value?.data;
    if (!data || Buffer.isBuffer(data) || Array.isArray(data)) return null;
    const bps = transferFeeBps(data.parsed?.info);
    if (bps !== null) cache.set(mint, bps);
    return bps;
  } catch (err) {
    logger.warn('[tokenFee] mint lookup failed', { mint, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
