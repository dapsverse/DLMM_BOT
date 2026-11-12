/**
 * Per-TOKEN cooldown after a losing live exit (2026-11-12, Master's rule). STANK-SOL was entered three times in 4 days, the last two ending at -9.66% (11 Nov 02:30)
 * and -9.65% (11 Nov 22:56), both by an AI exit: the meridian/SL cooldowns only covered a stop loss or an out-of-range exit and only the pool, so the token was free
 * again. Now ANY exit reason with a loss >= TOKEN_LOSS_COOLDOWN_MIN_LOSS_PCT blocks the token itself (every pool holding it: the scanner checks the non-SOL mint
 * against the same blacklist map) for TOKEN_LOSS_COOLDOWN_HOURS. Pure.
 */

/**
 * Blacklist-until (epoch ms) for the token, or null when no cooldown applies. The loss is the realized PnL % when measured, else the snapshot PnL %
 * (realized can be null while a swap-back is pending, as on 11 Nov 02:30). Never shortens a longer cooldown already on the token. hours <= 0 = off.
 */
export function tokenLossCooldownUntil(
  realizedPnlPct: number | null | undefined,
  snapshotPnlPct: number | null | undefined,
  minLossPct: number,
  hours: number,
  nowMs: number,
  existingUntil?: number,
): number | null {
  if (!(hours > 0)) return null;
  const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const pct = fin(realizedPnlPct) ? realizedPnlPct : fin(snapshotPnlPct) ? snapshotPnlPct : null;
  if (pct === null || pct > -Math.max(minLossPct, 0)) return null;
  const until = nowMs + hours * 3_600_000;
  return existingUntil !== undefined && existingUntil > until ? existingUntil : until;
}
