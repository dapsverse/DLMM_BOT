/**
 * Pure debounce logic for "how long has this position been out of range",
 * shared by the real bot (logic/rebalanceEngine.ts's PoolContext) and
 * paper-trade (scripts/paperTrade.ts's VirtualPosition) — kept in its own
 * zero-dependency module (not exported from rebalanceEngine.ts) so
 * paper-trade can import it without pulling in rebalanceEngine.ts's wallet/
 * RPC-touching transitive imports (services/solana.ts decodes PRIVATE_KEY
 * at module load time) — paper-trade is meant to run with no wallet, no
 * real transactions, ever.
 *
 * Confirmed live 2026-09-24 (familiars-SOL): a position sitting right at
 * its range boundary flickered in/out of range on ordinary price noise —
 * the old reset-on-any-single-in-range-tick logic cleared outOfRangeSinceMs
 * on every blip, so the position never accumulated a clean
 * MAX_IDLE_OUT_OF_RANGE_MINUTES streak and the idle-forced rebalance never
 * fired, despite being effectively out-of-range most of the time.
 *
 * Self-check: src/scripts/checkOutOfRangeDebounce.ts.
 */

/** Require this many minutes of CONTINUOUS in-range before actually clearing outOfRangeSinceMs — a momentary flicker back in-range no longer resets progress. */
export const OUT_OF_RANGE_RESET_GRACE_MS = 2 * 60_000;

export interface OutOfRangeTrackingState {
  /** When the position first went out-of-range (epoch ms) — null while in-range (subject to the grace debounce below). */
  outOfRangeSinceMs: number | null;
  /** When the position most recently came BACK in-range (epoch ms) — null while out-of-range or while fully settled in-range. Only used to debounce outOfRangeSinceMs resets. */
  inRangeSinceMs: number | null;
}

export function computeOutOfRangeTracking(state: OutOfRangeTrackingState, isOutOfRange: boolean, now = Date.now()): OutOfRangeTrackingState {
  if (isOutOfRange) {
    return { outOfRangeSinceMs: state.outOfRangeSinceMs ?? now, inRangeSinceMs: null };
  }
  if (state.outOfRangeSinceMs === null) return { outOfRangeSinceMs: null, inRangeSinceMs: null }; // already fully settled in-range
  const inRangeSinceMs = state.inRangeSinceMs ?? now;
  if (now - inRangeSinceMs >= OUT_OF_RANGE_RESET_GRACE_MS) {
    return { outOfRangeSinceMs: null, inRangeSinceMs: null }; // stayed in-range long enough, actually reset
  }
  return { outOfRangeSinceMs: state.outOfRangeSinceMs, inRangeSinceMs }; // still within grace period, keep the streak alive
}
