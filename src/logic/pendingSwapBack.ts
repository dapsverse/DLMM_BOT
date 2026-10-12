import BN from 'bn.js';

/** A token principal whose swap-back to SOL failed after an irreversible close. `amount` is a raw-unit decimal string (persisted as JSON). */
export interface PendingSwapBack {
  mint: string;
  amount: string;
}

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
  if (toSwap.lten(0)) return null;
  await deps.swap(pending.mint, toSwap);
  return null;
}
