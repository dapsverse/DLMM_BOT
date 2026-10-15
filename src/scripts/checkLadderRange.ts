import assert from 'node:assert/strict';
import { ladderBounds, ladderRangeStatus } from '../logic/ladderRange.js';

assert.deepEqual(ladderBounds(-208, 69, false), { lo: -276, hi: -208 }); // matches the simulated SI-SOL ladder
assert.deepEqual(ladderBounds(-284, 69, true), { lo: -284, hi: -216 }); // matches the simulated SOL=X ladder
// SOL = Y: price up = bin id up
assert.deepEqual(ladderRangeStatus(-208, -208, 69, false), { isOutOfRange: false, tokenBelowRange: false }); // just opened
assert.deepEqual(ladderRangeStatus(-209, -208, 69, false), { isOutOfRange: false, tokenBelowRange: false });
assert.deepEqual(ladderRangeStatus(-276, -208, 69, false), { isOutOfRange: false, tokenBelowRange: false }); // edge still in
assert.deepEqual(ladderRangeStatus(-277, -208, 69, false), { isOutOfRange: true, tokenBelowRange: true }); // fell through
assert.deepEqual(ladderRangeStatus(-207, -208, 69, false), { isOutOfRange: true, tokenBelowRange: false }); // price above: all SOL, idle
// SOL = X: mirrored
assert.deepEqual(ladderRangeStatus(-216, -284, 69, true), { isOutOfRange: false, tokenBelowRange: false });
assert.deepEqual(ladderRangeStatus(-215, -284, 69, true), { isOutOfRange: true, tokenBelowRange: true });
assert.deepEqual(ladderRangeStatus(-285, -284, 69, true), { isOutOfRange: true, tokenBelowRange: false });
assert.deepEqual(ladderRangeStatus(-100, null, 69, false), { isOutOfRange: true, tokenBelowRange: false });
console.log('checkLadderRange ok');
