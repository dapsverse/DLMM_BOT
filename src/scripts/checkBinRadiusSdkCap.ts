/**
 * Self-check for computeBinRadius's SDK-safe clamp (binRange.ts) — fixed
 * 2026-10-07 after the real bot's first live entry attempt failed
 * simulation with "Failed to reallocate account data" (InvalidRealloc) on
 * InitializePosition. Root cause: env.MAX_BIN_RADIUS (50) lets
 * computeBinRadius return a radius whose position (2*radius+1 bins) exceeds
 * @meteora-ag/dlmm's own MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX (26) — a hard
 * per-transaction ceiling the SDK enforces via account realloc size, not
 * something retries or priority fees can work around. Fixed by clamping the
 * radius to min(env.MAX_BIN_RADIUS, SDK-safe radius) regardless of env
 * config.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkBinRadiusSdkCap.ts`.
 */
import assert from 'node:assert';
import { computeBinRadius } from '../logic/binRange.js';
import { MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX } from '../services/meteoraDLMM.js';

// Across a wide spread of real bin_step values (15 is the smallest commonly
// seen, 100+ the largest), the resulting position must never span more bins
// than the SDK allows in one tx.
for (const binStep of [1, 2, 5, 10, 15, 20, 25, 50, 80, 100, 125, 250]) {
  const radius = computeBinRadius(binStep);
  const totalBins = 2 * radius + 1;
  assert(
    totalBins <= MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX,
    `binStep=${binStep}: radius=${radius} -> ${totalBins} bins exceeds MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX=${MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX} — the exact live incident this fixes`,
  );
}

console.log('OK: computeBinRadius never returns a radius whose position would exceed the SDK\'s per-tx bin limit, across the full range of real bin_step values');
