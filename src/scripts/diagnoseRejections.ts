/**
 * Diagnostic: shows WHY pools are getting rejected, not just which ones
 * pass (scanOnce.ts only shows survivors). Tallies poolRejectReasons()
 * across the current top-pools list so a "why is NO_CANDIDATE firing every
 * tick" question can be answered with real numbers instead of guessing.
 * Usage: tsx src/scripts/diagnoseRejections.ts
 */
import { fetchTopPools, poolRejectReasons, defaultScannerConfig, hydrateTrendData, nonSolToken } from '../services/meteoraScanner.js';

const config = defaultScannerConfig(new Map());
const allPairs = await fetchTopPools();
// hydrateTrendData assumes every pool has a non-SOL side (same precondition
// filterAndRankPools's stage-1 filter enforces before ever calling it) —
// non-SOL/non-SOL pairs (e.g. USDC/USDT) would crash it otherwise.
const pairs = allPairs.filter((p) => nonSolToken(p) !== null);

// poolRejectReasons assumes hydration already ran (its own doc comment) —
// hydrate ALL fetched (SOL-paired) pools here via DexScreener (batched, ~7
// calls for 200 pools), not just a pre-filtered subset like
// filterAndRankPools does. Deliberately SKIPS hydrateMintAuthority — that's
// one RPC call per pool with no batching, and running it against all ~180
// pools instead of a small pre-filtered handful 429-storms the RPC
// endpoint (confirmed running this once). "mint authority not confirmed
// revoked" will show up as a reason for every pool below as a result —
// that's a diagnostic artifact, not a real rejection; ignore that bucket.
await hydrateTrendData(pairs);

const tally = new Map<string, number>();
let rejectedCount = 0;

for (const pair of pairs) {
  const reasons = poolRejectReasons(pair, config, { skipSizingChecks: false });
  if (reasons.length === 0) continue;
  rejectedCount++;
  // Bucket by replacing every number with '#', so e.g. "1h overextension
  // 72.3% > max 60%" and "1h overextension 91.0% > max 60%" count as the
  // same bucket, without chopping off a leading "5m"/"1h" tag (a naive
  // split-at-first-digit ate those and collapsed unrelated reasons together).
  for (const r of reasons) {
    const bucket = r.replace(/\d+(\.\d+)?/g, '#');
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
  }
}

console.log(`${allPairs.length} pools fetched, ${allPairs.length - pairs.length} skipped (no SOL side), ${rejectedCount}/${pairs.length} rejected (${pairs.length - rejectedCount} pass every check).\n`);
console.log('Rejection reason breakdown (a pool can hit multiple reasons, so this sums to more than rejectedCount):\n');
[...tally.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([reason, count]) => console.log(`  ${count.toString().padStart(4)}  ${reason}`));
