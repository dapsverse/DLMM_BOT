import assert from 'node:assert/strict';
import { shouldExitOnUpsideBreak } from '../logic/upsideBreak.js';

const base = { exitAfterMin: 2, isOutOfRange: true, outOfRangeSinceMs: 0, nowMs: 3 * 60_000, tokenValueSol: 0, totalValueSol: 1 };
assert.equal(shouldExitOnUpsideBreak(base), true); // all SOL, out of range 3 min >= 2
assert.equal(shouldExitOnUpsideBreak({ ...base, nowMs: 60_000 }), false); // debounce not elapsed
assert.equal(shouldExitOnUpsideBreak({ ...base, exitAfterMin: 0 }), false); // feature off
assert.equal(shouldExitOnUpsideBreak({ ...base, isOutOfRange: false }), false);
assert.equal(shouldExitOnUpsideBreak({ ...base, outOfRangeSinceMs: null }), false);
assert.equal(shouldExitOnUpsideBreak({ ...base, tokenValueSol: 0.9 }), false); // downside break: mostly token, never matches
assert.equal(shouldExitOnUpsideBreak({ ...base, tokenValueSol: 0.01 }), true); // dust of token still counts as all-SOL
assert.equal(shouldExitOnUpsideBreak({ ...base, totalValueSol: 0 }), false);
console.log('checkUpsideBreak OK');
