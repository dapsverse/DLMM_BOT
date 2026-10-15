/**
 * Self-check for computeFeeAccrual (paperTrade.ts) — fee accrual now
 * requires CONFIRMED in-range status. Fixed 2026-09-30: the old code
 * accrued fee unconditionally every tick regardless of range status, so a
 * position sitting out-of-range (a real DLMM position earns zero swap fees
 * there — one-sided, idle liquidity) still kept collecting fee in the sim,
 * silently cushioning paper-trade's reported drawdown during exactly the
 * stretches (price moving against the position) that matter most for the
 * go-live drawdown criterion.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkFeeAccrual.ts`.
 */
import assert from 'node:assert';
import { computeFeeAccrual } from '../logic/feeAccrual.js';

// In-range: accrues the expected pro-rata share.
const inRangeFee = computeFeeAccrual(1000, 99000, 2400, 1, true); // capital $1000, TVL $99000 -> 1% share, $2400/24h fees, 1h elapsed
assert.strictEqual(inRangeFee, 1, 'expected 1% share of $100/h (2400/24) = $1 for a 1h in-range tick');

// Out-of-range (confirmed false): accrues nothing, regardless of how big the inputs are.
assert.strictEqual(computeFeeAccrual(1000, 99000, 2400, 1, false), 0, 'expected zero fee accrual while confirmed out-of-range');

// Unknown range status (bin lookup failed, null): also accrues nothing - can't confirm we're earning, don't assume we are.
assert.strictEqual(computeFeeAccrual(1000, 99000, 2400, 1, null), 0, 'expected zero fee accrual when range status is unknown (fail closed, not fail open)');

// Zero elapsed time: zero fee even in-range (no division-by-zero or stale-carry surprises).
assert.strictEqual(computeFeeAccrual(1000, 99000, 2400, 0, true), 0, 'expected zero fee for zero elapsed hours');

// Larger capital share scales proportionally.
const biggerShare = computeFeeAccrual(9000, 91000, 2400, 1, true); // 9% share
assert(Math.abs(biggerShare - 9) < 1e-9, `expected ~$9 for a 9% share of $100/h, got ${biggerShare}`);

console.log('OK: fee accrual only counts while confirmed in-range, zero on out-of-range/unknown, scales correctly with capital share');
