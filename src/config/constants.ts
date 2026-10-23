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
// Batch endpoint: up to 30 comma-separated token addresses per call, billed
// as ONE request against DexScreener's 300/min limit — the fix for this
// week's 429 storms, which were caused by one-call-per-pool concurrency,
// not by polling too often. https://docs.dexscreener.com/api/reference
export const DEXSCREENER_TOKENS_BATCH_URL = 'https://api.dexscreener.com/tokens/v1';
export const DEXSCREENER_BATCH_MAX_ADDRESSES = 30;
export const SOLANA_CHAIN_ID = 'solana';

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

/**
 * Trailing take-profit schedule — a RATCHET: the floor follows the peak and locks most of the gain.
 * Anchors (peak -> floor) are joined by straight lines (trailingTakeProfitFloorPct, riskManager.ts), so the floor is continuous and never
 * decreases while the peak rises (no plateaus, no jumps). Below the first anchor's armPct take-profit is not armed (a flip then waits / the
 * stop loss decides). Above the last anchor the floor keeps the last anchor's giveback (150 -> 130 = 20pp). Locked share of the peak:
 * 12 -> 58%, 20 -> 73%, 30 -> 77%, 50 -> 80%, 100 -> 85%, 150 -> 87%; peak 21.4 -> floor ~15.7 (gives back ~5.7pp; it was 15.4pp).
 *
 * History: 2026-09-26 replaced a flat 30% arm / 25pp giveback with sticky wide bands (peak 12-30 -> floor 6, 30-100 -> 25, ...) after PAID-SOL
 * peaked +57.71% and was exited at +32.28% (it ran to +136%+). Live 2026-10-23 (pool 9fm4XN, flip phase) the sticky 6% floor at a +21.4% peak
 * gave back ~72% of the profit and the position ended at the stop loss; user decision 2026-10-24: lock most of the peak, tighter as it grows.
 * Low-confidence starting values like every other threshold in this file: a runner now gives back less before it is closed.
 */
export const TAKE_PROFIT_TIERS: ReadonlyArray<{ armPct: number; floorPct: number }> = [
  { armPct: 12, floorPct: 7 },
  { armPct: 20, floorPct: 14.5 },
  { armPct: 30, floorPct: 23 },
  { armPct: 50, floorPct: 40 },
  { armPct: 100, floorPct: 85 },
  { armPct: 150, floorPct: 130 },
];

export const RPC_MAX_RETRIES = 5;
export const RPC_RETRY_BASE_DELAY_MS = 500;

export const HTTP_MAX_RETRIES = 4;
export const HTTP_RETRY_BASE_DELAY_MS = 1_000;

/** DLMM position bin-array/position account rent, in SOL — used for gas/threshold estimates. */
export const EST_POSITION_RENT_SOL = 0.058;

/** Fallback priority fee (micro-lamports/CU) if `getRecentPrioritizationFees` returns nothing. */
export const FALLBACK_PRIORITY_FEE_MICRO_LAMPORTS = 50_000;

export const COMPUTE_UNIT_LIMIT = 400_000;
