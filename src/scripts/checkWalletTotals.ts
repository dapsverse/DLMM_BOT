import assert from 'node:assert/strict';
import { walletFreeLine, totalLines } from '../logic/walletTotals.js';

const at = '2026-10-25T12:29:11.123Z';

// fresh read: value, source and timestamp
assert.equal(walletFreeLine(0.132549312, at), 'wallet free SOL: 0.1325 SOL (sumber: getBalance on-chain, 12:29:11 UTC)');
// failed read: never a number
assert.equal(walletFreeLine(null, at), 'wallet free SOL: unavailable');

// Moustache-like flip: explicit sum, banked is a memo (already inside the wallet), not added twice
assert.deepEqual(totalLines({ walletSol: 0.1325, positions: [{ valueSol: 0.2304, feesSol: 0 }], bankedSol: 0.0022 }), [
  'total: 0.1325 (wallet free) + 0.2304 (position value) + 0.0000 (unclaimed fees) = 0.3629 SOL',
  'banked 0.0022 SOL sudah termasuk di wallet free, tidak dijumlah dua kali',
]);
// no banked -> no memo line
assert.equal(totalLines({ walletSol: 1, positions: [{ valueSol: 0.5, feesSol: 0.01 }], bankedSol: 0 }).length, 1);
// no open position: total is the wallet alone
assert.deepEqual(totalLines({ walletSol: 0.5, positions: [], bankedSol: 0 }), ['total: 0.5000 (wallet free) + 0.0000 (position value) + 0.0000 (unclaimed fees) = 0.5000 SOL']);
// several positions are summed
assert.match(totalLines({ walletSol: 0.1, positions: [{ valueSol: 0.2, feesSol: 0.01 }, { valueSol: 0.3, feesSol: 0.02 }], bankedSol: 0 })[0]!, /= 0\.6300 SOL$/);
// unreadable inputs: unavailable, no partial sum
assert.equal(totalLines({ walletSol: null, positions: [{ valueSol: 0.2, feesSol: 0 }], bankedSol: 0.01 })[0], 'total: unavailable (wallet free SOL tidak terbaca)');
assert.equal(totalLines({ walletSol: 0.1, positions: null, bankedSol: 0 })[0], 'total: unavailable (nilai posisi tidak terbaca)');

console.log('OK: wallet free + total lines for /status');
