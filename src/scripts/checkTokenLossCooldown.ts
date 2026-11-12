import assert from 'node:assert/strict';
import { tokenLossCooldownUntil } from '../logic/tokenLossCooldown.js';
import { defaultScannerConfig, poolRejectReasons, type MeteoraPair } from '../services/meteoraScanner.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';
import { env } from '../config/env.js';

const H = 3_600_000;
const now = 1_000_000_000;

// ---- the rule: any exit, loss >= 5% -> 24 h on the token
assert.equal(tokenLossCooldownUntil(-9.65, -8.25, 5, 24, now), now + 24 * H); // STANK-SOL 11 Nov 22:56 (AI exit)
assert.equal(tokenLossCooldownUntil(-5, -1, 5, 24, now), now + 24 * H); // exactly the threshold
assert.equal(tokenLossCooldownUntil(-4.99, -9, 5, 24, now), null); // realized wins over the snapshot when known
assert.equal(tokenLossCooldownUntil(null, -9.66, 5, 24, now), now + 24 * H); // realized unknown (pending swap-back, 11 Nov 02:30): snapshot decides
assert.equal(tokenLossCooldownUntil(undefined, -2, 5, 24, now), null);
assert.equal(tokenLossCooldownUntil(2.5, 2.7, 5, 24, now), null); // a win
assert.equal(tokenLossCooldownUntil(null, null, 5, 24, now), null); // nothing measured: no cooldown
assert.equal(tokenLossCooldownUntil(Number.NaN, -6, 5, 24, now), now + 24 * H);
assert.equal(tokenLossCooldownUntil(-20, -20, 5, 0, now), null); // 0 hours = off
assert.equal(tokenLossCooldownUntil(-6, -6, 5, 24, now, now + 48 * H), now + 48 * H); // never shortens a longer entry
assert.equal(tokenLossCooldownUntil(-6, -6, 5, 24, now, now + 1 * H), now + 24 * H);
assert.equal(tokenLossCooldownUntil(-6, -6, 5, 12, now), now + 12 * H); // configurable duration
assert.equal(tokenLossCooldownUntil(-6, -6, 10, 24, now), null); // configurable threshold

// ---- the scanner rejects ANY pool of a token on the blacklist (mint key), not just the pool that lost
const STANK = '5wsjHxT5nW5jQuVupXUNnYszF3WoWCfGGk9LMcsCJzY8';
const WSOL = 'So11111111111111111111111111111111111111112';
const pair = (address: string, mintX: string): MeteoraPair =>
  ({ address, name: 'T-SOL', mint_x: mintX, mint_y: WSOL, tokenX: { address: mintX, priceUsd: 0.001, marketCapUsd: 1e6, holders: 5000, freezeAuthorityDisabled: true }, tokenY: { address: WSOL, priceUsd: 150, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true } }) as unknown as MeteoraPair;
const blacklist = new Map<string, number>([[STANK, Date.now() + 24 * H]]);
const cfg = defaultScannerConfig(blacklist);
assert.ok(poolRejectReasons(pair('91iHWaWXneUyoNDJhSno7ezxQg1VW5P6PdarNGyFfPCz', STANK), cfg).includes('blacklisted')); // the pool that lost
assert.ok(poolRejectReasons(pair('6hYFMyE2otherPoolOfTheSameToken111111111111', STANK), cfg).includes('blacklisted')); // another pool of the same token
assert.ok(!poolRejectReasons(pair('SomeOtherPool1111111111111111111111111111111', 'OtherMint11111111111111111111111111111111111'), cfg).includes('blacklisted'));
const expired = defaultScannerConfig(new Map([[STANK, Date.now() - 1]]));
assert.ok(!poolRejectReasons(pair('91iHWaWXneUyoNDJhSno7ezxQg1VW5P6PdarNGyFfPCz', STANK), expired).includes('blacklisted')); // cooldown over

// ---- the cooldown survives a restart: it lives in the persisted blacklist
const st = parseState(JSON.stringify({ version: STATE_VERSION, wallet: 'W', savedAtMs: 1, currentCapitalSol: 1, inFlight: false, blacklist: [[STANK, now + 24 * H]], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 }, position: null, lastOtherMint: null, lastSwitchAtMs: 0 }), 'W');
assert.deepEqual(st?.blacklist, [[STANK, now + 24 * H]]);

// ---- defaults
if (process.env.TOKEN_LOSS_COOLDOWN_HOURS === undefined) assert.equal(env.TOKEN_LOSS_COOLDOWN_HOURS, 24);
if (process.env.TOKEN_LOSS_COOLDOWN_MIN_LOSS_PCT === undefined) assert.equal(env.TOKEN_LOSS_COOLDOWN_MIN_LOSS_PCT, 5);
console.log('OK: per-token loss cooldown (rule, every pool of the token blocked, persisted, defaults 24 h / 5%)');
