/**
 * Self-check for the 'range' entryStrategyMode (see ENTRY_STRATEGY_MODE /
 * RANGE_MAX_VOLATILITY_PCT, env.ts) — the third entry track added
 * 2026-09-26, paired with the DLMM/LP execution path specifically (opposite
 * thesis from 'momentum'/'trend': low volatility + high turnover = fee
 * yield with minimal IL, instead of chasing a directional move).
 *
 * Verifies: the volatility ceiling rejects trending pools and passes calm
 * ones (fail-closed on unknown, same as trend mode); rankRangeCandidates
 * sorts by vol/TVL turnover, not spike or TVL; and — the one genuinely
 * different piece of plumbing here — the volatility ceiling stays ACTIVE on
 * re-screen (skipSizingChecks: true), unlike every other sizing check,
 * because a held range position breaking into a trend is exactly the
 * signal to reconsider it.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkRangeMode.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, rankRangeCandidates, type MeteoraPair, type ScannerConfig } from '../services/meteoraScanner.js';

const momentumConfig: ScannerConfig = defaultScannerConfig(new Map());
const rangeConfig: ScannerConfig = { ...momentumConfig, entryStrategyMode: 'range', rangeMaxVolatilityPct: 15 };

function healthyPair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'FAKE_POOL',
    name: 'FAKE-SOL',
    mint_x: 'FAKE_MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    liquidity: String(momentumConfig.minTvlUsd + 1),
    trade_volume_24h: momentumConfig.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: momentumConfig.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (momentumConfig.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: momentumConfig.minVolume24hUsd,
    volumeH6Usd: momentumConfig.minVolume24hUsd * 2,
    fees1hUsd: 0,
    tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 0, holders: momentumConfig.minTokenHolders + 1, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
    priceChange6hPct: momentumConfig.minPriceChange6hPct + 1,
    ...overrides,
  };
}

// Calm pool (real range-bound candidate): passes.
const calm = healthyPair({ priceChange1hPct: 2, priceChange6hPct: -5 });
assert(
  !poolRejectReasons(calm, rangeConfig, { skipSizingChecks: false }).some((r) => r.includes('range ceiling')),
  'expected a calm pool (well under the volatility ceiling) to pass range mode entry',
);

// Trending pool (momentum-style breakout): rejected in range mode even though it'd be a GREAT momentum candidate.
const trending = healthyPair({ priceChange1hPct: 25, priceChange6hPct: 40 });
assert(
  poolRejectReasons(trending, rangeConfig, { skipSizingChecks: false }).some((r) => r.includes('1h |change|') && r.includes('range ceiling')),
  'expected a trending pool to be rejected by range mode entry (opposite thesis from momentum/trend)',
);

// Unknown volatility data fails closed (same policy as trend mode).
const unknownVol = healthyPair({ priceChange1hPct: undefined, priceChange6hPct: undefined });
assert(
  poolRejectReasons(unknownVol, rangeConfig, { skipSizingChecks: false }).some((r) => r.includes('range ceiling')),
  'expected range mode to reject (fail closed) when 1h/6h change is unknown',
);

// THE key behavioral difference vs every other sizing check: volatility ceiling stays live on re-screen (skipSizingChecks: true).
assert(
  poolRejectReasons(trending, rangeConfig, { skipSizingChecks: true }).some((r) => r.includes('range ceiling')),
  'expected the range volatility ceiling to NOT be skipped on re-screen — a held position breaking into a trend must still be caught',
);
// Contrast: momentum mode's spike floor IS skipped on re-screen (existing, unchanged behavior) — proves this is a deliberate difference, not a shared bug.
const cooledMomentum = healthyPair({ volume1hUsd: 10, volumeH6Usd: 1000 }); // low spike ratio
assert(
  !poolRejectReasons(cooledMomentum, momentumConfig, { skipSizingChecks: true }).some((r) => r.includes('not actually accelerating')),
  'test setup: expected momentum mode\'s spike floor to remain skip-on-re-screen (unchanged, contrast case)',
);

// rankRangeCandidates sorts by vol/TVL turnover, not spike or raw TVL.
const lowTurnover = healthyPair({ address: 'LOW_TURNOVER', liquidity: '500000', trade_volume_24h: 500000 }); // 1x vol/TVL
const highTurnover = healthyPair({ address: 'HIGH_TURNOVER', liquidity: '100000', trade_volume_24h: 2000000 }); // 20x vol/TVL, smaller pool
const ranked = rankRangeCandidates([lowTurnover, highTurnover]);
assert(ranked[0]!.address === 'HIGH_TURNOVER', 'expected rankRangeCandidates to put the higher vol/TVL turnover pool first regardless of its smaller absolute TVL');

console.log('OK: range mode inverts trend/momentum (rejects volatility, ranks by turnover) + volatility ceiling stays live on re-screen (unlike every other sizing check)');
