import assert from 'node:assert/strict';
import BN from 'bn.js';
import { capSolDeposit, externalCapitalSol } from '../logic/rebalanceEngine.js';

// SOL cap: only the SOL side is capped, token side untouched
const big = new BN(800_000_000), tok = new BN(500_000_000), cap = new BN(500_000_000);
let r = capSolDeposit(big, tok, true, cap); // SOL is X
assert.equal(r.depositX.toString(), '500000000');
assert.equal(r.depositY.toString(), '500000000');
r = capSolDeposit(tok, big, false, cap); // SOL is Y
assert.equal(r.depositY.toString(), '500000000');
assert.equal(r.depositX.toString(), '500000000');
r = capSolDeposit(new BN(300_000_000), tok, true, cap); // below cap: unchanged
assert.equal(r.depositX.toString(), '300000000');
r = capSolDeposit(big, tok, true, new BN(-5)); // negative cap clamps to 0, never negative
assert.equal(r.depositX.toString(), '0');

// external capital, REAL numbers from the live logs (2026-10-11):
// 03:10 rebalance: pre 1.1771 + fees 0.0336 = 1.2107; post spendable 0.0860, token 1.1946 -> no external capital
assert.equal(externalCapitalSol(0.086045785, 1.1945957998523067, 1.1771005736 + 0.033596004), 0);
// 01:27 rebalance: pre 1.2570 + 0.0040; post spendable 1.3196, token 0.00055 -> noise only (price/friction), no external capital
assert.equal(externalCapitalSol(1.319598424, 0.0005515, 1.256975344 + 0.00404), 0);
// a 1 SOL top-up sitting idle in the wallet is detected (and measured net of the position rent)
const ext = externalCapitalSol(1.319598424 + 1.0, 0.0005515, 1.256975344 + 0.00404);
assert.ok(Math.abs(ext - 1.0) < 0.02, String(ext));
// small drift inside the noise band is ignored
assert.equal(externalCapitalSol(0.5, 0.7, 1.15), 0);
console.log('OK: SOL deposit is capped to the entry capital; compound basis only grows for genuinely external capital (checked on real 01:27/03:10 rebalance numbers)');
