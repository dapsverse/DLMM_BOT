/**
 * Guard against a position read that comes back empty while the bot still tracks the position (RPC outage / lag).
 * Live 2026-10-27 (3Ji3yw) and 2026-10-28 (Nothing-SOL): getUserPositions returned [] on a healthy ladder, the health snapshot priced it
 * as value 0, evaluatePosition saw "-100% unrealized loss" and the stop loss fired (and blacklisted the pool 4 h) on a position that was fine.
 * A miss now waits; only `confirmTicks` consecutive misses count as "really gone" and ask for a reconcile against the chain (no stop loss, no blacklist).
 * confirmTicks <= 0 / NaN = off (old behaviour: every read is trusted).
 */
export type MissingPositionAction = 'proceed' | 'wait' | 'reconcile';

export function trackMissingPosition(found: boolean, misses: number, confirmTicks: number): { misses: number; action: MissingPositionAction } {
  if (found || !(confirmTicks > 0)) return { misses: 0, action: 'proceed' };
  const next = misses + 1;
  return next >= confirmTicks ? { misses: 0, action: 'reconcile' } : { misses: next, action: 'wait' };
}
