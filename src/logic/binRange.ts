import { env } from '../config/env.js';
import { MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX } from '../services/meteoraDLMM.js';

// A position spans (2*radius + 1) bins — clamp so a single
// openPosition() transaction never exceeds the SDK's own per-tx bin limit.
// See MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX's doc comment for the live incident.
const SDK_SAFE_MAX_RADIUS = Math.floor((MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX - 1) / 2);

/**
 * Converts a target ± price-range coverage (TARGET_RANGE_PCT, e.g. 15%)
 * into a symmetric bin radius for the given pool's bin_step, so a position
 * covers roughly the same ECONOMIC price range regardless of how wide or
 * narrow the pool's bins are. DLMM bin price compounds by (1+binStep/10000)
 * per bin, so N bins covers a price factor of (1+binStep/10000)^N — solve
 * for N given the target factor.
 *
 * A fixed bin-count radius (the old approach) covers wildly different %
 * ranges across pools — e.g. radius=10 is ~±10% on a bin_step=100 pool but
 * only ~±1.6% on bin_step=15 (both seen in real pools this bot has
 * scanned), meaning the "same" setting behaved very differently depending
 * on which pool got picked.
 *
 * ponytail: symmetric only, no directional skew toward the trend — real
 * community evidence for skewing DLMM ranges by trend direction was thin
 * when checked, not worth the complexity without a real signal it helps.
 */
export function computeBinRadius(binStep: number): number {
  const targetFactor = 1 + env.TARGET_RANGE_PCT / 100;
  const raw = Math.log(targetFactor) / Math.log(1 + binStep / 10_000);
  const maxRadius = Math.min(env.MAX_BIN_RADIUS, SDK_SAFE_MAX_RADIUS);
  const clamped = Math.min(Math.max(raw, env.MIN_BIN_RADIUS), maxRadius);
  return Math.round(clamped);
}
