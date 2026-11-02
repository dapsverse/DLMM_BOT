/**
 * Dip-entry gate (user decision 2026-11-01): enter only a pool whose price sits minPct..maxPct below its 4h high (5m candles), on top of the other live gates.
 * `dropPct` is the signed % of the last close vs the 4h high (<= 0). Unknown data fails closed: the strategy needs positive evidence of a dip.
 * Backtest note (S2 24-31 Oct, 149 dip events): forward returns and the live ladder were NOT better than without the filter (ladder -0.09%/pos, PF 0.91).
 */
export function dipEntryReject(dropPct: number | null | undefined, minPct: number, maxPct: number): string | null {
  if (dropPct === null || dropPct === undefined || !Number.isFinite(dropPct)) return '4h high unavailable (dip gate fails closed)';
  const below = -dropPct;
  if (below < minPct) return `no dip: ${below.toFixed(1)}% below the 4h high, need ${minPct}-${maxPct}%`;
  if (below > maxPct) return `too deep: ${below.toFixed(1)}% below the 4h high, max ${maxPct}%`;
  return null;
}
