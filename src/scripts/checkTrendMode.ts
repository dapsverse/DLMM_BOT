/**
 * Self-check for the 'trend' entryStrategyMode (see ENTRY_STRATEGY_MODE,
 * env.ts) — the second entry track added 2026-09-26 after SI-SOL's real
 * pool ($685k TVL, +66% 6h / +46% 24h, spike ratio only 0.21x) got rejected
 * by the momentum track's spike floor on every running instance the same
 * night every "new spike" pick crashed -12% to -50%.
 *
 * Verifies mode isolation: momentum mode still enforces the spike floor and
 * ignores sustained-trend; trend mode does the opposite (skips spike floor,
 * requires BOTH 6h and 24h to clear the trend floor, fails closed on
 * unknown) — and rankTrendCandidates sorts by TVL, not acceleration.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkTrendMode.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, rankTrendCandidates, type MeteoraPair, type ScannerConfig } from '../services/meteoraScanner.js';

const momentumConfig: ScannerConfig = defaultScannerConfig(new Map());
assert(momentumConfig.entryStrategyMode === 'momentum', 'test setup: expected default entryStrategyMode to be momentum');
const trendConfig: ScannerConfig = { ...momentumConfig, entryStrategyMode: 'trend', trendMinSustainedPct: 20 };

function healthyPair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'FAKE_POOL',
    name: 'FAKE-SOL',
    mint_x: 'FAKE_MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    reserve_x: 'FAKE_RESERVE_X',
    reserve_y: 'FAKE_RESERVE_Y',
    liquidity: String(momentumConfig.minTvlUsd + 1),
    trade_volume_24h: momentumConfig.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: momentumConfig.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (momentumConfig.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: momentumConfig.minVolume24hUsd,
    volumeH6Usd: momentumConfig.minVolume24hUsd * 2,
    fees1hUsd: 0,
    baseFeePct: 1,
    feeTvlRatio24h: 1,
    tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 0, holders: momentumConfig.minTokenHolders + 1, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
    priceChange6hPct: momentumConfig.minPriceChange6hPct + 1,
    ...overrides,
  };
}

// SI-SOL-shaped pool: huge sustained move, but cooled-off CURRENT pace (low spike ratio).
const established = healthyPair({
  liquidity: '685854',
  volume1hUsd: 140000, // low relative to volumeH6Usd below -> low spikeRatio
  volumeH6Usd: 3530000,
  priceChange6hPct: 66,
  priceChange24hPct: 46,
});

// Momentum mode: rejected on spike floor (this IS the SI-SOL incident).
assert(
  poolRejectReasons(established, momentumConfig, { skipSizingChecks: false }).some((r) => r.includes('not actually accelerating')),
  'expected momentum mode to reject an established-but-not-currently-accelerating pool on the spike floor',
);

// Trend mode: spike floor NOT applied, sustained-trend floor passes -> no rejection from either.
const trendReasons = poolRejectReasons(established, trendConfig, { skipSizingChecks: false });
assert(!trendReasons.some((r) => r.includes('not actually accelerating')), 'expected trend mode to never check the spike floor');
assert(!trendReasons.some((r) => r.includes('trend floor')), 'expected an SI-SOL-shaped pool (66%/46%) to clear a 20% trend floor');

// Trend mode: a pool WITHOUT a sustained move (fresh mini-spike, low 6h/24h) gets rejected.
const freshSpike = healthyPair({ priceChange6hPct: 5, priceChange24hPct: 8, volume1hUsd: momentumConfig.minVolume24hUsd * 5 });
const freshSpikeReasons = poolRejectReasons(freshSpike, trendConfig, { skipSizingChecks: false });
assert(freshSpikeReasons.some((r) => r.includes('6h change') && r.includes('trend floor')), 'expected trend mode to reject a fresh mini-spike lacking a sustained 6h move');

// Trend mode fails CLOSED on unknown 6h/24h data (unlike the rest of the permissive-unknown screen).
const unknownTrend = healthyPair({ priceChange6hPct: undefined, priceChange24hPct: undefined });
const unknownReasons = poolRejectReasons(unknownTrend, trendConfig, { skipSizingChecks: false });
assert(unknownReasons.some((r) => r.includes('trend floor')), 'expected trend mode to reject (fail closed) when 6h/24h change is unknown');

// Re-screen mode (skipSizingChecks: true): trend floor is entry-only, like the spike floor — a held trend position isn't force-exited for cooling off.
assert(
  !poolRejectReasons(freshSpike, trendConfig, { skipSizingChecks: true }).some((r) => r.includes('trend floor')),
  'expected the trend floor to be skipped on re-screen (entry-only, same policy as the spike floor)',
);

// rankTrendCandidates sorts by TVL descending, not acceleration.
const small = healthyPair({ address: 'SMALL', liquidity: '50000', volume1hUsd: momentumConfig.minVolume24hUsd * 10 }); // huge spike, small TVL
const big = healthyPair({ address: 'BIG', liquidity: '900000', volume1hUsd: momentumConfig.minVolume24hUsd }); // no spike, big TVL
const ranked = rankTrendCandidates([small, big]);
assert(ranked[0]!.address === 'BIG', 'expected rankTrendCandidates to put the bigger-TVL pool first regardless of its spike ratio');

console.log('OK: trend mode skips spike floor + enforces sustained 6h/24h floor (fail-closed, entry-only) + ranks by TVL — isolated from momentum mode');
