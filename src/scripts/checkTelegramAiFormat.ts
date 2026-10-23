import assert from 'node:assert/strict';
import { formatAiScreener, wibTime } from '../logic/telegramAiFormat.js';

const skip = '2026-10-23T13:31:15.445Z [info] [ai] screener decision {"action":"skip","reason":"No candidate qualifies.","conviction":6,"react":true,"turns":8,"costUsd":0.07553179999999998,"tools":["get_candidates {}","submit_decision {\\"action\\":\\"skip\\"}"]}';
const dup = '2026-10-23T13:31:15.445Z [info] [index] AI screener: skip {"reason":"No candidate qualifies."}';
const dep = '2026-10-23T09:37:24.089Z [info] [ai] screener decision {"action":"deploy","pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g","bins":69,"conviction":6,"reason":"Good fee/TVL.","strategy":"sol_ladder","react":true,"turns":10,"costUsd":0.0976279,"tools":["a","b","c"]}';

assert.equal(wibTime(skip), '20:31 WIB');
assert.equal(wibTime('no timestamp'), '');
assert.equal(formatAiScreener(skip), '🤖 AI Screener: SKIP (conviction 6/10)\nNo candidate qualifies.\nturns 8 · 2 tool calls · cost $0.076 · 20:31 WIB');
assert.equal(formatAiScreener(dup), null); // duplicate of the line above
assert.equal(formatAiScreener(dep), '🚀 AI Screener: DEPLOY (conviction 6/10)\npool 9Ft5WA…Ax7j4g · sol_ladder · 69 bins\nGood fee/TVL.\nturns 10 · 3 tool calls · cost $0.098 · 16:37 WIB');
assert.equal(formatAiScreener('2026-10-23T13:31:15.445Z [info] [ai] manager decision {"action":"hold"}'), undefined); // other events untouched
assert.equal(formatAiScreener('[info] [ai] screener decision {broken'), undefined); // unparsable: caller falls back to the raw line
assert.equal(formatAiScreener('[info] [ai] screener decision {"action":"skip","reason":"x"}'), '🤖 AI Screener: SKIP\nx');
console.log('checkTelegramAiFormat ok');
