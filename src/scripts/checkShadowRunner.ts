import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHADOW_RUNNER_DUMMY_KEY, isRunnerKeySafe, pickRunnerTargets, type RunnerCandidate } from '../logic/shadowRunner.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const c = (o: Partial<RunnerCandidate> & { address: string }): RunnerCandidate => ({ name: o.address + '-SOL', mint_x: 'TOK', mint_y: WSOL, bin_step: 100, tokenX: { priceUsd: 0.001 }, tokenY: { priceUsd: 150 }, ...o });

// key guard: only the exact placeholder passes, a real-looking key or nothing never does
assert.equal(isRunnerKeySafe(SHADOW_RUNNER_DUMMY_KEY), true);
assert.equal(isRunnerKeySafe(undefined), false);
assert.equal(isRunnerKeySafe(''), false);
assert.equal(isRunnerKeySafe('5'.repeat(88)), false);
assert.equal(isRunnerKeySafe(SHADOW_RUNNER_DUMMY_KEY + ' '), false);

// targets: ranked order kept, only SOL-quoted pools, top N, mint = the non-SOL side, SOL price from the SOL side
const t = pickRunnerTargets([c({ address: 'A', buyRatio1h: 0.6 }), c({ address: 'NOSOL', mint_y: 'USDC' }), c({ address: 'B', mint_x: WSOL, mint_y: 'MEME', tokenX: { priceUsd: 140 }, tokenY: { priceUsd: 0.5 } }), c({ address: 'C' })], 3);
assert.deepEqual(t.map((x) => x.pool), ['A', 'B', 'C']);
assert.equal(t[0]!.mint, 'TOK');
assert.equal(t[0]!.solPriceUsd, 150);
assert.equal(t[0]!.buyRatio1h, 0.6);
assert.equal(t[1]!.mint, 'MEME'); // SOL is X here
assert.equal(t[1]!.solPriceUsd, 140);
assert.equal(t[1]!.buyRatio1h, null);
assert.equal(t[0]!.aiStrategy, 'shadow_runner');
assert.equal(t[0]!.aiConviction, null);
assert.equal(pickRunnerTargets([c({ address: 'A' }), c({ address: 'B' })], 1).length, 1);
assert.equal(pickRunnerTargets([], 3).length, 0);
assert.equal(pickRunnerTargets([c({ address: 'A', tokenY: {} })], 3)[0]!.solPriceUsd, null);

// the runner must not be able to sign or send: its source never imports the wallet/solana/transaction modules
const src = readFileSync(new URL('./shadowRunner.ts', import.meta.url), 'utf8');
for (const forbidden of ['services/solana', 'jupiterSwap', 'meteoraDLMM', 'rebalanceEngine', 'sendTransaction', 'Keypair', 'manualOps']) assert.ok(!src.includes(forbidden), `shadowRunner.ts must not reference ${forbidden}`);
assert.match(src, /isRunnerKeySafe\(process\.env\.PRIVATE_KEY\)/);

console.log('checkShadowRunner ok');
