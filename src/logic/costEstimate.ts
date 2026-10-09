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

// estimateClaimCostSol (standalone claim-without-closing cost) removed
// 2026-09-26 along with the fee-threshold REBALANCE trigger it priced —
// see riskManager.ts's removal note.

/** Worst-case rent-exemption cost (SOL) for one DLMM bin-array account. */
const BIN_ARRAY_RENT_SOL = 0.075;
/** A DLMM bin-array account is a fixed 70-bin segment, on-chain. */
const BINS_PER_ARRAY = 70;

/**
 * Estimated SOL rent cost for the bin-array account(s) a position's range
 * will touch. Idea borrowed 2026-10-08 from comparing against
 * CryptoGnome/dlmmbot's planner.ts — this project never modeled bin-array
 * rent at all before. Approximate (plain ceil, +1 safety bin for alignment
 * straddling a 70-bin array boundary) rather than their alignment-exact
 * version — this is informational cost-accounting only (logged at position
 * open, not a hard budget gate), so an approximation that never
 * UNDER-estimates is good enough; exact alignment math only matters if this
 * ever becomes a real gating decision. Bin-array accounts are shared
 * pool-wide infrastructure, not per-position — if a required array already
 * exists (another LP touched that price range before), this entry pays
 * nothing extra; this function can't know that in advance, so it's a
 * worst-case ceiling, not a precise forecast.
 */
export function estimateBinRentSol(radius: number): number {
  const binCount = 2 * radius + 1;
  const arraysSpanned = Math.ceil(binCount / BINS_PER_ARRAY) + 1;
  return arraysSpanned * BIN_ARRAY_RENT_SOL;
}
