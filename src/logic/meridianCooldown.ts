/**
 * Meridian pool-memory cooldowns (pool-memory.js recordDeploy): after a close, how long to keep the pool out.
 * low yield close -> 4h; the last N closes all OOR -> 12h; the last N deploys all earned fees -> 12h.
 * Pool and base mint are both blacklisted (the scanner checks either key).
 */
export type CloseKind = 'low yield' | 'oor' | 'other';
export interface CloseRec {
  kind: CloseKind;
  feesSol: number;
}
export interface CooldownCfg {
  oorCount: number;
  oorHours: number;
  repeatCount: number;
  repeatHours: number;
}

export const LOW_YIELD_COOLDOWN_HOURS = 4;

export function closeKindFromReason(reason: string): CloseKind {
  const r = reason.toLowerCase();
  if (r.startsWith('meridian: low yield')) return 'low yield';
  if (r.startsWith('meridian: out of range')) return 'oor';
  return 'other';
}

/** Cooldown hours (0 = none) given this pool's close history, newest last. */
export function cooldownHoursAfterClose(history: CloseRec[], c: CooldownCfg): number {
  let h = 0;
  const last = history[history.length - 1];
  if (last?.kind === 'low yield') h = Math.max(h, LOW_YIELD_COOLDOWN_HOURS);
  const oor = history.slice(-c.oorCount);
  if (oor.length >= c.oorCount && oor.every((d) => d.kind === 'oor')) h = Math.max(h, c.oorHours);
  const rep = history.slice(-c.repeatCount);
  if (c.repeatHours > 0 && rep.length >= c.repeatCount && rep.every((d) => d.feesSol > 0)) h = Math.max(h, c.repeatHours);
  return h;
}
