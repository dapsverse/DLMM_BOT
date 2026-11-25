import assert from 'node:assert/strict';
import { oorExitCooldownUntil, reentryCapUntil } from '../logic/poolReentryLimits.js';
import { closeKindFromReason, recordClose } from '../logic/meridianCooldown.js';
import { sanitizeCloseHistory } from '../services/stateStore.js';
import { env } from '../config/env.js';

const H = 3_600_000;
const now = 1_000_000_000_000;

// ---- max 2 entries per pool per 12 h
assert.equal(reentryCapUntil([now], now, 2, 12), null); // 1 close: free
assert.equal(reentryCapUntil([now - 2 * H, now], now, 2, 12), now - 2 * H + 12 * H); // 2 closes in 12 h: blocked until the older one is 12 h old
assert.equal(reentryCapUntil([now - 13 * H, now], now, 2, 12), null); // the older close is outside the window
// Rings-SOL 23-24 Nov: closes at 18:53, 20:25, 23:23 -> blocked after the second
const t = (h: number, m: number) => Date.UTC(2026, 10, 23, h, m);
assert.equal(reentryCapUntil([t(18, 53), t(20, 25)], t(20, 25), 2, 12), t(18, 53) + 12 * H);
assert.equal(reentryCapUntil([t(18, 53), t(20, 25), t(23, 23)], t(23, 23), 2, 12), t(20, 25) + 12 * H); // with 3 in the window the 2nd newest decides
assert.equal(reentryCapUntil([now - H, now], now, 2, 12, now + 48 * H), now + 48 * H); // never shortens a longer entry
assert.equal(reentryCapUntil([Number.NaN, now], now, 2, 12), null); // old records without a time do not count
assert.equal(reentryCapUntil([now - H, now], now, 0, 12), null); // off
assert.equal(reentryCapUntil([now - H, now], now, 2, 0), null); // off
assert.equal(reentryCapUntil([now - H, now, now + H], now, 3, 12), null); // a future time is ignored

// ---- 6 h pool cooldown after a meridian out-of-range exit
assert.equal(closeKindFromReason('MERIDIAN: out of range 30m >= 30m'), 'oor');
assert.equal(oorExitCooldownUntil('oor', now, 6), now + 6 * H);
assert.equal(oorExitCooldownUntil('low yield', now, 6), null);
assert.equal(oorExitCooldownUntil(closeKindFromReason('AI_EXIT: price above the ladder'), now, 6), null); // only the meridian OOR exit
assert.equal(oorExitCooldownUntil('oor', now, 6, now + 10 * H), now + 10 * H); // never shortens
assert.equal(oorExitCooldownUntil('oor', now, 0), null); // off

// ---- close times are kept in the persisted close history (old records without atMs stay valid)
const u = recordClose([{ kind: 'oor', feesSol: 0 }], { kind: 'oor', feesSol: 0.001, atMs: now }, 4);
assert.equal(u.hist[u.hist.length - 1]!.atMs, now);
const kept = sanitizeCloseHistory([['P', [{ kind: 'oor', feesSol: 0 }, { kind: 'other', feesSol: 0.01, atMs: now }]]]);
assert.equal(kept[0]?.[1].length, 2);
assert.equal(kept[0]?.[1][1]?.atMs, now);

// ---- defaults
if (process.env.POOL_MAX_ENTRIES_PER_WINDOW === undefined) assert.equal(env.POOL_MAX_ENTRIES_PER_WINDOW, 2);
if (process.env.POOL_ENTRY_WINDOW_HOURS === undefined) assert.equal(env.POOL_ENTRY_WINDOW_HOURS, 12);
if (process.env.OOR_EXIT_COOLDOWN_HOURS === undefined) assert.equal(env.OOR_EXIT_COOLDOWN_HOURS, 6);
console.log('OK: pool re-entry limits (max 2 per 12 h, 6 h after an out-of-range exit, persisted close times)');
