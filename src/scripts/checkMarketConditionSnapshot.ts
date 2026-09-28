/**
 * Self-check for classifyMarketCondition (marketConditionSnapshot.ts) —
 * pure function, tested with synthetic pairs, no network. Verifies each
 * mode's eligibility rule matches its real entry-screen floor (env.ts)
 * and that the recommendation picks whichever mode has the most eligible
 * candidates.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkMarketConditionSnapshot.ts`.
 */
import assert from 'node:assert';
import { classifyMarketCondition } from './marketConditionSnapshot.js';
import { env } from '../config/env.js';
import type { MeteoraPair } from '../services/meteoraScanner.js';

function pair(overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: 'addr',
    name: 'TEST-SOL',
    mint_x: 'x',
    mint_y: 'y',
    liquidity: '100000',
    trade_volume_24h: 500_000,
    fees_24h: 100,
    bin_step: 25,
    current_price: 1,
    createdAtMs: Date.now(),
    volume1hUsd: 1000,
    fees1hUsd: 1,
    tokenX: { address: 'x', priceUsd: 1, marketCapUsd: 1_000_000, holders: 100, freezeAuthorityDisabled: true },
    tokenY: { address: 'y', priceUsd: 1, marketCapUsd: 1_000_000, holders: 100, freezeAuthorityDisabled: true },
    ...overrides,
  };
}

// A pool with no volumeH6Usd -> volumeSpikeRatio returns 0 (undefined h6),
// small 1h/6h moves -> range-eligible, flat 24h -> not trend-eligible.
const calmPool = pair({ priceChange1hPct: 2, priceChange6hPct: 3, priceChange24hPct: 5 });

// A pool that clears trend's sustained floor on both windows but is way
// too volatile for range.
const trendingPool = pair({
  priceChange1hPct: 10,
  priceChange6hPct: env.TREND_MIN_SUSTAINED_PCT + 5,
  priceChange24hPct: env.TREND_MIN_SUSTAINED_PCT + 10,
});

// A pool accelerating hard right now (volumeH6Usd << 6x volume1hUsd -> high spike ratio).
const momentumPool = pair({
  priceChange1hPct: 20, // > RANGE_MAX_VOLATILITY_PCT, keeps this OUT of range-eligible too
  priceChange6hPct: 6, // stays well under TREND_MIN_SUSTAINED_PCT, keeps this OUT of trend-eligible
  priceChange24hPct: 8,
  volume1hUsd: 10_000,
  volumeH6Usd: 12_000, // priorPace = (12000-10000)/5 = 400; ratio = 10000/400 = 25x
});

const calmTally = classifyMarketCondition([calmPool, calmPool, calmPool]);
assert(calmTally.rangeEligiblePct === 100, `expected an all-calm sample to be 100% range-eligible, got ${calmTally.rangeEligiblePct}`);
assert(calmTally.trendEligiblePct === 0, 'expected an all-calm sample to have 0% trend-eligible');
assert(calmTally.recommendation === 'range', `expected recommendation 'range' for an all-calm sample, got ${calmTally.recommendation}`);

const trendTally = classifyMarketCondition([trendingPool, trendingPool]);
assert(trendTally.trendEligiblePct === 100, `expected an all-trending sample to be 100% trend-eligible, got ${trendTally.trendEligiblePct}`);
assert(trendTally.rangeEligiblePct === 0, 'expected an all-trending (volatile) sample to have 0% range-eligible');
assert(trendTally.recommendation === 'trend', `expected recommendation 'trend', got ${trendTally.recommendation}`);

const momentumTally = classifyMarketCondition([momentumPool]);
assert(momentumTally.momentumEligiblePct === 100, `expected the accelerating pool to be 100% momentum-eligible, got ${momentumTally.momentumEligiblePct}`);
assert(momentumTally.recommendation === 'momentum', `expected recommendation 'momentum', got ${momentumTally.recommendation}`);

// Mixed sample: recommendation follows whichever mode has more eligible candidates.
const mixed = classifyMarketCondition([calmPool, calmPool, trendingPool]);
assert(mixed.recommendation === 'range', `expected 'range' to win a 2-calm-vs-1-trending sample, got ${mixed.recommendation}`);

// Empty input doesn't crash and reports 0 pools, not NaN percentages.
const empty = classifyMarketCondition([]);
assert(empty.totalPools === 0, 'expected empty input to report 0 totalPools');
assert(!Number.isNaN(empty.rangeEligiblePct) && empty.rangeEligiblePct === 0, 'expected empty input to report 0%, not NaN');

console.log('OK: classifyMarketCondition matches each mode\'s real threshold, recommendation follows the highest-eligible mode, empty input is safe');
