/**
 * /status wallet lines. Pure so a self-check can pin the wording.
 * `walletSol` must be a fresh getBalance read (null = read failed: shown as unavailable, never an old number).
 * Banked SOL (taken out of the ladder at a flip) already sits in the wallet, so it is shown as a memo and NOT added a second time.
 */
const hms = (iso: string) => iso.slice(11, 19) + ' UTC';
const s = (n: number) => n.toFixed(4);

export function walletFreeLine(walletSol: number | null, readAtIso: string): string {
  return walletSol === null ? 'wallet free SOL: unavailable' : `wallet free SOL: ${s(walletSol)} SOL (sumber: getBalance on-chain, ${hms(readAtIso)})`;
}

export interface TotalInput {
  walletSol: number | null;
  /** null = position values could not be read; [] = no open position */
  positions: { valueSol: number; feesSol: number }[] | null;
  bankedSol: number;
}

export function totalLines(i: TotalInput): string[] {
  if (i.walletSol === null) return ['total: unavailable (wallet free SOL tidak terbaca)'];
  if (i.positions === null) return ['total: unavailable (nilai posisi tidak terbaca)'];
  const value = i.positions.reduce((a, p) => a + p.valueSol, 0);
  const fees = i.positions.reduce((a, p) => a + p.feesSol, 0);
  const lines = [`total: ${s(i.walletSol)} (wallet free) + ${s(value)} (position value) + ${s(fees)} (unclaimed fees) = ${s(i.walletSol + value + fees)} SOL`];
  if (i.bankedSol > 0) lines.push(`banked ${s(i.bankedSol)} SOL sudah termasuk di wallet free, tidak dijumlah dua kali`);
  return lines;
}
