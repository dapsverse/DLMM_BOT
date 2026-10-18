/**
 * Realized PnL from two short wallet windows (2026-10-18). The wallet is shared (manual pools, deposits), so a long before/after balance
 * delta is contaminated; instead: spent = wallet drop across the ENTRY (deposit + rent + gas, seconds) and received = wallet gain across
 * the EXIT (close + token swap, seconds). Rent is inside both legs and cancels. Pure: the balance reads live in rebalanceEngine.
 */

/** Estimated cost of selling the token side at the exit (Jupiter fee + impact, as a % of the token value) plus the close gas. */
export function estimateExitCostSol(tokenValueSol: number, costPct: number, gasSol: number): number {
  return Math.max(tokenValueSol, 0) * (costPct / 100) + gasSol;
}

/** received - spent + SOL banked at a flip, in SOL and as % of the deposit; null whenever either leg was not measured reliably. */
export function realizedPnl(spentSol: number | undefined, receivedSol: number | null, bankedSol: number, depositSol: number): { pnlSol: number; pnlPct: number } | null {
  if (spentSol === undefined || receivedSol === null || !(depositSol > 0)) return null;
  const pnlSol = receivedSol + bankedSol - spentSol;
  return { pnlSol, pnlPct: (pnlSol / depositSol) * 100 };
}

/**
 * An entry spends at least the capital it deposits. A wallet read taken right after the tx can still be the stale pre-deposit balance
 * (spent ~0) or include other activity (spent far above); both are dropped rather than recorded.
 */
export function sanitizeSpent(spentSol: number, capitalSol: number): number | undefined {
  if (!Number.isFinite(spentSol) || spentSol < capitalSol * 0.9 || spentSol > capitalSol + 0.3) return undefined;
  return spentSol;
}
