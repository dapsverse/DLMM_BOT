import assert from 'node:assert/strict';
import { cooldownHoursAfterClose, closeKindFromReason, type CloseRec } from '../logic/meridianCooldown.js';

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
console.log('checkMeridianCooldown ok');
