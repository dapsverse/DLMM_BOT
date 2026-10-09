/**
 * Self-check for the two 'range' mode refinements added 2026-09-30 (see
 * RANGE_MIN_TVL_USD / RANGE_CEILING_PROFIT_OVERRIDE_PCT, env.ts):
 *
 * 1. RANGE_MIN_TVL_USD — an absolute (not capital-relative) entry-only TVL
 *    floor for 'range' mode, added after o-SOL entered live paper-trade
 *    TWICE at $11K-16K TVL and HARD_EXIT'd -43%. Distinct from
 *    maxCapitalTvlRatioPct (protects against OUR trade moving a thin pool);
 *    this protects against picking an inherently fragile pool at all.
 * 2. rangeCeilingProfitOverride (riskManager.ts) — a held range position
 *    that fails re-screen ONLY on the volatility ceiling (started trending,
 *    nothing actually wrong) should recenter and keep holding instead of
 *    being abandoned mid-pump, IF currently profitable — added after
 *    'range-optAB-90sol' abandoned a SI-SOL position at ~28% peak profit
 *    right before it ran ~2x further.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkRangeTvlFloorAndProfitOverride.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, type MeteoraPair, type ScannerConfig } from '../services/meteoraScanner.js';
import { rangeCeilingProfitOverride } from '../logic/riskManager.js';

const momentumConfig: ScannerConfig = defaultScannerConfig(new Map());
const rangeConfig: ScannerConfig = { ...momentumConfig, entryStrategyMode: 'range', rangeMaxVolatilityPct: 15, rangeMinTvlUsd: 60_000 };

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
    priceChange1hPct: 2,
    priceChange6hPct: -5,
    ...overrides,
  };
}

// ── 1. RANGE_MIN_TVL_USD ────────────────────────────────────────────────

// Thin pool (like o-SOL's real $11K-16K TVL entries) — rejected in range mode.
const thin = healthyPair({ liquidity: '30000', trade_volume_24h: 100_000 });
assert(
  poolRejectReasons(thin, rangeConfig, { skipSizingChecks: false }).some((r) => r.includes('range mode floor')),
  'expected a pool below RANGE_MIN_TVL_USD to be rejected in range mode',
);

// Same thin pool passes in momentum mode — the floor is range-specific, not a blanket TVL change.
assert(
  !poolRejectReasons(thin, momentumConfig, { skipSizingChecks: false }).some((r) => r.includes('range mode floor')),
  'expected the range-mode TVL floor to NOT apply outside range mode',
);

// Deep pool (like SI-SOL's real $261K-574K TVL entries) — passes.
const deep = healthyPair({ liquidity: '300000', trade_volume_24h: 1_000_000 });
assert(
  !poolRejectReasons(deep, rangeConfig, { skipSizingChecks: false }).some((r) => r.includes('range mode floor')),
  'expected a pool above RANGE_MIN_TVL_USD to pass',
);

// Entry-only — a HELD position re-screened with skipSizingChecks:true isn't punished if its pool's TVL merely shrank.
assert(
  !poolRejectReasons(thin, rangeConfig, { skipSizingChecks: true }).some((r) => r.includes('range mode floor')),
  'expected the range-mode TVL floor to be skipped on re-screen (entry-only, like every other capital-sizing check)',
);

// ── 2. rangeCeilingProfitOverride ───────────────────────────────────────

const ceilingOnlyReasons = ['1h |change| 31.08% > range ceiling 15% - no longer range-bound', '6h |change| 37.48% > range ceiling 15% - no longer range-bound'];
const crashReasons = ['1h crash guard -14.16% < -12%'];
const mixedReasons = [...ceilingOnlyReasons, '5m tx count 5 < min 20'];

// Profitable + ceiling-only reasons → override fires (stay and recenter).
assert(rangeCeilingProfitOverride(ceilingOnlyReasons, 'range', 25), 'expected override to fire: profitable, ceiling-only failure, range mode');

// Not profitable (at/below threshold) → no override even if ceiling-only.
assert(!rangeCeilingProfitOverride(ceilingOnlyReasons, 'range', 0), 'expected no override at exactly 0% profit (threshold is a strict >, matching "selama masih positif")');
assert(!rangeCeilingProfitOverride(ceilingOnlyReasons, 'range', -5), 'expected no override while at a loss — this is exactly the case that should still protect capital');

// Mixed reasons (a REAL risk signal alongside the ceiling one) → no override even if profitable.
assert(!rangeCeilingProfitOverride(mixedReasons, 'range', 25), 'expected no override when any non-ceiling reason is also present (e.g. dead activity) — only a pure thesis-break should be overridden');

// Pure crash-guard failure (real price drop, not a range-ceiling break) → no override even if somehow still profitable.
assert(!rangeCeilingProfitOverride(crashReasons, 'range', 25), 'expected no override for a crash-guard failure — that is a real risk signal, not a broken-thesis-while-winning case');

// Not range mode → no override regardless of reasons/profit (this mechanism is range-specific).
assert(!rangeCeilingProfitOverride(ceilingOnlyReasons, 'momentum', 25), 'expected no override outside range mode');

// No failure reasons at all → nothing to override (already eligible).
assert(!rangeCeilingProfitOverride([], 'range', 25), 'expected no override when there are no reject reasons to begin with');

console.log('OK: RANGE_MIN_TVL_USD rejects thin range-mode entries (entry-only, mode-specific) + rangeCeilingProfitOverride only fires on a pure ceiling-break while profitable');
