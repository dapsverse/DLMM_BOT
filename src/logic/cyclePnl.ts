/**
 * Cycle PnL for display. A bid-ask flip closes the SOL ladder and opens a NEW Meteora position (deposit = the token's value at that moment),
 * so Meteora's own deposit/PnL for the open position restarts from the flip. The cycle is one trade: basis = the ORIGINAL deposit
 * (`initialDepositSol`, never reset by the flip) and the SOL taken out at the flip (`bankedSol`, principal + SOL fees of the closed ladder) counts as value.
 * Pure (no imports) so the Telegram daemon and the self-check can share it.
 */
export interface CycleBasis {
  initialDepositSol: number;
  flipPhase?: boolean;
  bankedSol?: number;
}

export interface CycleView {
  depositSol: number;
  pnlSol: number;
  pnlPct: number;
  /** SOL banked at the flip (0 when not flipped) */
  bankedSol: number;
  flipped: boolean;
}

/** `meteora*` are the open position's own figures (PnL already includes unclaimed fees). Non-flip positions return Meteora's numbers unchanged. */
export function cycleView(valueSol: number, feesSol: number, meteoraDepositSol: number, meteoraPnlSol: number, meteoraPnlPct: number, basis?: CycleBasis | null): CycleView {
  if (basis?.flipPhase && Number.isFinite(basis.initialDepositSol) && basis.initialDepositSol > 0) {
    const bankedSol = Number.isFinite(basis.bankedSol) ? (basis.bankedSol as number) : 0;
    const pnlSol = valueSol + feesSol + bankedSol - basis.initialDepositSol;
    return { depositSol: basis.initialDepositSol, pnlSol, pnlPct: (pnlSol / basis.initialDepositSol) * 100, bankedSol, flipped: true };
  }
  return { depositSol: meteoraDepositSol, pnlSol: meteoraPnlSol, pnlPct: meteoraPnlPct, bankedSol: 0, flipped: false };
}
