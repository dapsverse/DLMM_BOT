/** Static constants — values that don't vary per deployment, unlike env.ts. */

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ponytail: old `dlmm-api.meteora.ag/pair/all` (flat, single-array) 404s as
// of Sept 2026 — Meteora migrated to a new paginated Data API with a nested
// response shape. See meteoraScanner.ts for the normalization step.
export const METEORA_POOLS_URL = 'https://dlmm.datapi.meteora.ag/pools';
/** How many top-by-volume pools to pull per scan (there are 100k+ pools total; we only care about the top slice anyway since MIN_24H_VOLUME_USD already floors out the long tail). */
export const METEORA_POOLS_PAGE_SIZE = 200;
export const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';

/** Minimum allowed gap between pool-list polls, enforced regardless of config. */
export const MIN_SCAN_INTERVAL_MS = 60_000;

/**
 * Price move over trailing 1h that disqualifies a candidate pool (crash
 * guard). Was -20%; tightened to -12% — memecoins can dump 30-50%+ in
 * minutes on a rug/large sell, and momentum-bot practice for high-volatility
 * assets generally uses -10% to -15%/1h, not -20% (closer to a
 * portfolio-level drawdown threshold, too loose for a single volatile
 * asset). Research-backed, not a published memecoin-bot spec — treat as
 * directional, revisit if it starves candidates too hard in practice.
 */
export const PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT = -12;

/** How many of the strongest-6h-trend candidates to shortlist before picking the best volume-spike ratio among them. */
export const TREND_SHORTLIST_SIZE = 3;

export const RPC_MAX_RETRIES = 5;
export const RPC_RETRY_BASE_DELAY_MS = 500;

export const HTTP_MAX_RETRIES = 4;
export const HTTP_RETRY_BASE_DELAY_MS = 1_000;

/** DLMM position bin-array/position account rent, in SOL — used for gas/threshold estimates. */
export const EST_POSITION_RENT_SOL = 0.058;

/** Fallback priority fee (micro-lamports/CU) if `getRecentPrioritizationFees` returns nothing. */
export const FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS = 50_000;

export const COMPUTE_UNIT_LIMIT = 400_000;
