import assert from 'node:assert/strict';
import BN from 'bn.js';
import { orderSpec, binsForMove, spreadBins, filledFraction } from '../logic/limitOrderMath.js';

// Token is X (SOL is Y): buy cheaper = bid below active (deposit Y=SOL); sell higher = ask above (deposit X=token).
assert.deepEqual(orderSpec(false, 'buyToken'), { isAskSide: false, dir: -1, depositIsX: false });
assert.deepEqual(orderSpec(false, 'sellToken'), { isAskSide: true, dir: 1, depositIsX: true });
// SOL is X (token is Y): buy cheaper token = token price down = Y/X up = ask above (deposit X=SOL); sell higher = bid below (deposit Y=token).
assert.deepEqual(orderSpec(true, 'buyToken'), { isAskSide: true, dir: 1, depositIsX: true });
assert.deepEqual(orderSpec(true, 'sellToken'), { isAskSide: false, dir: -1, depositIsX: false });

// bin step 50 = 0.5%/bin: +5% needs 10 bins, -2% needs 5 bins (1/0.98 = 1.0204 -> ln/ln1.005 = 4.05 -> 5)
assert.equal(binsForMove(5, 50, 'up'), 10);
assert.equal(binsForMove(2, 50, 'down'), 5);
assert.equal(binsForMove(0.01, 100, 'up'), 1);

const bins = spreadBins(-100, -1, 5, 2, new BN(1001));
assert.deepEqual(bins.map((b) => b.id), [-106, -105]); // ascending
assert.equal(bins[0]!.amount.add(bins[1]!.amount).toString(), '1001');
assert.equal(bins[1]!.amount.toString(), '501'); // remainder goes to the bin nearest the active bin
assert.deepEqual(spreadBins(10, 1, 3, 2, new BN(10)).map((b) => b.id), [13, 14]);

assert.equal(filledFraction('1000', '1000'), 0);
assert.equal(filledFraction('1000', '0'), 1);
assert.equal(filledFraction('1000', '250'), 0.75);
assert.equal(filledFraction('0', '0'), 0);
assert.equal(filledFraction('0.005', '0.0025'), 0.5); // UI-decimal strings as the SDK returns them
assert.equal(filledFraction('0.005', '0.005'), 0);
assert.equal(filledFraction('abc', '1'), 0);
console.log('checkLimitOrderMath ok');
