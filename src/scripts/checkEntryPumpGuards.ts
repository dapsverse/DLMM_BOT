/**
 * Self-check for the P1 (overextension ceiling, 1h + 24h), P2 (buy-ratio
 * reject), and entry-spike-floor entry-screen guards — see SCREEN_RULE.MD
 * "P0-P4" for the full rationale (post-entry troughs of -8% to -28%
 * observed live, traced to the ranking chasing already-extended pumps).
 *
 *   P1 (maxPriceChange1hPumpPct / maxPriceChange24hPumpPct): reject a pool
 *   up more than the ceiling in the last hour OR the last 24h — entry-only
 *   (skipSizingChecks exempts a held position from being force-exited just
 *   for pumping hard).
 *   P2 (buyRatio1h floor): reject a pool whose 1h volume is sell-dominant —
 *   applies in BOTH modes (health check, not a sizing check).
 *   Entry spike floor (ENTRY_MIN_SPIKE_RATIO, added 2026-09-24): reject a
 *   fresh entry whose volumeSpikeRatio is below 1.0x (not accelerating at
 *   all) — entry-only, ranking alone can't help when it's the only
 *   candidate. Confirmed live: familiars-SOL entered at spike 0.182x with
 *   priceChange24hPct +4400%, a stale runner, because 5 straight scans
 *   found nothing else.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkEntryPumpGuards.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, volumeSpikeRatio, type MeteoraPair } from '../services/meteoraScanner.js';

const config = defaultScannerConfig(new Map());

function healthyPair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'FAKE_POOL',
    name: 'FAKE-SOL',
    mint_x: 'FAKE_MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    reserve_x: 'FAKE_RESERVE_X',
    reserve_y: 'FAKE_RESERVE_Y',
    liquidity: String(config.minTvlUsd + 1),
    trade_volume_24h: config.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: config.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (config.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: config.minVolume24hUsd,
    volumeH6Usd: config.minVolume24hUsd * 2, // spikeRatio ~5x by default — a genuinely healthy baseline, overridden per-test below
    fees1hUsd: 0,
    baseFeePct: 1,
    feeTvlRatio24h: 1,
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

// P1b: entry-only 24h overextension ceiling (GO-SOL incident: 1h/6h looked
// calm, 24h was +4637% — an already-played-out runner the 1h ceiling alone
// missed).
const stale24h = healthyPair({ priceChange1hPct: 10, priceChange24hPct: config.maxPriceChange24hPumpPct + 100 });
assert(
  poolRejectReasons(stale24h, config, { skipSizingChecks: false }).some((r) => r.includes('24h overextension')),
  'expected fresh-entry screen to reject a pool over the 24h pump ceiling even with a calm 1h number',
);
assert(
  !poolRejectReasons(stale24h, config, { skipSizingChecks: true }).some((r) => r.includes('24h overextension')),
  'expected a held position up hard over 24h to NOT be force-exited (skipSizingChecks)',
);
const fresh24h = healthyPair({ priceChange1hPct: 10, priceChange24hPct: config.maxPriceChange24hPumpPct - 10 });
assert(
  !poolRejectReasons(fresh24h, config, { skipSizingChecks: false }).some((r) => r.includes('24h overextension')),
  'expected a pool under the 24h ceiling to pass',
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

// Entry spike floor: cooled-off pool (like familiars-SOL, ~0.18x) rejected on fresh entry, allowed on re-screen.
const cooled = healthyPair({ volume1hUsd: 91, volumeH6Usd: 1000 }); // (1000-91)/5=181.8 prior pace, 91/181.8≈0.5x
assert(volumeSpikeRatio(cooled) < 1.0, `test setup: expected cooled fixture spike < 1.0x, got ${volumeSpikeRatio(cooled)}`);
assert(
  poolRejectReasons(cooled, config, { skipSizingChecks: false }).some((r) => r.includes('not actually accelerating')),
  'expected fresh-entry screen to reject a cooled-off (sub-1.0x spike) pool',
);
assert(
  !poolRejectReasons(cooled, config, { skipSizingChecks: true }).some((r) => r.includes('not actually accelerating')),
  'expected a held position whose spike cooled off to NOT be force-exited (skipSizingChecks)',
);
const accelerating = healthyPair({}); // default fixture already has ~5x spike
assert(volumeSpikeRatio(accelerating) >= 1.0, `test setup: expected default fixture spike >= 1.0x, got ${volumeSpikeRatio(accelerating)}`);
assert(
  !poolRejectReasons(accelerating, config, { skipSizingChecks: false }).some((r) => r.includes('not actually accelerating')),
  'expected an accelerating pool to pass the entry spike floor',
);

console.log('OK: P1 overextension ceiling + P2 buy-ratio guard + entry spike floor behave as expected');
