import assert from 'node:assert/strict';
import { cooldownHoursAfterClose, closeKindFromReason, recordClose, cooldownBlacklistAdds, closeRecordUpdate, type CloseRec } from '../logic/meridianCooldown.js';

const c = { oorCount: 3, oorHours: 12, repeatCount: 3, repeatHours: 12 };
const r = (kind: CloseRec['kind'], feesSol = 0): CloseRec => ({ kind, feesSol });
assert.equal(closeKindFromReason('MERIDIAN: low yield: fee/TVL 1%'), 'low yield');
assert.equal(closeKindFromReason('MERIDIAN: out of range 31m'), 'oor');
assert.equal(closeKindFromReason('MERIDIAN: trailing TP: x'), 'other');
assert.equal(cooldownHoursAfterClose([r('other')], c), 0);
assert.equal(cooldownHoursAfterClose([r('low yield')], c), 4);
assert.equal(cooldownHoursAfterClose([r('oor'), r('oor')], c), 0);
assert.equal(cooldownHoursAfterClose([r('oor'), r('oor'), r('oor')], c), 12);
assert.equal(cooldownHoursAfterClose([r('other', 0.01), r('other', 0.02), r('other', 0)], c), 0);
assert.equal(cooldownHoursAfterClose([r('other', 0.01), r('other', 0.02), r('other', 0.03)], c), 12);

// stop-loss cooldown (SL_POOL_COOLDOWN_HOURS): this pool only, other kinds unaffected, 0 disables
assert.equal(closeKindFromReason('MERIDIAN: stop loss: unrealized loss 25.01% >= STOP_LOSS_PCT 25%'), 'stop loss');
assert.equal(closeKindFromReason('MANUAL: close now'), 'other');
const NOW = 1_000_000_000_000;
const H = 3_600_000;
const sl = recordClose(undefined, r('stop loss'), 4);
assert.equal(sl.poolOnlyHours, 4);
assert.equal(sl.bothHours, 0);
assert.deepEqual(cooldownBlacklistAdds(sl, 'POOL', 'MINT', NOW), [['POOL', NOW + 4 * H]]); // the base mint is NOT cooled by a stop loss
assert.equal(recordClose(undefined, r('stop loss'), 0).poolOnlyHours, 0); // env = 0 disables
assert.deepEqual(cooldownBlacklistAdds(recordClose(undefined, r('stop loss'), 0), 'POOL', 'MINT', NOW), []);
assert.equal(recordClose(undefined, r('other'), 4).poolOnlyHours, 0); // TP / AI exit: no stop-loss cooldown
assert.equal(recordClose(undefined, r('stop loss'), -1).poolOnlyHours, 0); // a negative value is off too
// a stop loss that also completes the 3-fee-earning pattern: the pool gets the longer cooldown, the mint the meridian one
const three = recordClose([r('other', 0.01), r('other', 0.02)], r('stop loss', 0.03), 4);
assert.deepEqual(cooldownBlacklistAdds(three, 'POOL', 'MINT', NOW), [['POOL', NOW + 12 * H], ['MINT', NOW + 12 * H]]);
assert.equal(recordClose(new Array(15).fill(r('other')), r('other'), 4).hist.length, 10);
// bookkeeping on the persisted arrays (manualOps): a manual close is recorded, other pools stay untouched, an existing longer entry is never shortened
const u1 = closeRecordUpdate(undefined, [['OTHER', NOW + H]], 'POOL', 'MINT', { kind: 'oor', feesSol: 0.01 }, NOW, 4);
assert.deepEqual(u1.closeHistory, [['POOL', [{ kind: 'oor', feesSol: 0.01 }]]]);
assert.deepEqual(u1.blacklist, [['OTHER', NOW + H]]); // one manual OOR close is no cooldown yet; the other entry is kept as it was
const u2 = closeRecordUpdate([['POOL', [r('oor'), r('oor')]], ['OTHER2', [r('other')]]], [['MINT', NOW + 48 * H]], 'POOL', 'MINT', { kind: 'oor', feesSol: 0 }, NOW, 4);
assert.deepEqual(u2.closeHistory.find(([p]) => p === 'POOL')![1].length, 3); // the third OOR close completes the 12 h pattern ...
assert.deepEqual(new Map(u2.blacklist).get('POOL'), NOW + 12 * H);
assert.equal(new Map(u2.blacklist).get('MINT'), NOW + 48 * H); // ... but a longer existing mint entry stays
assert.deepEqual(u2.closeHistory.find(([p]) => p === 'OTHER2')![1], [r('other')]); // other pools unaffected
console.log('checkMeridianCooldown ok');
