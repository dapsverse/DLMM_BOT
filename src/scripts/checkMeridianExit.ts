import assert from 'node:assert/strict';
import { meridianExitSignal, ExitConfirmer, type MeridianExitInput, type MeridianExitConfig } from '../logic/meridianExit.js';

const c: MeridianExitConfig = { takeProfitPct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeBinsToClose: 10, outOfRangeWaitMinutes: 30, minFeePerTvl24hPct: 7, minAgeBeforeYieldCheckMin: 60 };
const base: MeridianExitInput = { pnlPct: 0, peakPnlPct: 0, binsAbove: 0, isOutOfRange: false, minutesOutOfRange: null, feePerTvl24hPct: 20, ageMinutes: 120 };
const sig = (o: Partial<MeridianExitInput>) => meridianExitSignal({ ...base, ...o }, c);

assert.equal(sig({}), null);
assert.match(sig({ pnlPct: 5 })!, /^take profit/);
assert.equal(sig({ pnlPct: 2, peakPnlPct: 2.9 }), null);
assert.match(sig({ pnlPct: 1.4, peakPnlPct: 3 })!, /^trailing TP/);
assert.equal(sig({ pnlPct: 2, peakPnlPct: 3 }), null);
assert.match(sig({ binsAbove: 11 })!, /^pumped far/);
assert.equal(sig({ binsAbove: 10 }), null);
assert.equal(sig({ isOutOfRange: true, minutesOutOfRange: 29 }), null);
assert.match(sig({ isOutOfRange: true, minutesOutOfRange: 30 })!, /^out of range/);
assert.match(sig({ feePerTvl24hPct: 6.9 })!, /^low yield/);
assert.equal(sig({ feePerTvl24hPct: 6.9, ageMinutes: 59 }), null);
assert.equal(sig({ feePerTvl24hPct: null }), null);

const k = new ExitConfirmer();
assert.equal(k.hit('take profit: a', 2), false);
assert.equal(k.hit('take profit: b', 2), true);
assert.equal(k.hit('take profit: a', 2), false);
assert.equal(k.hit(null, 2), false);
assert.equal(k.hit('take profit: a', 2), false);
assert.equal(k.hit('low yield: x', 2), false);
import { oorWaitMinutes } from '../logic/meridianExit.js';
const w = { standard: 30, spotFirst: 15, spotAfterReach: 30 };
assert.equal(oorWaitMinutes(false, false, w), 30);
assert.equal(oorWaitMinutes(true, false, w), 15);
assert.equal(oorWaitMinutes(true, true, w), 30);
console.log('checkMeridianExit ok');
