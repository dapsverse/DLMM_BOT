/**
 * Self-check for the "chase guard" (see ScannerConfig.chaseGuardPools,
 * meteoraScanner.ts) — added 2026-09-30 after momentum-optAB-90sol sold
 * SI-SOL on a crash-guard exit at ~$23.8M mcap, whipsawed through 2 losing
 * rotations on other tokens over ~7h (both LEFT_POOL_COOLDOWN_MS and
 * BLACKLIST_DURATION_MS long expired by then), then re-bought the SAME
 * token fresh at ~$48.6M mcap — 2x higher than where it sold, with zero
 * memory of the loss. Fixed on PRICE STRUCTURE (has it dipped back to/below
 * the exit price at least once), not a guessed time window — a memecoin
 * can reverse bear->bull faster than any fixed cooldown, so a blanket
 * "wait N hours" would block genuinely valid reversals too.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkChaseGuard.ts`.
 */
import assert from 'node:assert';
import { filterAndRankPools, poolRejectReasons, recordChaseGuardExit, defaultScannerConfig, type MeteoraPair, type ScannerConfig } from '../services/meteoraScanner.js';

const baseConfig: ScannerConfig = defaultScannerConfig(new Map());

function healthyPair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'FAKE_POOL',
    name: 'FAKE-SOL',
    mint_x: 'FAKE_MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    liquidity: String(baseConfig.minTvlUsd + 1),
    trade_volume_24h: baseConfig.minVolume24hUsd + 1,
    fees_24h: 0,
    bin_step: baseConfig.minBinStep,
    current_price: 1,
    createdAtMs: Date.now() - (baseConfig.minPoolAgeHours + 1) * 3_600_000,
    volume1hUsd: baseConfig.minVolume24hUsd,
    volumeH6Usd: baseConfig.minVolume24hUsd * 2,
    fees1hUsd: 0,
    tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 0, holders: baseConfig.minTokenHolders + 1, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
    priceChange6hPct: baseConfig.minPriceChange6hPct + 1,
    ...overrides,
  };
}

// ── 1. Guard blocks a fresh entry above the recorded exit price ─────────

const chaseGuardPools = new Map<string, number>();
recordChaseGuardExit(chaseGuardPools, 'FAKE_MINT', 0.02); // "sold" at $0.02
const config: ScannerConfig = { ...baseConfig, chaseGuardPools };

const stillHigh = healthyPair({ tokenX: { ...healthyPair({}).tokenX, priceUsd: 0.05 } }); // "now" at $0.05, above exit
assert(
  poolRejectReasons(stillHigh, config, { skipSizingChecks: false }).some((r) => r.includes('chase guard')),
  'expected a fresh entry above the recorded exit price to be rejected',
);

// ── 2. Sweep clears the guard once price genuinely dips to/below exit ───

const dipped = healthyPair({ tokenX: { ...healthyPair({}).tokenX, priceUsd: 0.015 } }); // dipped BELOW $0.02 exit
const survivors = await filterAndRankPools([dipped], config, {});
assert(!chaseGuardPools.has('FAKE_MINT'), 'expected the sweep (inside filterAndRankPools) to clear the guard once price dipped to/below the exit price');
assert(
  !poolRejectReasons(dipped, config, { skipSizingChecks: false }).some((r) => r.includes('chase guard')),
  'expected entry to be allowed once the guard is cleared',
);
void survivors; // dipped pair may still fail other checks (e.g. spike floor) - not the point of this check

// ── 3. Reset is permanent, not just a momentary dip below ───────────────

const reGuard = new Map<string, number>();
recordChaseGuardExit(reGuard, 'FAKE_MINT2', 0.02);
const config2: ScannerConfig = { ...baseConfig, chaseGuardPools: reGuard };
const backAbove = healthyPair({ mint_x: 'FAKE_MINT2', tokenX: { ...healthyPair({}).tokenX, address: 'FAKE_MINT2', priceUsd: 0.015 } });
await filterAndRankPools([backAbove], config2, {}); // sweep sees it at 0.015, clears the guard
assert(!reGuard.has('FAKE_MINT2'), 'test setup: expected the guard to clear on the dip');
const priceBackUp = healthyPair({ mint_x: 'FAKE_MINT2', tokenX: { ...healthyPair({}).tokenX, address: 'FAKE_MINT2', priceUsd: 0.08 } }); // price recovered well above old exit
assert(
  !poolRejectReasons(priceBackUp, config2, { skipSizingChecks: false }).some((r) => r.includes('chase guard')),
  'expected the guard to stay cleared even after price rallies back above the old exit price - reset is permanent, not re-armed',
);

// ── 4. Never guarded outside momentum's re-chase scenario (no record) ──

const untouchedConfig: ScannerConfig = { ...baseConfig, chaseGuardPools: new Map() };
assert(
  !poolRejectReasons(healthyPair({}), untouchedConfig, { skipSizingChecks: false }).some((r) => r.includes('chase guard')),
  'expected no chase-guard rejection for a mint that was never recorded as an exit',
);

// ── 5. Entry-only — a HELD position re-screen (skipSizingChecks: true) isn't punished by its own guard ──

const heldConfig: ScannerConfig = { ...baseConfig, chaseGuardPools: new Map([['FAKE_MINT', 0.02]]) };
assert(
  !poolRejectReasons(stillHigh, heldConfig, { skipSizingChecks: true }).some((r) => r.includes('chase guard')),
  'expected the chase guard to be skipped on re-screen (entry-only, like every other capital-sizing-style check)',
);

console.log('OK: chase guard blocks re-entry above last exit price, clears permanently on a genuine dip below it, and stays entry-only');
