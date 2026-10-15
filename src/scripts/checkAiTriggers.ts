import assert from 'node:assert/strict';
import { managerTrigger, type ManagerTriggerInput } from '../logic/aiTriggers.js';

const L = { periodicMin: 30, cooldownMin: 10, oorMin: 5, lossPct: 8, volumeBelowPct: 50 };
const calm: ManagerTriggerInput = { isOutOfRange: false, minutesOutOfRange: null, profitPct: 0.2, volumeVsBaselinePct: 90, tokenSharePct: 0, minutesSinceLastCall: 12 };

assert.equal(managerTrigger(calm, L), null); // healthy and inside: no LLM call
assert.equal(managerTrigger({ ...calm, minutesSinceLastCall: 31 }, L), 'periodic health check');
assert.equal(managerTrigger({ ...calm, minutesSinceLastCall: 31, isOutOfRange: true, minutesOutOfRange: 20 }, L), 'periodic health check'); // periodic wins
assert.match(managerTrigger({ ...calm, isOutOfRange: true, minutesOutOfRange: 6 }, L)!, /out of range 6min/);
assert.equal(managerTrigger({ ...calm, isOutOfRange: true, minutesOutOfRange: 3 }, L), null); // briefly out: wait
assert.match(managerTrigger({ ...calm, profitPct: -9 }, L)!, /loss/);
assert.equal(managerTrigger({ ...calm, profitPct: -7 }, L), null);
assert.match(managerTrigger({ ...calm, volumeVsBaselinePct: 40 }, L)!, /volume/);
assert.match(managerTrigger({ ...calm, tokenSharePct: 60, profitPct: -1 }, L)!, /holding token/);
assert.equal(managerTrigger({ ...calm, tokenSharePct: 60, profitPct: 1 }, L), null); // token in profit: hold
assert.equal(managerTrigger({ ...calm, minutesSinceLastCall: 4, profitPct: -20, isOutOfRange: true, minutesOutOfRange: 30 }, L), null); // cooldown
console.log('checkAiTriggers ok');
