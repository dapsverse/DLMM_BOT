import assert from 'node:assert/strict';
import { buildReactScreenerPrompt, buildScreenerPrompt } from '../logic/aiPrompts.js';
import { webSearchQueries, agentEnv, compactCandidates, parseNarrative, validateManagerSubmit, validateSubmit } from '../services/aiReact.js';

const allowed = new Set(['POOL_A']);
const V = (a: Parameters<typeof validateSubmit>[0]) => validateSubmit(a, allowed, 35, 69, 7);

let d = V({ action: 'deploy', pool: 'POOL_A', bins_below: 80, conviction: 8, reason: 'x' });
assert.equal(d.action === 'deploy' && d.bins, 69); // clamped
assert.match(V({ action: 'deploy', pool: 'POOL_X', bins_below: 60, conviction: 9, reason: 'x' }).reason, /not an eligible/); // injected pool
assert.match(V({ action: 'deploy', pool: 'POOL_A', bins_below: 60, conviction: 6, reason: 'meh' }).reason, /below 7/);
assert.equal(V({ action: 'deploy', pool: 'POOL_A', conviction: 9, reason: 'no bins' }).action, 'skip');
d = V({ action: 'skip', conviction: 3, reason: 'knife' });
assert.equal(d.action === 'skip' && d.conviction, 3);
assert.equal(V({ action: 'deploy', bins_below: 60, conviction: 9, reason: 'no pool' }).action, 'skip');

const e = agentEnv({ PATH: '/bin', HOME: '/h', PRIVATE_KEY: 'k', RPC_URL: 'u', TELEGRAM_BOT_TOKEN: 't', HELIUS_API_KEY: 'a', MY_SECRET: 's' });
assert.deepEqual(Object.keys(e).sort(), ['HOME', 'PATH']); // secrets never reach the agent subprocess
assert.equal(validateManagerSubmit({ action: 'close', reason: 'dead' }).action, 'close');
assert.equal(validateManagerSubmit({ action: 'hold', reason: 'ok' }).action, 'hold');
assert.equal(validateManagerSubmit({ action: 'sell_all' as never, reason: 'x' }).action, 'hold'); // anything unknown = hold
const cc = compactCandidates([{ pool: 'A', tvlUsd: 123456.789, feeTvl24hPct: null, priorOutcomes: ['x'] }, { pool: 'B', tvlUsd: 0.000123456, feeTvl24hPct: 7.5, priorOutcomes: [] }] as never);
assert.deepEqual(cc.fields, ['pool', 'tvlUsd', 'feeTvl24hPct', 'priorOutcomes']);
assert.deepEqual(cc.rows[0], ['A', 123500, null, ['x']]); // 4 significant digits, null kept
assert.equal(cc.rows[1]![1], 0.0001235);
assert.deepEqual(compactCandidates([]), { fields: [], rows: [] });
assert.equal(parseNarrative({ narrative: 'Narrative is being generated', status: 'generating' }), null);
assert.equal(parseNarrative({ narrative: '  A  dog\n meme  ', status: 'ready' }), 'A dog meme');
assert.equal(parseNarrative({ narrative: 'x'.repeat(900) })?.length, 500);
assert.equal(parseNarrative({}), null);
assert.equal(parseNarrative(null), null);
// narrative / smart-wallet rule: a real consideration that moves conviction (not a skip rule, not a footnote); an empty narrative feed is filled by one web search first
for (const p of [buildReactScreenerPrompt(0.3, '', [], null), buildScreenerPrompt([], 0.3, [], '', null)]) {
  assert.match(p, /real consideration/);
  assert.doesNotMatch(p, /weak negative/);
  const rule = p.split('\n').find((l) => l.startsWith('- narrative and smart wallets'))!;
  assert.ok(rule && !/weak/i.test(rule)); // a full factor, neither a veto nor a footnote (meridian's own text elsewhere still says "weak narrative")
  assert.doesNotMatch(p, /no narrative \+ no smart wallets → skip/);
  assert.match(p, /WebSearch/);
  assert.match(p, /conviction/);
  assert.match(p, /untrusted/i);
}

// the built-in WebSearch tool is not an MCP tool of ours, so its queries are read off the assistant messages for the decision log
assert.deepEqual(webSearchQueries({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'WebSearch', input: { query: 'SUPERCORE solana token' } }] } }), ['SUPERCORE solana token']);
assert.deepEqual(webSearchQueries({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__dlmm__get_candidates', input: {} }] } }), []);
assert.deepEqual(webSearchQueries({ type: 'result' }), []);
assert.deepEqual(webSearchQueries({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } }), []); // no query: nothing to log

console.log('checkAiReact ok');
