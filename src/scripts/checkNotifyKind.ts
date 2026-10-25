import assert from 'node:assert/strict';
import { notifyKinds } from '../logic/notifyKind.js';
import { formatEvent } from '../logic/telegramEventFormat.js';

// the real formatter output is classified, so a label change in telegramEventFormat.ts breaks this check
const trig = formatEvent('2026-10-23T10:07:36.494Z [info] [ai] manager triggered {"pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g","trigger":"out of range 7min"}')!;
const dec = formatEvent('[info] [ai] manager decision {"action":"hold","reason":"secret-ish reasoning text"}')!;
assert.equal(notifyKinds(trig), 'ai-manager');
assert.equal(notifyKinds(dec), 'ai-manager');
assert.equal(notifyKinds('🤖 AI Screener: SKIP'), 'ai-screener');
// a batched message with several kinds lists each once
assert.equal(notifyKinds(`${trig}\n${dec}\n🤖 AI Screener: SKIP`), 'ai-manager+ai-screener');
// anything else, and replies, are plain events
assert.equal(notifyKinds('✅ Masuk pool P123 | modal 1.000 SOL'), 'event');
assert.equal(notifyKinds(''), 'event');
// only the kind is exposed: no decision text leaks into it
assert.ok(!notifyKinds(dec).includes('secret'));

console.log('OK: notify kind classification');
