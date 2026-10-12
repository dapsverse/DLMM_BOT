import assert from 'node:assert/strict';
import BN from 'bn.js';
import { settlePendingSwapBack } from '../logic/pendingSwapBack.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';

const swaps: [string, string][] = [];
const deps = (held: number, fail = false) => ({
  getBalance: async () => new BN(held),
  swap: async (m: string, a: BN) => {
    if (fail) throw new Error('block height exceeded');
    swaps.push([m, a.toString()]);
  },
});

// nothing pending -> no-op
assert.equal(await settlePendingSwapBack(null, deps(100)), null);
// sells exactly the failed principal, not the kept fee portion held on top
assert.equal(await settlePendingSwapBack({ mint: 'T', amount: '800' }, deps(1000)), null);
assert.deepEqual(swaps.pop(), ['T', '800']);
// balance below pending (partially sold elsewhere) -> sells what is there
await settlePendingSwapBack({ mint: 'T', amount: '800' }, deps(300));
assert.deepEqual(swaps.pop(), ['T', '300']);
// nothing held -> pending cleared without a swap
assert.equal(await settlePendingSwapBack({ mint: 'T', amount: '800' }, deps(0)), null);
assert.equal(swaps.length, 0);
// swap failure throws so the caller keeps the pending
await assert.rejects(settlePendingSwapBack({ mint: 'T', amount: '800' }, deps(1000, true)), /block height/);

// state persistence: optional field round-trips, bad shape rejected, old files (no field) still load
const base = {
  version: STATE_VERSION, savedAtMs: 1, wallet: 'W', position: null, inFlight: false, currentCapitalSol: 1,
  lastOtherMint: null, lastSwitchAtMs: null, blacklist: [], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 },
};
assert.ok(parseState(JSON.stringify(base), 'W'));
assert.deepEqual(parseState(JSON.stringify({ ...base, pendingSwapBack: { mint: 'T', amount: '5' } }), 'W')?.pendingSwapBack, { mint: 'T', amount: '5' });
assert.ok(parseState(JSON.stringify({ ...base, pendingSwapBack: null }), 'W'));
assert.equal(parseState(JSON.stringify({ ...base, pendingSwapBack: { mint: 'T', amount: 5 } }), 'W'), null);
console.log('checkPendingSwapBack OK');
