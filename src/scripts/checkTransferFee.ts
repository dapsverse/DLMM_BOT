import assert from 'node:assert/strict';
import { transferFeeBps } from '../logic/transferFee.js';

assert.equal(transferFeeBps({ decimals: 6 }), 0); // legacy SPL mint: no extensions
assert.equal(transferFeeBps({ extensions: [{ extension: 'metadataPointer' }] }), 0);
const fee = (older: number, newer: number) => ({
  extensions: [{ extension: 'metadataPointer' }, { extension: 'transferFeeConfig', state: { olderTransferFee: { transferFeeBasisPoints: older }, newerTransferFee: { transferFeeBasisPoints: newer } } }],
});
assert.equal(transferFeeBps(fee(300, 300)), 300); // MASK
assert.equal(transferFeeBps(fee(0, 500)), 500); // pending bump counts
assert.equal(transferFeeBps(fee(0, 0)), 0); // extension present but zero
assert.equal(transferFeeBps(null), null);
assert.equal(transferFeeBps({ extensions: 'x' }), null);
assert.equal(transferFeeBps({ extensions: [{ extension: 'transferFeeConfig', state: {} }] }), null);
console.log('checkTransferFee ok');
