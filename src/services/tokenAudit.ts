import { HTTP_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { parseTokenAudit, type TokenAudit } from '../logic/tokenAudit.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const CACHE_MS = 10 * 60_000; // holder/bot shares drift slowly; avoid hammering the API on every scan tick
const cache = new Map<string, { at: number; audit: TokenAudit }>();

/** Jupiter datapi token facts (free, no key). null on any failure or if the mint is not found (caller fails closed). */
export async function getTokenAudit(mint: string): Promise<TokenAudit | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.audit;
  try {
    const assets = await withRetry(
      async () => {
        const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${mint}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`jupiter datapi ${res.status}`);
        return (await res.json()) as { id?: string }[];
      },
      { maxRetries: 3, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: () => true, label: 'tokenAudit:jup' },
    );
    const asset = Array.isArray(assets) ? assets.find((a) => a?.id === mint) : null; // search is fuzzy: only accept the exact mint
    const audit = parseTokenAudit(asset);
    if (audit) cache.set(mint, { at: Date.now(), audit });
    return audit;
  } catch (err) {
    logger.warn('[tokenAudit] lookup failed', { mint, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
