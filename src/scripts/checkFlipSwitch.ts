import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// ENABLE_BID_ASK_FLIP (default false) is the master switch of the bid-ask flip; FLIP_ENABLED is the older flag and both must be true.
// Each case runs env.ts in a fresh process (env is read once at import), with a dummy key and no .env file so nothing real is loaded.
function probe(master: string | undefined, legacy: string | undefined): { master: boolean; flip: boolean; promptNull: boolean } {
  const e: NodeJS.ProcessEnv = { ...process.env, PRIVATE_KEY: 'SHADOW_RUNNER_NO_KEY', DOTENV_CONFIG_PATH: '/nonexistent', RPC_URL: 'https://api.mainnet-beta.solana.com' };
  delete e.ENABLE_BID_ASK_FLIP;
  delete e.FLIP_ENABLED;
  if (master !== undefined) e.ENABLE_BID_ASK_FLIP = master;
  if (legacy !== undefined) e.FLIP_ENABLED = legacy;
  const code = `const { env } = await import('./src/config/env.ts'); const { flipPromptInfo } = await import('./src/logic/flip.ts'); console.log(JSON.stringify({ master: env.ENABLE_BID_ASK_FLIP, flip: env.FLIP_ENABLED, promptNull: flipPromptInfo(env) === null }));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: e, encoding: 'utf8', cwd: process.cwd() });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

// default (nothing set): flip is off, even though the old flag could be on
assert.deepEqual(probe(undefined, undefined), { master: false, flip: false, promptNull: true });
// the old flag alone no longer turns the flip on (this is what stops the live bot from flipping)
assert.deepEqual(probe(undefined, 'true'), { master: false, flip: false, promptNull: true });
assert.deepEqual(probe('false', 'true'), { master: false, flip: false, promptNull: true });
// the master switch alone is not enough either
assert.deepEqual(probe('true', undefined), { master: true, flip: false, promptNull: true });
assert.deepEqual(probe('true', 'false'), { master: true, flip: false, promptNull: true });
// both on: flip active and the flip text is back in the AI prompts
assert.deepEqual(probe('true', 'true'), { master: true, flip: true, promptNull: false });
console.log('OK: bid-ask flip master switch (ENABLE_BID_ASK_FLIP x FLIP_ENABLED)');
