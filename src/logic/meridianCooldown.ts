/**
 * Meridian pool-memory cooldowns (pool-memory.js recordDeploy): after a close, how long to keep the pool out.
 * low yield close -> 4h; the last N closes all OOR -> 12h; the last N deploys all earned fees -> 12h.
 * Pool and base mint are both blacklisted (the scanner checks either key).
 */
export type CloseKind = 'low yield' | 'oor' | 'stop loss' | 'other';
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
  if (r.startsWith('meridian: stop loss')) return 'stop loss';
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

export const MERIDIAN_COOLDOWN_CFG: CooldownCfg = { oorCount: 3, oorHours: 12, repeatCount: 3, repeatHours: 12 };

export interface CloseUpdate {
  hist: CloseRec[];
  /** meridian pool-memory cooldown: pool AND base mint (0 = none) */
  bothHours: number;
  /** stop-loss cooldown (SL_POOL_COOLDOWN_HOURS): this pool only, other pools of the same token stay enterable (0 = none) */
  poolOnlyHours: number;
}

/** Adds one close to a pool's history (newest 10 kept) and works out which cooldowns it triggers. slHours 0 disables the stop-loss cooldown. */
export function recordClose(prev: CloseRec[] | undefined, rec: CloseRec, slHours: number, c: CooldownCfg = MERIDIAN_COOLDOWN_CFG): CloseUpdate {
  const hist = [...(prev ?? []), rec].slice(-10);
  return { hist, bothHours: cooldownHoursAfterClose(hist, c), poolOnlyHours: rec.kind === 'stop loss' && slHours > 0 ? slHours : 0 };
}

/** [address, blacklisted-until epoch ms] entries for a close: the pool gets the longer of the two cooldowns, the base mint only the meridian one. */
export function cooldownBlacklistAdds(u: CloseUpdate, pool: string, baseMint: string, nowMs: number): [string, number][] {
  const out: [string, number][] = [];
  const poolHours = Math.max(u.bothHours, u.poolOnlyHours);
  if (poolHours > 0) out.push([pool, nowMs + poolHours * 3_600_000]);
  if (u.bothHours > 0) out.push([baseMint, nowMs + u.bothHours * 3_600_000]);
  return out;
}

/** Same bookkeeping on the persisted arrays (used by manualOps, which edits state/live-state.json while the bot is stopped). Never shortens an existing blacklist entry. */
export function closeRecordUpdate(
  closeHistory: [string, CloseRec[]][] | undefined,
  blacklist: [string, number][],
  pool: string,
  baseMint: string,
  rec: CloseRec,
  nowMs: number,
  slHours: number,
): { closeHistory: [string, CloseRec[]][]; blacklist: [string, number][] } {
  const prev = (closeHistory ?? []).find(([p]) => p === pool)?.[1];
  const u = recordClose(prev, rec, slHours);
  const history: [string, CloseRec[]][] = [...(closeHistory ?? []).filter(([p]) => p !== pool), [pool, u.hist]];
  const bl = new Map(blacklist);
  for (const [addr, until] of cooldownBlacklistAdds(u, pool, baseMint, nowMs)) bl.set(addr, Math.max(bl.get(addr) ?? 0, until));
  return { closeHistory: history, blacklist: [...bl.entries()] };
}
