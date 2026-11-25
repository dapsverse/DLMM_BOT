/**
 * Per-pool re-entry limits (2026-11-25, Master's rule after the churn of 23-25 Nov: Rings-SOL entered 4x in ~6 h, DCTY-SOL 3x in 24 h, each closed after 30-90 min
 * near 0 PnL, so the fees went to gas). Pure; both return a blacklist-until (epoch ms) for the POOL or null, never shorter than `existingUntil`.
 */

/**
 * Cap: at most `maxEntries` positions per pool in any `windowHours`. The bot holds one position at a time, so the pool's closes are its entries; once `maxEntries`
 * closes fall inside the window the pool is blocked until the oldest of those leaves the window. maxEntries <= 0 or windowHours <= 0 = off.
 */
export function reentryCapUntil(closeTimesMs: number[], nowMs: number, maxEntries: number, windowHours: number, existingUntil?: number): number | null {
  if (!(maxEntries > 0) || !(windowHours > 0)) return null;
  const windowMs = windowHours * 3_600_000;
  const recent = closeTimesMs.filter((t) => Number.isFinite(t) && t <= nowMs && nowMs - t < windowMs).sort((a, b) => b - a);
  if (recent.length < maxEntries) return null;
  const until = recent[maxEntries - 1]! + windowMs;
  return existingUntil !== undefined && existingUntil > until ? existingUntil : until;
}

/** Longer pool cooldown after a meridian "out of range 30m" exit (close kind 'oor'): the price left the ladder and stayed out, re-entering soon repeats it. hours <= 0 = off. */
export function oorExitCooldownUntil(closeKind: string, nowMs: number, hours: number, existingUntil?: number): number | null {
  if (closeKind !== 'oor' || !(hours > 0)) return null;
  const until = nowMs + hours * 3_600_000;
  return existingUntil !== undefined && existingUntil > until ? existingUntil : until;
}
