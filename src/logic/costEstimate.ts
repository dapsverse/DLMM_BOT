import { env } from '../config/env.js';

/**
 * All-in cost (SOL) of one rebalance/compound cycle: priority fees for
 * close+swap+reopen, plus the Jupiter swap's slippage budget + a typical
 * DEX fee on the ~half of capital that gets rebalanced to 50:50.
 *
 * Split into its own wallet-free module (not rebalanceEngine.ts) so
 * paperTrade.ts can import it without pulling in meteoraDLMM.ts/solana.ts's
 * eager wallet decode — this formula needs no signing key to evaluate.
 *
 * ponytail: flat priority-fee assumption, not live network congestion —
 * rebalanceEngine.ts's actual execution still pulls a live estimate via
 * solana.ts's getDynamicPriorityFeeMicroLamports when sending real
 * transactions; this is only for the pre-trade threshold check and for
 * paper-trade's cost projection.
 */
export function estimateCycleGasCostSol(capitalSol: number): number {
  const txCount = 3; // close+claim (bundled), swap, reopen
  const priorityFeeSol = 0.0005 * txCount;
  const swapAmountSol = capitalSol * 0.5; // roughly half gets swapped to rebalance the ratio
  const swapCostSol = swapAmountSol * ((env.SLIPPAGE_BPS + 30) / 10_000); // slippage budget + ~0.3% DEX fee
  return priorityFeeSol + swapCostSol;
}

/**
 * All-in cost (SOL) of one spot swap leg (buy-in or sell-out) — one tx,
 * slippage budget + DEX fee on the FULL amount. Unlike
 * estimateCycleGasCostSol above, a spot swap moves 100% of capital one
 * direction (no LP deposit ratio to balance), so there's no "half capital"
 * discount and no close/reopen leg — just the swap itself.
 */
export function estimateSpotSwapCostSol(capitalSol: number): number {
  const priorityFeeSol = 0.0005; // 1 tx
  const swapCostSol = capitalSol * ((env.SLIPPAGE_BPS + 30) / 10_000);
  return priorityFeeSol + swapCostSol;
}

/**
 * Cost (SOL) of claiming fees WITHOUT closing the position — one tx, no
 * swap. Used when a fee-threshold REBALANCE fires while still in-range: no
 * need to re-center a range that isn't out of range, so skip the
 * close+swap+reopen cycle entirely and just harvest.
 */
export function estimateClaimCostSol(): number {
  return 0.0005; // 1 tx
}
