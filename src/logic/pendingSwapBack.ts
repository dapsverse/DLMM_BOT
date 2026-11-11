import BN from 'bn.js';

/** A token principal whose swap-back to SOL failed after an irreversible close. `amount` is a raw-unit decimal string (persisted as JSON). */
export interface PendingSwapBack {
  mint: string;
  amount: string;
  /**
   * The exit this swap-back belongs to (set by closeAndConvertToSol), so the realized PnL can be completed once the token is sold: the outcome is written
   * with a null realized PnL while the swap is pending (STANK-SOL 2026-11-11). partialReceivedSol = wallet gain over the close itself (without the token).
   */
  exit?: { pool: string; partialReceivedSol: number; spentSol: number; bankedSol: number; depositSol: number };
}

/** received over the whole exit = close + the late swap-back; null when the swap-back gain was not measured (<= 0) */
export function completedReceivedSol(partialReceivedSol: number, swapGainSol: number | null): number | null {
  if (swapGainSol === null || !Number.isFinite(swapGainSol) || swapGainSol <= 0 || !Number.isFinite(partialReceivedSol)) return null;
  return partialReceivedSol + swapGainSol;
}

/** Raw units below this are dust no router will quote (6 raw units blocked all entries on 2026-10-12): drop instead of retrying forever. */
export const DUST_RAW = 100;

export interface SwapBackDeps {
  getBalance: (mint: string) => Promise<BN>;
  swap: (mint: string, amount: BN) => Promise<unknown>;
}

/**
 * Tries to land a pending swap-back. Returns the remaining pending (null once done or nothing left to sell).
 * Throws when the swap fails, so the caller keeps its pending as is. Never sells more than the failed
 * principal: the fee portion the bot keeps as token on purpose stays untouched.
 * Pure of wallet/RPC imports (deps injected) so it can be self-checked.
 */
export async function settlePendingSwapBack(pending: PendingSwapBack | null, deps: SwapBackDeps): Promise<PendingSwapBack | null> {
  if (!pending) return null;
  const held = await deps.getBalance(pending.mint);
  const toSwap = BN.min(held, new BN(pending.amount));
  if (toSwap.ltn(DUST_RAW)) return null;
  await deps.swap(pending.mint, toSwap);
  return null;
}
