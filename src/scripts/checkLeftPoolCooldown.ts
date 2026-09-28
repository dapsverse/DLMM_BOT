/**
 * Self-check for the LEFT_POOL/LEAVE_POOL short cooldown (LEFT_POOL_COOLDOWN_MS,
 * env.ts) — added 2026-09-27/28 after a 43h live run showed trend-optAB-spot
 * whipsawing the same pool dozens of times back to back (a LEFT_POOL exit
 * never blacklisted at all, so a pool that just failed re-screen but was
 * still top-ranked got re-entered the very next tick). Fixed by giving
 * addToBlacklist() an optional custom duration, used with
 * LEFT_POOL_COOLDOWN_MS at all three LEFT_POOL/LEAVE_POOL call sites
 * (spotExecutor.ts, paperTrade.ts's DLMM path, rebalanceEngine.ts's
 * compoundCycle) instead of the long HARD_EXIT blacklist.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkLeftPoolCooldown.ts`.
 */
import assert from 'node:assert';
import { addToBlacklist } from '../logic/riskManager.js';
import { env } from '../config/env.js';

const now = 1_000_000;

// Default duration (HARD_EXIT's long blacklist) unchanged.
const hardExitBlacklist = new Map<string, number>();
addToBlacklist(hardExitBlacklist, 'poolA', now);
assert(
  hardExitBlacklist.get('poolA') === now + env.BLACKLIST_DURATION_MS,
  'expected default addToBlacklist call to use the long BLACKLIST_DURATION_MS',
);

// Custom duration (LEFT_POOL's short cooldown) applies when passed.
const leftPoolBlacklist = new Map<string, number>();
addToBlacklist(leftPoolBlacklist, 'poolB', now, env.LEFT_POOL_COOLDOWN_MS);
assert(
  leftPoolBlacklist.get('poolB') === now + env.LEFT_POOL_COOLDOWN_MS,
  'expected a custom durationMs to be honored instead of the default',
);

// The whole point: the cooldown must be meaningfully shorter than the
// HARD_EXIT blacklist, or it wouldn't let a genuinely-recovered pool back
// in sooner than a real risk violation would.
assert(
  env.LEFT_POOL_COOLDOWN_MS < env.BLACKLIST_DURATION_MS,
  'expected LEFT_POOL_COOLDOWN_MS to be shorter than BLACKLIST_DURATION_MS (it is a cooldown, not a violation penalty)',
);

console.log('OK: addToBlacklist honors a custom duration, LEFT_POOL_COOLDOWN_MS < BLACKLIST_DURATION_MS');
