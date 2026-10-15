import assert from 'node:assert/strict';
import { agentEnv, validateManagerSubmit, validateSubmit } from '../services/aiReact.js';

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
console.log('checkAiReact ok');
