import assert from 'node:assert/strict';
import { isDollarFlowBreachConfirmed as ok } from '../logic/dollarFlowExit.js';

const MIN = 60_000;
// 2 reads 4.4 min apart (the QI case) must NOT confirm with a 10 min span
assert.equal(ok(2, 0, 4.4 * MIN, 2, 10), false);
// third read 10 min after the first confirms
assert.equal(ok(3, 0, 10 * MIN, 2, 10), true);
// span met but too few reads
assert.equal(ok(1, 0, 20 * MIN, 2, 10), false);
// confirmMin 0 = old behaviour (count only)
assert.equal(ok(2, 0, 0, 2, 0), true);
console.log('checkDollarFlowExit OK');
