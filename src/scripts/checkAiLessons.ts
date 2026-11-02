import assert from 'node:assert/strict';
import { STANDING_LESSONS, standingLessonsBlock } from '../logic/aiLessons.js';
import { buildManagerPrompt, buildReactManagerPrompt, buildReactScreenerPrompt, type AiPositionSnapshot } from '../logic/aiPrompts.js';

const block = standingLessonsBlock();
assert.ok(STANDING_LESSONS.length >= 1);
// the Anakin-SOL facts the manager must be able to weigh (2026-11-02, stop loss -25.8%)
for (const needle of [/Anakin-SOL/, /1h -6\.5%/, /17% (under|below) (its )?4h high/, /spike 0\.22x/, /boost 500/i, /no (real )?website/i, /smart LP/i, /KOL/, /flip/i, /cannot close|can't close|cannot exit/i, /-26%/, /226 insiders/i, /dev balance 0/i, /not an LP rug/i]) {
  assert.match(block, needle, `lesson text lacks ${needle}`);
}
// it says how to apply it (decide before the flip, but do not close for tiny moves)
assert.match(block, /BEFORE the flip/);
assert.match(block, /tiny|healthy/i);
// plain text only: no secrets / key-like strings / instructions to ignore rules
assert.doesNotMatch(block, /sk-[A-Za-z0-9]{10,}|api[-_ ]?key|private key|seed phrase|ignore (all|the|previous)/i);
assert.ok(block.length < 2500, `lessons block too long: ${block.length}`);

const snapshot = { pool: 'P', tokenMint: 'M', minutesOpen: 10, depositSol: 1, valueSol: 0.9, profitPct: -10, peakProfitPct: 0, unclaimedFeesSol: 0, tokenShareOfValuePct: 80, isOutOfRange: false, minutesOutOfRange: null, priceVsLadder: 'inside', ladderBins: 55, volume1hNowUsd: 1000, volume1hBaselineUsd: 5000, volumeVsBaselinePct: 20, dollarFlowBuyRatio: null, entryReason: null } as unknown as AiPositionSnapshot;
const rules = {} as never;
// both manager prompts carry the standing lessons, the screener prompt does not (this lesson is for hold-vs-close)
assert.match(buildManagerPrompt(snapshot, rules, [], '', null), /STANDING LESSONS/);
assert.match(buildReactManagerPrompt(rules, '', [], null), /STANDING LESSONS/);
assert.match(buildReactManagerPrompt(rules, 'PERFORMANCE MEMORY: x', [], null), /LESSONS LEARNED:\nPERFORMANCE MEMORY: x/); // the outcome memory block is still there
assert.doesNotMatch(buildReactScreenerPrompt(1, '', [], null), /STANDING LESSONS/);
console.log('OK: standing Anakin-SOL lesson in the manager prompts');
