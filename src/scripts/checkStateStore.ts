import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyStaleTimers, loadState, parseState, pruneExpired, reconcileBoot, saveState, sanitizeCloseHistory,
  STATE_VERSION, STALE_TIMER_MS, CLOSE_HISTORY_PER_POOL, CLOSE_HISTORY_MAX_POOLS, type PersistedPosition, type PersistedState,
} from '../services/stateStore.js';
import { cooldownHoursAfterClose, type CloseRec } from '../logic/meridianCooldown.js';

const W = 'WalletPubkeyForTest';
const pos: PersistedPosition = {
  poolAddress: 'POOLA', mintX: 'TOK', mintY: 'So11111111111111111111111111111111111111112', xIsSol: false,
  initialDepositSol: 1.2359, rebalanceTimestamps: [1, 2], lastRebalanceAt: 2, volume1hBaselineUsd: 1000, volume1hBaselineSetAtMs: 5,
  binStep: 100, centerBinId: -653, outOfRangeSinceMs: 1_000, inRangeSinceMs: null, peakProfitPct: 3.2, otherMintDecimals: 6, reserveSolAccount: 'RES',
};
const state: PersistedState = {
  version: STATE_VERSION, savedAtMs: 10_000, wallet: W, position: pos, inFlight: false, currentCapitalSol: 1.2,
  lastOtherMint: 'TOK', lastSwitchAtMs: null, blacklist: [['X', 5], ['Y', 99_999]], chaseGuard: [['TOK', 0.00004]], dollarFlowBreach: { pool: 'POOLA', count: 1 },
};

// reconcileBoot: ground truth wins
assert.deepEqual(reconcileBoot(null, []), { kind: 'flat' });
assert.deepEqual(reconcileBoot('POOLA', []), { kind: 'flat' }); // state claimed a position, chain has none -> flat
assert.deepEqual(reconcileBoot('POOLA', ['POOLA']), { kind: 'resume', poolAddress: 'POOLA', fromState: true });
assert.deepEqual(reconcileBoot(null, ['POOLB']), { kind: 'resume', poolAddress: 'POOLB', fromState: false }); // orphan, no state
assert.deepEqual(reconcileBoot('POOLA', ['POOLB']), { kind: 'resume', poolAddress: 'POOLB', fromState: false }); // state mismatch -> rebuild from chain
assert.equal(reconcileBoot('POOLA', ['POOLA', 'POOLB']).kind, 'ambiguous'); // never trade on ambiguity
assert.equal(reconcileBoot(null, ['P', 'P']).kind, 'resume'); // duplicates collapse

// stale timers dropped, fresh kept, original untouched
const fresh = applyStaleTimers({ ...pos, outOfRangeSinceMs: 9_000 }, 10_000, 10_000 + STALE_TIMER_MS);
assert.equal(fresh.outOfRangeSinceMs, 9_000);
const stale = applyStaleTimers(pos, 10_000, 10_000 + STALE_TIMER_MS + 1);
assert.equal(stale.outOfRangeSinceMs, null);
assert.equal(stale.inRangeSinceMs, null);
assert.equal(stale.initialDepositSol, 1.2359); // bookkeeping that matters survives
assert.equal(stale.peakProfitPct, 3.2);
assert.equal(pos.outOfRangeSinceMs, 1_000);

// blacklist expiry
assert.deepEqual(pruneExpired([['X', 5], ['Y', 99_999]], 50_000), [['Y', 99_999]]);

// parse validation
assert.ok(parseState(JSON.stringify(state), W));
assert.equal(parseState('{not json', W), null);
assert.equal(parseState(JSON.stringify(state), 'OtherWallet'), null);
assert.equal(parseState(JSON.stringify({ ...state, version: 99 }), W), null);
assert.equal(parseState(JSON.stringify({ ...state, position: { ...pos, initialDepositSol: 'x' } }), W), null);
assert.equal(parseState(JSON.stringify({ ...state, blacklist: null }), W), null);
assert.ok(parseState(JSON.stringify({ ...state, position: null }), W));

// atomic save/load round trip + corrupt file is quarantined, not trusted
const dir = mkdtempSync(join(tmpdir(), 'statecheck-'));
const f = join(dir, 'sub', 'live-state.json');
assert.equal(loadState(W, f), null); // missing
assert.equal(saveState(state, f), true);
assert.deepEqual(loadState(W, f), state);
assert.equal(existsSync(`${f}.tmp`), false); // tmp renamed away
writeFileSync(f, '{"version":1,"trunc');
assert.equal(loadState(W, f), null);
assert.equal(readFileSync(`${f}.bad`, 'utf8'), '{"version":1,"trunc');
// pendingLimitOrder: valid one round-trips, malformed one rejects the file
const withOrder = { ...state, pendingLimitOrder: { kind: 'exitAsk' as const, pool: 'P', order: 'O', xIsSol: false, mint: 'M', amountRaw: '100', keepRaw: '5', deadlineMs: 123 } };
assert.deepEqual(parseState(JSON.stringify(withOrder), W)?.pendingLimitOrder, withOrder.pendingLimitOrder);
assert.equal(parseState(JSON.stringify({ ...state, pendingLimitOrder: { kind: 'exitAsk', pool: 'P' } }), W), null);
// closeHistory (meridian cooldowns) survives a save/load, an old file without it still loads, junk entries are skipped, and the restored history
// still triggers the cooldown (the 2026-10-23 case: 3 fee-earning closes of one pool, a restart in between must not reset the count)
const hist: [string, CloseRec[]][] = [['POOLX', [{ kind: 'other', feesSol: 0.01 }, { kind: 'other', feesSol: 0.02 }, { kind: 'oor', feesSol: 0.03 }]]];
assert.equal(saveState({ ...state, closeHistory: hist }, f), true);
const back = loadState(W, f)!;
assert.deepEqual(back.closeHistory, hist);
assert.equal(cooldownHoursAfterClose(sanitizeCloseHistory(back.closeHistory)[0]![1], { oorCount: 3, oorHours: 12, repeatCount: 3, repeatHours: 12 }), 12);
assert.equal(parseState(JSON.stringify(state), W)?.closeHistory, undefined); // file written before this field existed
assert.deepEqual(sanitizeCloseHistory(undefined), []);
assert.deepEqual(sanitizeCloseHistory('x'), []);
assert.deepEqual(
  sanitizeCloseHistory([['P', [{ kind: 'bogus', feesSol: 1 }, { kind: 'oor', feesSol: Number.NaN }, { kind: 'oor', feesSol: 0 }]], [5, []], ['Q', 'nope'], ['R', []], 'junk']),
  [['P', [{ kind: 'oor', feesSol: 0 }]]],
);
const long = Array.from({ length: 25 }, (_, i) => ({ kind: 'other' as const, feesSol: i }));
assert.equal(sanitizeCloseHistory([['P', long]])[0]![1].length, CLOSE_HISTORY_PER_POOL);
assert.equal(sanitizeCloseHistory([['P', long]])[0]![1].at(-1)!.feesSol, 24); // the newest are kept
const many = Array.from({ length: 150 }, (_, i): [string, CloseRec[]] => [`P${i}`, [{ kind: 'other', feesSol: 1 }]]);
const kept = sanitizeCloseHistory(many);
assert.equal(kept.length, CLOSE_HISTORY_MAX_POOLS);
assert.equal(kept.at(-1)![0], 'P149');
// the stop-loss cooldown lives in the persisted blacklist: it survives a restart while active and is pruned once expired
const slNow = 5_000_000;
const slState = { ...state, blacklist: [['SLPOOL', slNow + 4 * 3_600_000], ['OLD', slNow - 1]] as [string, number][], closeHistory: [['SLPOOL', [{ kind: 'stop loss' as const, feesSol: 0.02 }]]] as [string, CloseRec[]][] };
assert.equal(saveState(slState, f), true);
const slBack = loadState(W, f)!;
assert.deepEqual(pruneExpired(slBack.blacklist, slNow + 3_600_000), [['SLPOOL', slNow + 4 * 3_600_000]]); // 1 h later: still cooling, the expired entry is gone
assert.deepEqual(pruneExpired(slBack.blacklist, slNow + 5 * 3_600_000), []); // 5 h later: expired
assert.deepEqual(sanitizeCloseHistory(slBack.closeHistory), [['SLPOOL', [{ kind: 'stop loss', feesSol: 0.02 }]]]); // the new kind survives the round trip
console.log('OK: state store round-trips, rejects corrupt/foreign files, boot reconciliation trusts the chain and refuses ambiguity');
