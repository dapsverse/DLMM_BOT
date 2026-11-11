import assert from 'node:assert/strict';
import { escalatedSlippageBps } from '../logic/swapSlippage.js';
import { completedReceivedSol } from '../logic/pendingSwapBack.js';
import { realizedPnl } from '../logic/realizedPnl.js';
import { patchLatestOutcome } from '../services/aiOutcomes.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';
import { createRetryQueue, delayedPrefix } from '../logic/notifyRetryQueue.js';
import { env } from '../config/env.js';

// ---- (1) exit swap slippage widens per retry attempt, capped (STANK-SOL 2026-11-11 failed 4x with 0x1771 at a fixed 800)
assert.deepEqual([0, 1, 2, 3].map((n) => escalatedSlippageBps(800, n, 400, 2000)), [800, 1200, 1600, 2000]);
assert.equal(escalatedSlippageBps(800, 9, 400, 2000), 2000); // capped
assert.equal(escalatedSlippageBps(800, 3, 0, 2000), 800); // step 0 = fixed
assert.equal(escalatedSlippageBps(800, 2, 400, 500), 800); // a cap below the base never lowers the base
if (process.env.JUPITER_EXIT_SLIPPAGE_STEP_BPS === undefined) assert.equal(env.JUPITER_EXIT_SLIPPAGE_STEP_BPS, 400);
if (process.env.JUPITER_EXIT_SLIPPAGE_MAX_BPS === undefined) assert.equal(env.JUPITER_EXIT_SLIPPAGE_MAX_BPS, 2000);

// ---- (2) realized PnL completed after the late swap-back
assert.equal(completedReceivedSol(0.131, 0.918), 0.131 + 0.918);
assert.equal(completedReceivedSol(0.131, null), null); // not measured -> stays unknown
assert.equal(completedReceivedSol(0.131, 0), null);
assert.equal(completedReceivedSol(0.131, -0.01), null);
const real = realizedPnl(1.03, completedReceivedSol(0.131, 0.918), 0, 1.0)!;
assert.ok(Math.abs(real.pnlSol - (0.131 + 0.918 - 1.03)) < 1e-12);
// the outcome line of that exit (written with null realized) gets the figure; earlier lines and other pools are untouched
const jsonl = [
  JSON.stringify({ at: 'a', pool: 'P', realizedPnlSol: 0.01, realizedPnlPct: 1 }),
  JSON.stringify({ at: 'b', pool: 'Q', pnlPct: -1 }),
  JSON.stringify({ at: 'c', pool: 'P', pnlPct: -5, exitReason: 'AI_EXIT' }),
  '',
].join('\n');
const patched = patchLatestOutcome(jsonl, 'P', { realizedPnlSol: -0.0812345, realizedPnlPct: -7.891 })!;
const rows = patched.split('\n');
assert.equal(rows[0], jsonl.split('\n')[0]);
assert.equal(rows[1], jsonl.split('\n')[1]);
assert.deepEqual(JSON.parse(rows[2]!), { at: 'c', pool: 'P', pnlPct: -5, exitReason: 'AI_EXIT', realizedPnlSol: -0.08123, realizedPnlPct: -7.89, realizedAfterSwapBack: true });
assert.equal(rows[3], '');
assert.equal(patchLatestOutcome(patched, 'P', { realizedPnlSol: 1, realizedPnlPct: 1 }), null); // latest P already measured: never overwritten
assert.equal(patchLatestOutcome(jsonl, 'Z', { realizedPnlSol: 1, realizedPnlPct: 1 }), null); // unknown pool
// the exit info survives a restart in the state file; a malformed one is dropped, the file is still trusted
const base = { version: STATE_VERSION, wallet: 'W', savedAtMs: 1, currentCapitalSol: 1, inFlight: false, blacklist: [], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 }, position: null, lastOtherMint: null, lastSwitchAtMs: 0 };
const exit = { pool: 'P', partialReceivedSol: 0.131, spentSol: 1.03, bankedSol: 0, depositSol: 1 };
const s1 = parseState(JSON.stringify({ ...base, pendingSwapBack: { mint: 'M', amount: '23', exit } }), 'W');
assert.deepEqual(s1?.pendingSwapBack, { mint: 'M', amount: '23', exit });
const s2 = parseState(JSON.stringify({ ...base, pendingSwapBack: { mint: 'M', amount: '23', exit: { pool: 'P', partialReceivedSol: 'x' } } }), 'W');
assert.deepEqual(s2?.pendingSwapBack, { mint: 'M', amount: '23' });
const s3 = parseState(JSON.stringify({ ...base, pendingSwapBack: { mint: 'M', amount: '23' } }), 'W'); // older files: no exit info
assert.deepEqual(s3?.pendingSwapBack, { mint: 'M', amount: '23' });

// ---- (3) bounded Telegram resend queue
const t0 = 1_000_000;
const q = createRetryQueue({ max: 3, maxTries: 2, maxAgeMs: 30 * 60_000, retryEveryMs: 60_000 });
q.push({ text: 'a', chatId: 'c', kind: 'event' }, t0);
q.push({ text: 'a', chatId: 'c', kind: 'event' }, t0); // identical: queued once
assert.equal(q.size(), 1);
assert.deepEqual(q.due(t0 + 30_000), []); // not before retryEveryMs
const [m] = q.due(t0 + 60_000);
assert.equal(m?.text, 'a');
q.result(m!, false, t0 + 60_000);
assert.deepEqual(q.due(t0 + 90_000), []); // waits again after a failed resend
q.result(q.due(t0 + 120_000)[0]!, false, t0 + 120_000); // second failed resend -> tries 2 = maxTries
assert.deepEqual(q.due(t0 + 200_000), []); // given up
assert.equal(q.size(), 0);
assert.equal(q.dropped(), 1);
// success removes; queue bounded (oldest dropped); age limit
q.push({ text: 'b', chatId: 'c', kind: 'event' }, t0);
q.result(q.due(t0 + 60_000)[0]!, true, t0 + 60_000);
assert.equal(q.size(), 0);
for (const t of ['1', '2', '3', '4', '5']) q.push({ text: t, chatId: 'c', kind: 'event' }, t0);
assert.equal(q.size(), 3);
assert.deepEqual(q.due(t0 + 60_000, 10).map((x) => x.text), ['3', '4', '5']);
assert.deepEqual(q.due(t0 + 31 * 60_000), []); // older than maxAgeMs: dropped
assert.equal(q.size(), 0);
// at most n resends per tick
const q2 = createRetryQueue({ max: 20, maxTries: 10, maxAgeMs: 3_600_000, retryEveryMs: 0 });
for (let i = 0; i < 10; i++) q2.push({ text: `m${i}`, chatId: 'c', kind: 'event' }, t0);
assert.equal(q2.due(t0).length, 3);
assert.equal(delayedPrefix(Date.UTC(2026, 10, 11, 2, 30)), '⏳ tertunda (gagal terkirim 09:30 WIB)\n');

console.log('OK: swap-back slippage escalation, realized PnL after a late swap-back, Telegram resend queue');
