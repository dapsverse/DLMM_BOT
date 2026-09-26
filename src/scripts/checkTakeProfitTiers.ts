/**
 * Self-check for the sticky-per-tier trailing take-profit
 * (trailingTakeProfitFloorPct, riskManager.ts; TAKE_PROFIT_TIERS,
 * constants.ts). Replaced a flat 30%-arm/25pp-giveback 2026-09-26 — see
 * constants.ts's doc comment for why (PAID-SOL peaked +57.71%, exited at
 * +32.28% on the old flat model, kept running to +136%+ afterward).
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkTakeProfitTiers.ts`.
 */
import assert from 'node:assert';
import { trailingTakeProfitFloorPct } from '../logic/riskManager.js';

// Below the first tier's armPct: not armed at all.
assert(trailingTakeProfitFloorPct(29.9) === null, 'expected not-yet-armed (peak < 30%) to return null');

// Sticky within a band: floor stays at the tier's floorPct across the WHOLE
// band, doesn't recompute toward the next tier as peak climbs within it.
assert(trailingTakeProfitFloorPct(30) === 25, 'expected peak=30 (first tier) to floor at 25');
assert(trailingTakeProfitFloorPct(57.71) === 25, 'expected peak=57.71 (still in the 30-100 band) to floor at 25, not 32.71');
assert(trailingTakeProfitFloorPct(99.9) === 25, 'expected peak=99.9 (just under the next tier) to still floor at 25');

// Crossing a tier boundary jumps the floor to the new tier's value.
assert(trailingTakeProfitFloorPct(100) === 50, 'expected peak=100 to floor at 50');
assert(trailingTakeProfitFloorPct(110) === 50, 'expected peak=110 (sticky in the 100-125 band) to floor at 50');
assert(trailingTakeProfitFloorPct(125) === 100, 'expected peak=125 to floor at 100');
assert(trailingTakeProfitFloorPct(140) === 100, 'expected peak=140 (sticky in the 125-150 band) to floor at 100');
assert(trailingTakeProfitFloorPct(150) === 125, 'expected peak=150 to floor at 125');

// Beyond the last tier, the floor rolls using the last tier's giveback
// delta (150-125=25pp) instead of freezing forever.
assert(trailingTakeProfitFloorPct(175) === 150, 'expected peak=175 to roll to floor 150 (175-25)');
assert(trailingTakeProfitFloorPct(200) === 175, 'expected peak=200 to roll to floor 175 (200-25)');

console.log('OK: sticky-per-tier trailing take-profit floors correctly (not-armed, sticky-within-band, tier-jump, post-last-tier rolling)');
