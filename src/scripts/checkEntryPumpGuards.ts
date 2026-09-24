/**
 * Self-check for the P1 (overextension ceiling) and P2 (buy-ratio reject)
 * entry-screen guards added 2026-09-24 — see SCREEN_RULE.MD "P0-P4" for the
 * full rationale (post-entry troughs of -8% to -28% observed live, traced
 * to the ranking chasing already-extended pumps).
 *
 *   P1 (maxPriceChange1hPumpPct): reject a pool up more than the ceiling in
 *   the last hour — entry-only (skipSizingChecks exempts a held position
 *   from being force-exited just for pumping hard).
 *   P2 (buyRatio1h floor): reject a pool whose 1h volume is sell-dominant —
 *   applies in BOTH modes (health check, not a sizing check).
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkEntryPumpGuards.ts`.
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
    liquidity: String(config.minTvlUsd + 1),
    trade_volume_24h: config.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: config.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (config.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: config.minVolume24hUsd,
    fees1hUsd: 0,
    tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 0, holders: config.minTokenHolders + 1, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
    priceChange6hPct: config.minPriceChange6hPct + 1,
    ...overrides,
  };
}

// P1: entry-only overextension ceiling.
const overextended = healthyPair({ priceChange1hPct: config.maxPriceChange1hPumpPct + 10 });
assert(
  poolRejectReasons(overextended, config, { skipSizingChecks: false }).some((r) => r.includes('overextension')),
  'expected fresh-entry screen to reject a pool over the 1h pump ceiling',
);
assert(
  !poolRejectReasons(overextended, config, { skipSizingChecks: true }).some((r) => r.includes('overextension')),
  'expected a held position pumping hard to NOT be force-exited (skipSizingChecks)',
);
const notOverextended = healthyPair({ priceChange1hPct: config.maxPriceChange1hPumpPct - 5 });
assert(
  !poolRejectReasons(notOverextended, config, { skipSizingChecks: false }).some((r) => r.includes('overextension')),
  'expected a pool under the ceiling to pass',
);

// P2: buy-ratio floor, both modes.
const sellDominant = healthyPair({ buyRatio1h: 0.3 });
assert(
  poolRejectReasons(sellDominant, config, { skipSizingChecks: false }).some((r) => r.includes('sell-dominant')),
  'expected fresh-entry screen to reject a sell-dominant pool',
);
assert(
  poolRejectReasons(sellDominant, config, { skipSizingChecks: true }).some((r) => r.includes('sell-dominant')),
  'expected re-screen to ALSO reject a sell-dominant pool (health check, not a sizing check)',
);
const buyDominant = healthyPair({ buyRatio1h: 0.7 });
assert(
  !poolRejectReasons(buyDominant, config, { skipSizingChecks: false }).some((r) => r.includes('sell-dominant')),
  'expected a buy-dominant pool to pass',
);
const unknownBuyRatio = healthyPair({ buyRatio1h: undefined });
assert(
  !poolRejectReasons(unknownBuyRatio, config, { skipSizingChecks: false }).some((r) => r.includes('sell-dominant')),
  'expected unknown buy-ratio data to not block (permissive-unknown policy)',
);

console.log('OK: P1 overextension ceiling + P2 buy-ratio guard behave as expected');
