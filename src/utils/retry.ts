import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Called to decide if a given error is worth retrying (default: always). */
  isRetryable?: (err: unknown) => boolean;
  label?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for axios-style 429 responses. */
export function isRateLimitError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 429;
}

/**
 * Generic exponential-backoff wrapper with jitter. Honors a `Retry-After`
 * header when present (common on 429s), otherwise doubles the base delay.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const isRetryable = opts.isRetryable ?? (() => true);
  const label = opts.label ?? 'operation';

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) throw err;

      const retryAfterHeader = (err as { response?: { headers?: Record<string, string> } })
        ?.response?.headers?.['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1_000 : undefined;
      const backoffMs = retryAfterMs ?? baseDelayMs * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * 250);
      const delay = backoffMs + jitterMs;

      logger.warn(`[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — plain
 * chunking, no queue library. Used for hydration passes that hit public
 * rate-limited APIs (DexScreener, public Solana RPC) per-candidate; an
 * unbounded `Promise.all` there reliably triggers 429 storms once the
 * candidate list is more than a handful of pools.
 */
export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}
