/**
 * Self-check for the two new evaluateSwitchOpportunity guards
 * (riskManager.ts) — added 2026-09-23 after SI-SOL got switched away at
 * only +11% profit right as its volume spike cooled, while its mcap kept
 * climbing for hours afterward (2M -> 6M+). Two independent fixes:
 *   1. currentPriceTrendPct: don't abandon a pool that's still genuinely
 *      trending up, even below SWITCH_PROFIT_GUARD_PCT.
 *   2. candidateBuyRatio1h: a $ volume spike can be a dump wearing the same
 *      number as genuine buying pressure — require buys to dominate.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkSwitchGuards.ts`.
 */
import assert from 'node:assert';
import { evaluateSwitchOpportunity, type SwitchEvaluationInput } from '../logic/riskManager.js';

const BASE: SwitchEvaluationInput = {
  currentProfitPct: 11, // below SWITCH_PROFIT_GUARD_PCT (30) — old code would've let this through
  currentSpikeRatio: 0.56,
  candidateSpikeRatio: 1.35, // clears both the 1.0x absolute floor and the 1.5x margin (0.56 * 1.5 = 0.84)
  hasCandidate: true,
  lastSwitchAtMs: null,
};

// Baseline: no trend/buy-ratio data supplied (undefined) — should still switch, same as before these guards existed.
const baseline = evaluateSwitchOpportunity({ ...BASE });
assert(baseline.shouldSwitch, `expected baseline switch to fire, got: ${baseline.reason}`);

// Guard 1: current pool still trending up strongly — should block regardless of the spike numbers above.
const trendBlocked = evaluateSwitchOpportunity({ ...BASE, currentPriceTrendPct: 15 });
assert(!trendBlocked.shouldSwitch, 'expected trend-protect guard to block switch');
assert(trendBlocked.reason.includes('still trending up'), `unexpected reason: ${trendBlocked.reason}`);

// Trend below the protect threshold should NOT block (guard only fires at/above SWITCH_TREND_PROTECT_PCT).
const trendTooLow = evaluateSwitchOpportunity({ ...BASE, currentPriceTrendPct: 2 });
assert(trendTooLow.shouldSwitch, `expected switch to still fire with weak trend, got: ${trendTooLow.reason}`);

// Guard 2: candidate's volume spike is sell-dominant (buys are the minority) — should block.
const sellDominant = evaluateSwitchOpportunity({ ...BASE, candidateBuyRatio1h: 0.3 });
assert(!sellDominant.shouldSwitch, 'expected buy-ratio guard to block a sell-dominant candidate');
assert(sellDominant.reason.includes('sell-dominant'), `unexpected reason: ${sellDominant.reason}`);

// Candidate is buy-dominant — should NOT block.
const buyDominant = evaluateSwitchOpportunity({ ...BASE, candidateBuyRatio1h: 0.7 });
assert(buyDominant.shouldSwitch, `expected switch to fire with a buy-dominant candidate, got: ${buyDominant.reason}`);

console.log('OK: switch trend-protect + buy-dominance guards behave as expected');
