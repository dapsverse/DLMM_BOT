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
