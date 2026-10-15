/**
 * Self-check for computeOutOfRangeTracking (logic/outOfRangeTracking.ts) —
 * the 2026-09-24 debounce fix. Confirmed live: familiars-SOL flickered
 * in/out of range on ordinary price noise right at the boundary, and the
 * old logic (reset outOfRangeSinceMs to null on ANY single in-range tick)
 * meant the idle-forced rebalance never got a clean 10-minute streak,
 * despite the position being effectively out-of-range most of the time.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkOutOfRangeDebounce.ts`.
 */
import assert from 'node:assert';
import { computeOutOfRangeTracking, OUT_OF_RANGE_RESET_GRACE_MS } from '../logic/outOfRangeTracking.js';

let t = 0;
let state = { outOfRangeSinceMs: null as number | null, inRangeSinceMs: null as number | null };

// Goes out of range at t=0.
state = computeOutOfRangeTracking(state, true, t);
assert.strictEqual(state.outOfRangeSinceMs, 0, 'expected outOfRangeSinceMs to be set on first out-of-range tick');

// A momentary in-range blip at t=60s should NOT immediately clear the streak.
t = 60_000;
state = computeOutOfRangeTracking(state, false, t);
assert.strictEqual(state.outOfRangeSinceMs, 0, 'expected a brief in-range blip to keep the original out-of-range timestamp (debounced)');
assert.strictEqual(state.inRangeSinceMs, t, 'expected inRangeSinceMs to start tracking the blip');

// Back out of range at t=90s, before the grace period elapsed — streak survives, inRangeSinceMs clears.
t = 90_000;
state = computeOutOfRangeTracking(state, true, t);
assert.strictEqual(state.outOfRangeSinceMs, 0, 'expected the original out-of-range timestamp to survive a short flicker');
assert.strictEqual(state.inRangeSinceMs, null, 'expected inRangeSinceMs to clear once back out of range');

// Genuinely settles in-range for the full grace period — NOW it should reset.
t = 90_000 + OUT_OF_RANGE_RESET_GRACE_MS;
state = computeOutOfRangeTracking(state, false, 90_000); // back in range starting at t=90s
state = computeOutOfRangeTracking(state, false, t); // still in range once the grace period has fully elapsed
assert.strictEqual(state.outOfRangeSinceMs, null, 'expected outOfRangeSinceMs to reset after a full grace period of continuous in-range');
assert.strictEqual(state.inRangeSinceMs, null, 'expected inRangeSinceMs to reset alongside it');

// Sanity: fresh position, already in range, stays fully reset (no-op).
const fresh = computeOutOfRangeTracking({ outOfRangeSinceMs: null, inRangeSinceMs: null }, false, 0);
assert.deepStrictEqual(fresh, { outOfRangeSinceMs: null, inRangeSinceMs: null }, 'expected a never-out-of-range position to stay fully reset');

console.log('OK: out-of-range debounce survives brief flickers, resets only after a full grace period');
