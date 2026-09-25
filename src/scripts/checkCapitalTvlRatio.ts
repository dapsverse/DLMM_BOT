/**
 * Self-check for MAX_CAPITAL_TVL_RATIO_PCT (ScannerConfig.maxCapitalTvlRatioPct)
 * — added 2026-09-25 to replace the fixed-dollar MIN_TVL_USD floor as the
 * real slippage-safety gate. A fixed dollar floor doesn't know how big our
 * capital actually is: confirmed live that 6 of 7 sampled ~$300k-mcap pools
 * sat on $472-$22,632 TVL (below even a lowered $35k floor) despite being
 * completely safe for ~$130 capital (0.3-3.3% capital/TVL ratio), while the
 * 7th (MACCA-SOL, $472 TVL) was genuinely too thin (27.5% ratio).
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkCapitalTvlRatio.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, type MeteoraPair } from '../services/meteoraScanner.js';

const config = defaultScannerConfig(new Map());

function healthyPair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'FAKE_POOL',
    name: 'FAKE-SOL',
    mint_x: 'FAKE_MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    liquidity: '10000', // small on purpose — this is exactly the case the ratio check is meant to admit or reject
    trade_volume_24h: config.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: config.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (config.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: config.minVolume24hUsd,
    volumeH6Usd: (config.minVolume24hUsd) * 2,
    fees1hUsd: 0,
    tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 300_000, holders: config.minTokenHolders + 1, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 100, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true }, // SOL @ $100
    priceChange6hPct: config.minPriceChange6hPct + 1,
    ...overrides,
  };
}

// $10,000 TVL, SOL @ $100. capitalSol=1 -> $100 capital -> 1% ratio, well under the 5% default — passes.
const safeRatio = healthyPair({});
assert(
  !poolRejectReasons(safeRatio, config, { skipSizingChecks: false, currentCapitalSol: 1 }).some((r) => r.includes('capital/tvl ratio')),
  'expected a 1% capital/TVL ratio to pass the 5% default ceiling',
);

// Same pool, capitalSol=1 but MACCA-style thin TVL ($472) -> ~21% ratio at $100 capital — should reject.
const thinPool = healthyPair({ liquidity: '472' });
assert(
  poolRejectReasons(thinPool, config, { skipSizingChecks: false, currentCapitalSol: 1 }).some((r) => r.includes('capital/tvl ratio')),
  'expected a thin pool (472 TVL vs $100 capital) to be rejected on capital/tvl ratio',
);

// Entry-only: a held position (skipSizingChecks: true) must NOT be force-exited just because it (or its capital) grew into a bigger ratio.
assert(
  !poolRejectReasons(thinPool, config, { skipSizingChecks: true, currentCapitalSol: 1 }).some((r) => r.includes('capital/tvl ratio')),
  'expected skipSizingChecks to exempt a held position from the capital/tvl ratio check',
);

// Unknown capital (currentCapitalSol not provided) -> permissive-unknown, same policy as the rest of the screen.
assert(
  !poolRejectReasons(thinPool, config, { skipSizingChecks: false }).some((r) => r.includes('capital/tvl ratio')),
  'expected the check to be skipped entirely when currentCapitalSol is not provided',
);

console.log('OK: MAX_CAPITAL_TVL_RATIO_PCT scales with capital, entry-only, permissive on unknown capital');
