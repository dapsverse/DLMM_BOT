/**
 * Upside break: price left the range upward, so the position sold all its token into SOL and earns no fee
 * any more (baton-SOL 2026-10-12: all-SOL 24 min after entry, then the idle-forced rebalance would re-buy the
 * token higher). Detected as out-of-range AND the token side worth ~0 of the position. A downside break
 * (all token, no SOL) never matches. Pure, no wallet imports, so it can be self-checked.
 */
export const UPSIDE_BREAK_MAX_TOKEN_SHARE = 0.02;

export function shouldExitOnUpsideBreak(p: {
  exitAfterMin: number; // 0 = feature off
  isOutOfRange: boolean;
  outOfRangeSinceMs: number | null;
  nowMs: number;
  tokenValueSol: number;
  totalValueSol: number;
}): boolean {
  if (p.exitAfterMin <= 0 || !p.isOutOfRange || p.outOfRangeSinceMs === null) return false;
  if (p.totalValueSol <= 0) return false;
  if (p.tokenValueSol / p.totalValueSol > UPSIDE_BREAK_MAX_TOKEN_SHARE) return false;
  return p.nowMs - p.outOfRangeSinceMs >= p.exitAfterMin * 60_000;
}
