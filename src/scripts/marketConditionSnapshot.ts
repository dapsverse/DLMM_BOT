/**
 * Diagnostic: snapshots the current top-pools universe and reports what
 * fraction of candidates would currently pass each ENTRY_STRATEGY_MODE's
 * own floor (momentum's spike ratio, trend's sustained-move, range's
 * volatility ceiling) — a rough "which mode has the most to work with
 * right now" read.
 *
 * Deliberately NOT an automated switcher — user asked to keep this
 * manual: run it, read the numbers, decide which mode to actually start.
 * Reuses the exact same threshold env vars each mode's real entry screen
 * uses (env.ts), so this approximates production eligibility rather than
 * an ad-hoc heuristic invented just for this script.
 *
 * Usage: tsx src/scripts/marketConditionSnapshot.ts
 */
import { fetchTopPools, hydrateTrendData, nonSolToken, volumeSpikeRatio, defaultScannerConfig, type MeteoraPair } from '../services/meteoraScanner.js';
import { env } from '../config/env.js';

export interface MarketConditionTally {
  totalPools: number;
  rangeEligiblePct: number;
  trendEligiblePct: number;
  momentumEligiblePct: number;
  medianVolatilityPct: number | null;
  medianSpikeRatio: number | null;
  recommendation: 'range' | 'trend' | 'momentum';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure classification — no I/O, testable with synthetic pairs (see
 * checkMarketConditionSnapshot.ts). Assumes hydrateTrendData already ran
 * (priceChange1h/6h/24hPct, volumeH6Usd populated where available) — same
 * precondition poolRejectReasons/diagnoseRejections.ts already document.
 */
export function classifyMarketCondition(pairs: MeteoraPair[]): MarketConditionTally {
  let rangeEligible = 0;
  let trendEligible = 0;
  let momentumEligible = 0;
  const volatilities: number[] = [];
  const spikeRatios: number[] = [];

  for (const pair of pairs) {
    const h1 = pair.priceChange1hPct;
    const h6 = pair.priceChange6hPct;
    const h24 = pair.priceChange24hPct;

    if (h1 !== undefined && h6 !== undefined) {
      volatilities.push(Math.max(Math.abs(h1), Math.abs(h6)));
      if (Math.abs(h1) <= env.RANGE_MAX_VOLATILITY_PCT && Math.abs(h6) <= env.RANGE_MAX_VOLATILITY_PCT) rangeEligible++;
    }
    if (h6 !== undefined && h24 !== undefined && h6 >= env.TREND_MIN_SUSTAINED_PCT && h24 >= env.TREND_MIN_SUSTAINED_PCT) {
      trendEligible++;
    }
    const spike = volumeSpikeRatio(pair);
    spikeRatios.push(spike);
    if (spike >= env.ENTRY_MIN_SPIKE_RATIO) momentumEligible++;
  }

  const total = pairs.length || 1; // avoid div-by-zero; totalPools below reports the real (possibly 0) count
  const rangeEligiblePct = (rangeEligible / total) * 100;
  const trendEligiblePct = (trendEligible / total) * 100;
  const momentumEligiblePct = (momentumEligible / total) * 100;

  const scores: Array<['range' | 'trend' | 'momentum', number]> = [
    ['range', rangeEligiblePct],
    ['trend', trendEligiblePct],
    ['momentum', momentumEligiblePct],
  ];
  scores.sort((a, b) => b[1] - a[1]);

  return {
    totalPools: pairs.length,
    rangeEligiblePct: +rangeEligiblePct.toFixed(1),
    trendEligiblePct: +trendEligiblePct.toFixed(1),
    momentumEligiblePct: +momentumEligiblePct.toFixed(1),
    medianVolatilityPct: median(volatilities),
    medianSpikeRatio: median(spikeRatios),
    recommendation: scores[0]![0],
  };
}

async function main(): Promise<void> {
  const config = defaultScannerConfig(new Map());
  const allPairs = await fetchTopPools();
  // Same basic-health prefilter as diagnoseRejections.ts, same reason:
  // skip mint-authority (RPC-heavy, 429-storms against the full list) and
  // just use TVL/volume floors to drop obviously-dead pools before hydrating.
  const pairs = allPairs.filter((p) => nonSolToken(p) !== null && Number(p.liquidity) >= config.minTvlUsd && p.trade_volume_24h >= config.minVolume24hUsd);
  await hydrateTrendData(pairs);

  const tally = classifyMarketCondition(pairs);

  console.log(`[market-condition] ${tally.totalPools} healthy candidate pools scanned`);
  console.log(`  range-eligible    (calm, |1h| & |6h| <= ${env.RANGE_MAX_VOLATILITY_PCT}%): ${tally.rangeEligiblePct}%`);
  console.log(`  trend-eligible    (sustained, 6h & 24h >= ${env.TREND_MIN_SUSTAINED_PCT}%): ${tally.trendEligiblePct}%`);
  console.log(`  momentum-eligible (spike ratio >= ${env.ENTRY_MIN_SPIKE_RATIO}x):           ${tally.momentumEligiblePct}%`);
  console.log(`  median volatility (max of |1h|,|6h|): ${tally.medianVolatilityPct?.toFixed(2) ?? 'n/a'}%`);
  console.log(`  median volume-spike ratio:            ${tally.medianSpikeRatio?.toFixed(3) ?? 'n/a'}x`);
  console.log(`\n[market-condition] recommendation: ${tally.recommendation.toUpperCase()} mode currently has the most eligible candidates.`);
  console.log('[market-condition] rough single-tick snapshot, not a guarantee — re-run before each session, use judgment alongside it.');
}

// Guard so importing classifyMarketCondition (e.g. from
// checkMarketConditionSnapshot.ts) doesn't trigger a live network fetch —
// only run main() when this file is executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
