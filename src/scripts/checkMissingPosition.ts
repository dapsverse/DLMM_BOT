import assert from 'node:assert/strict';
import { trackMissingPosition } from '../logic/missingPosition.js';

// Live 2026-10-27 / 10-28: an empty position read (RPC outage) was priced as value 0 -> "-100% unrealized loss" -> stop loss + 4h blacklist.
// A found position proceeds and resets the counter.
assert.deepEqual(trackMissingPosition(true, 0, 8), { misses: 0, action: 'proceed' });
assert.deepEqual(trackMissingPosition(true, 5, 8), { misses: 0, action: 'proceed' });
// a missed read waits: no health check, so no stop loss, until the miss streak is confirmed
assert.deepEqual(trackMissingPosition(false, 0, 8), { misses: 1, action: 'wait' });
assert.deepEqual(trackMissingPosition(false, 6, 8), { misses: 7, action: 'wait' });
// confirmed gone after N consecutive misses: reconcile (no stop loss) and start over
assert.deepEqual(trackMissingPosition(false, 7, 8), { misses: 0, action: 'reconcile' });
// a single good read in between resets the streak
assert.equal(trackMissingPosition(false, trackMissingPosition(true, 6, 8).misses, 8).misses, 1);
// 0 / negative / NaN = off: old behaviour (always proceed)
assert.deepEqual(trackMissingPosition(false, 0, 0), { misses: 0, action: 'proceed' });
assert.deepEqual(trackMissingPosition(false, 3, -1), { misses: 0, action: 'proceed' });
assert.deepEqual(trackMissingPosition(false, 3, Number.NaN), { misses: 0, action: 'proceed' });
// 1 = reconcile at the first miss
assert.deepEqual(trackMissingPosition(false, 0, 1), { misses: 0, action: 'reconcile' });

console.log('OK: missing position guard');
