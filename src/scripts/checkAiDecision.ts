import assert from 'node:assert/strict';
import { extractJson, parseManagerDecision, parseScreenerDecision } from '../logic/aiDecision.js';

const allowed = new Set(['POOL_A', 'POOL_B']);
const P = (t: string) => parseScreenerDecision(t, allowed, 35, 69, 7);

assert.deepEqual(extractJson('blah {"a":1} tail'), { a: 1 });
assert.deepEqual(extractJson('```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } }); // brace inside a string
assert.equal(extractJson('no json here'), null);
assert.deepEqual(extractJson('{bad} {"ok":true}'), { ok: true });

let d = P('{"action":"deploy","pool":"POOL_A","bins_below":60,"conviction":8,"reason":"calm, high fee yield"}');
assert.equal(d.action, 'deploy');
if (d.action === 'deploy') assert.deepEqual([d.pool, d.bins, d.conviction], ['POOL_A', 60, 8]);
d = P('{"action":"deploy","pool":"POOL_A","bins_below":200,"conviction":9,"reason":"x"}');
assert.equal(d.action === 'deploy' && d.bins, 69); // clamped
d = P('{"action":"deploy","pool":"POOL_A","bins_below":5,"conviction":9,"reason":"x"}');
assert.equal(d.action === 'deploy' && d.bins, 35);
assert.match(P('{"action":"deploy","pool":"POOL_X","bins_below":60,"conviction":9,"reason":"x"}').reason, /not an eligible/); // injected pool
assert.match(P('{"action":"deploy","pool":"POOL_A","bins_below":60,"conviction":6,"reason":"meh"}').reason, /below 7/);
assert.equal(P('{"action":"deploy","pool":"POOL_A","bins_below":60,"reason":"no conviction field"}').action, 'skip');
assert.equal(P('{"action":"deploy","pool":"POOL_A","reason":"no bins"}').action, 'skip');
assert.equal(P('I think pool A is great').action, 'skip');
assert.equal(P('{"action":"skip","reason":"all weak"}').action, 'skip');
assert.equal(P('{"action":"buy_more","pool":"POOL_A"}').action, 'skip');

assert.equal(parseManagerDecision('{"action":"close","reason":"thesis broken"}').action, 'close');
assert.equal(parseManagerDecision('{"action":"hold","reason":"ok"}').action, 'hold');
assert.equal(parseManagerDecision('garbage').action, 'hold');
assert.equal(parseManagerDecision('{"action":"sell_everything"}').action, 'hold');
console.log('checkAiDecision ok');
