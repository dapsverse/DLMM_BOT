/**
 * Self-check for the spot executor's two departures from the DLMM
 * executor's risk-decision shape (see spotExecutor.ts's file header):
 *
 *   1. Cost model: estimateSpotSwapCostSol swaps the FULL capital amount
 *      (one-directional buy/sell), not half like estimateCycleGasCostSol's
 *      LP-rebalance-to-50:50 formula.
 *   2. REBALANCE is unreachable for spot: unclaimedFeesUsd is always 0 (no
 *      LP fees) and isOutOfRange is always false (no bin range) — both
 *      REBALANCE triggers (fee-threshold, idle-forced) must never fire
 *      when fed spot-shaped input, even in scenarios that WOULD trigger
 *      idle-forced REBALANCE for a DLMM position (isOutOfRange: true).
 *   3. Stop-loss/take-profit still work identically for spot inputs — a
 *      spot position is just a differently-shaped evaluatePosition() call,
 *      the risk function itself is unchanged/shared.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkSpotExecutor.ts`.
 */
import assert from 'node:assert';
import { estimateCycleGasCostSol, estimateSpotSwapCostSol } from '../logic/costEstimate.js';
import { evaluatePosition, type PositionHealthInput } from '../logic/riskManager.js';
import { shouldForceLeaveOnFailedRescreen, resolveIdleCapitalSol } from '../logic/spotExecutor.js';
import { TAKE_PROFIT_TIERS } from '../config/constants.js';
import { env } from '../config/env.js';

// 0. Bug found live 2026-09-26: in the pristine pre-first-entry state
// (price/capital both still 0, never set), the idle-capital basis fed to
// the capital/TVL ratio check must fall back to INITIAL_LP_CAPITAL_SOL, not
// silently become `undefined` (which used to skip that slippage-safety
// check entirely for a process's first-ever entry).
assert(
  resolveIdleCapitalSol(0, 0) === env.INITIAL_LP_CAPITAL_SOL,
  'expected pristine (never-priced) state to fall back to INITIAL_LP_CAPITAL_SOL, not 0/undefined',
);
// Once a real price/capital pair exists, it should compute normally, not keep falling back.
assert(resolveIdleCapitalSol(100, 250) === 2.5, 'expected a real price/capital pair to compute capitalUsd/priceUsd normally');

// 1. Cost model: spot's swap leg is on the FULL capital, DLMM's is on HALF.
const capitalSol = 10;
const dlmmCost = estimateCycleGasCostSol(capitalSol);
const spotCost = estimateSpotSwapCostSol(capitalSol);
const dlmmSwapPortion = dlmmCost - 0.0005 * 3; // strip the 3-tx priority fee to isolate the slippage-on-half component
const spotSwapPortion = spotCost - 0.0005; // strip the 1-tx priority fee
assert(
  Math.abs(spotSwapPortion - dlmmSwapPortion * 2) < 1e-9,
  `expected spot's full-capital swap cost to be exactly 2x DLMM's half-capital swap cost, got spot=${spotSwapPortion} dlmm=${dlmmSwapPortion}`,
);

// 2. REBALANCE unreachable for spot — spot-shaped input (unclaimedFeesUsd:0, isOutOfRange:false).
const spotShapedBase: PositionHealthInput = {
  initialDepositUsd: 100,
  currentValueUsd: 105, // small unrealized gain, nowhere near stop-loss/take-profit
  rebalanceTimestamps: [],
  volume1hNowUsd: 1000,
  volume1hBaselineUsd: 1000, // no volume drop
  volume1hBaselineSetAtMs: Date.now(),
  unclaimedFeesUsd: 0,
  estimatedGasCostUsd: 0.01, // tiny threshold — a DLMM position with ANY unclaimed fees would clear this and REBALANCE
  isOutOfRange: false,
  outOfRangeSinceMs: null,
  peakProfitPct: 5,
};
assert(
  evaluatePosition(spotShapedBase).decision === 'HOLD',
  'expected spot-shaped input (0 fees, not out of range) to HOLD, not REBALANCE, even with a near-zero gas threshold',
);

// Prove the guard is actually load-bearing: the SAME scenario but shaped
// like a DLMM position stuck out-of-range past MAX_IDLE_OUT_OF_RANGE_MINUTES
// DOES trigger REBALANCE — so spot's decision space really is narrower by
// construction (isOutOfRange: false), not because the scenario itself never
// triggers it.
const dlmmShapedIdle: PositionHealthInput = {
  ...spotShapedBase,
  isOutOfRange: true,
  outOfRangeSinceMs: Date.now() - (env.MAX_IDLE_OUT_OF_RANGE_MINUTES + 1) * 60_000,
};
assert(
  evaluatePosition(dlmmShapedIdle).decision === 'REBALANCE',
  'test setup: expected a DLMM-shaped idle-out-of-range position to REBALANCE (proves the check above is meaningful, not vacuous)',
);

// 2b. The standalone fee-threshold REBALANCE (claim-without-closing while
// in-range) was removed 2026-09-26 — a DLMM-shaped position with a huge
// unclaimedFeesUsd and isOutOfRange:false must HOLD now, not REBALANCE,
// no matter how far past the old threshold the fees are.
const dlmmShapedHighFeesInRange: PositionHealthInput = {
  ...spotShapedBase,
  unclaimedFeesUsd: 1_000_000,
  estimatedGasCostUsd: 0.001,
  isOutOfRange: false,
};
assert(
  evaluatePosition(dlmmShapedHighFeesInRange).decision === 'HOLD',
  'expected in-range position with huge unclaimed fees to HOLD (the standalone fee-threshold REBALANCE trigger was removed)',
);

// 3. Stop-loss / take-profit still fire for spot-shaped input — same evaluatePosition, just a differently-shaped caller.
const spotStopLoss: PositionHealthInput = {
  ...spotShapedBase,
  currentValueUsd: 100 * (1 - (env.STOP_LOSS_PCT + 1) / 100), // just past the stop-loss threshold
};
assert(evaluatePosition(spotStopLoss).decision === 'HARD_EXIT', 'expected spot-shaped input past STOP_LOSS_PCT to HARD_EXIT');

const firstTier = TAKE_PROFIT_TIERS[0]!;
const spotTakeProfit: PositionHealthInput = {
  ...spotShapedBase,
  currentValueUsd: 100 * (1 + (firstTier.floorPct - 1) / 100), // 1pp below the sticky floor
  peakProfitPct: firstTier.armPct + 5, // armed, still in the first tier's band
};
assert(evaluatePosition(spotTakeProfit).decision === 'TAKE_PROFIT', 'expected spot-shaped input past the trailing take-profit floor to TAKE_PROFIT');

// 4. Profit guard on the periodic re-screen-without-replacement path (fixes
// the 2026-09-26 baton-SOL incident: trend-optAB-10sol-spot sold a
// currently-profitable position on a transient activity-metric snapshot,
// right before its DLMM sibling — which never even re-screened — rode the
// same pool to +3.89%).
assert(shouldForceLeaveOnFailedRescreen(0) === true, 'expected breakeven (0%) to still force-leave (guard only protects POSITIVE profit)');
assert(shouldForceLeaveOnFailedRescreen(-5) === true, 'expected a losing position to force-leave as before (guard is not universal amnesty)');
assert(shouldForceLeaveOnFailedRescreen(5) === false, 'expected a profitable position to be protected from a forced leave');

console.log('OK: spot cost model (full-capital swap) + REBALANCE-unreachable + stop-loss/take-profit + re-screen profit guard all behave as expected');
