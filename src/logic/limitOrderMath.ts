import BN from 'bn.js';

/**
 * Pure helpers for DLMM limit orders (no wallet/RPC imports, so they can be self-checked).
 *
 * DLMM price = Y per X; bin id grows with that price. A "bid" (isAskSide=false) deposits Y at bins <= active,
 * an "ask" (isAskSide=true) deposits X at bins >= active. The pool's SOL leg can be X or Y, so "buy the token
 * cheaper" / "sell the token higher" map to different sides depending on `xIsSol`.
 */
export type OrderGoal = 'buyToken' | 'sellToken';

export interface OrderSpec {
  isAskSide: boolean;
  /** +1: place at higher bin ids than the active bin, -1: lower */
  dir: 1 | -1;
  /** the deposited mint is token X (true) or token Y (false) */
  depositIsX: boolean;
}

export function orderSpec(xIsSol: boolean, goal: OrderGoal): OrderSpec {
  // Token price (in SOL) falling means bin id falling when the token is X, rising when SOL is X.
  const tokenDownDir: 1 | -1 = xIsSol ? 1 : -1;
  const dir: 1 | -1 = goal === 'buyToken' ? tokenDownDir : ((-tokenDownDir) as 1 | -1);
  const isAskSide = dir === 1; // ask lives at/above the active bin, bid at/below
  const depositIsX = isAskSide; // ask deposits X, bid deposits Y
  return { isAskSide, dir, depositIsX };
}

/** Bins needed to move the TOKEN price by `movePct` percent in the given direction (always >= 1). */
export function binsForMove(movePct: number, binStep: number, tokenMove: 'down' | 'up'): number {
  const step = Math.log(1 + binStep / 10_000);
  const ratio = tokenMove === 'down' ? 1 / (1 - movePct / 100) : 1 + movePct / 100;
  return Math.max(1, Math.ceil(Math.log(ratio) / step));
}

/**
 * `count` consecutive bins starting `offset` bins away from the active bin (in `dir`), the amount split evenly
 * (remainder in the bin nearest the active bin). Returned in INCREASING bin id order: the program rejects
 * unsorted ids ("Bin IDs must be in increasing order", seen in a mainnet simulation 2026-10-14).
 */
export function spreadBins(activeId: number, dir: 1 | -1, offset: number, count: number, amount: BN): { id: number; amount: BN }[] {
  const per = amount.divn(count);
  const rem = amount.sub(per.muln(count));
  const bins = Array.from({ length: count }, (_, j) => ({ id: activeId + dir * (offset + j), amount: j === 0 ? per.add(rem) : per }));
  return bins.sort((a, b) => a.id - b.id);
}

/** Token price change in percent between two active bins (the token is X: bin id rises with its price; SOL is X: bin id falls with it). */
export function tokenPriceChangePct(binAtPlace: number, binNow: number, binStep: number, xIsSol: boolean): number {
  const diff = xIsSol ? binAtPlace - binNow : binNow - binAtPlace;
  return (Math.pow(1 + binStep / 10_000, diff) - 1) * 100;
}

/**
 * After an entry-bid wait: abort the entry when the token ran away (price up more than maxChasePct since the bid was placed)
 * and the bid mostly did not fill (< 0.5) — buying the rest at market would chase. maxChasePct <= 0 never aborts.
 */
export function shouldAbortEntry(fraction: number, priceChangePct: number, maxChasePct: number): boolean {
  return maxChasePct > 0 && fraction < 0.5 && priceChangePct > maxChasePct;
}

/**
 * Fraction (0..1) of the deposit that has been filled, from the order's deposit-side totals.
 * The SDK's parsed order reports UI (decimal) amounts such as "0.005", not raw units (found on a mainnet test 2026-10-14).
 */
export function filledFraction(totalDeposit: string, totalUnfilled: string): number {
  const d = Number(totalDeposit);
  const u = Number(totalUnfilled);
  if (!Number.isFinite(d) || !Number.isFinite(u) || d <= 0) return 0;
  return Math.min(1, Math.max(0, (d - u) / d));
}
