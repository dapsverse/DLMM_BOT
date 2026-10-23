import { cycleView, type CycleBasis } from './cyclePnl.js';

/**
 * Text lines for /status and /posisi (and so /aireport). Pure so a self-check can pin the exact wording.
 * Non-flip positions keep the original wording; a flipped position is labelled as the flip position only and gets an explicit
 * "total cycle value" line (position + fees + banked SOL), because Meteora's figures describe the NEW position alone.
 */
export interface PoolLineInput {
  tokenX: string;
  tokenY: string;
  binStep: number;
  baseFee: number;
  valueSol: number;
  valueUsd: number;
  feesSol: number;
  feesUsd: number;
  depositSol: number;
  pnlSol: number;
  pnlPct: number;
  feePerTvl24h: number;
  outOfRange: boolean;
}

const sg = (n: number, d = 4) => (n >= 0 ? '+' : '') + n.toFixed(d);

export function poolLineTexts(p: PoolLineInput, solPrice: number, detail: boolean, basis?: CycleBasis | null): string[] {
  const cv = cycleView(p.valueSol, p.feesSol, p.depositSol, p.pnlSol, p.pnlPct, basis);
  const usd = (sol: number) => (solPrice > 0 ? ` ($${(sol * solPrice).toFixed(2)})` : '');
  const valueLabel = cv.flipped ? 'flip position value' : 'value';
  const out = [
    `${p.tokenX}-${p.tokenY}: ${valueLabel} ${p.valueSol.toFixed(4)} SOL${usd(p.valueSol)}, fees ${p.feesSol.toFixed(4)} SOL${usd(p.feesSol)}, PnL ${sg(cv.pnlSol)} SOL${usd(cv.pnlSol)} (${sg(cv.pnlPct, 2)}%)${cv.flipped ? ` [cycle incl. flip, banked ${cv.bankedSol.toFixed(4)} SOL]` : ''}`,
  ];
  if (cv.flipped) out.push(`total cycle value: ${cv.totalValueSol.toFixed(4)} SOL${usd(cv.totalValueSol)} = posisi ${p.valueSol.toFixed(4)} + fee ${p.feesSol.toFixed(4)} + banked ${cv.bankedSol.toFixed(4)}`);
  if (detail) {
    out.push(
      cv.flipped ? `deposit (original, before flip): ${cv.depositSol.toFixed(4)} SOL${usd(cv.depositSol)}; flipped position deposit: ${p.depositSol.toFixed(4)} SOL` : `deposit: ${cv.depositSol.toFixed(4)} SOL${usd(cv.depositSol)}`,
      `fees generated (unclaimed): ${p.feesSol.toFixed(4)} SOL = $${p.feesUsd.toFixed(2)}`,
      `${cv.flipped ? 'flip position value now (not the whole cycle)' : 'position value now'}: ${p.valueSol.toFixed(4)} SOL = $${p.valueUsd.toFixed(2)}`,
      `PnL incl. fees: ${sg(cv.pnlSol)} SOL = ${sg(cv.pnlSol * solPrice, 2).replace(/^([+-])/, '$1$')} (${sg(cv.pnlPct, 2)}%)${cv.flipped ? ' (whole cycle)' : ''}`,
      `pool fee/TVL 24h: ${p.feePerTvl24h.toFixed(2)}%, bin step ${p.binStep}, base fee ${p.baseFee}%`,
      `range: ${p.outOfRange ? 'OUT OF RANGE' : 'in range'}`,
      `SOL price: $${solPrice.toFixed(2)}`,
    );
  }
  return out;
}
