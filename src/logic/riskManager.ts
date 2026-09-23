import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export type RiskDecision = 'HOLD' | 'REBALANCE' | 'HARD_EXIT' | 'TAKE_PROFIT';

export interface PositionHealthInput {
  /** USD value of capital deposited when the position was opened/last compounded. */
  initialDepositUsd: number;
  /** Current USD value of principal + unclaimed fees in the position. */
  currentValueUsd: number;
  /** Epoch-ms timestamps of every rebalance done on this pool so far. */
  rebalanceTimestamps: number[];
  /** Pool's trailing 1h volume, now vs. when the position was opened. */
  volume1hNowUsd: number;
  volume1hBaselineUsd: number;
  /** Fee/gas inputs for the rebalance-trigger threshold rule. */
  unclaimedFeesUsd: number;
  estimatedGasCostUsd: number;
  /** Bin-range status — out-of-range means the position has stopped earning new fees (see idle-forced rebalance below). */
  isOutOfRange?: boolean;
  /** When the position first went out-of-range (epoch ms), null/undefined while in-range. */
  outOfRangeSinceMs?: number | null;
  /** Highest unrealized profit % this position has ever reached (caller-tracked, updated with THIS tick's profit before calling evaluatePosition — see rebalanceEngine.ts/paperTrade.ts). 0 for a fresh position. */
  peakProfitPct: number;
}

export interface RiskEvaluation {
  decision: RiskDecision;
  reasons: string[];
}

/** Drops rebalance timestamps older than 1h in place and returns the count within the window. */
export function countRecentRebalances(timestamps: number[], now = Date.now()): number {
  const oneHourAgo = now - 60 * 60_000;
  while (timestamps.length && timestamps[0]! < oneHourAgo) timestamps.shift();
  return timestamps.length;
}

/**
 * Decision tree per spec:
 * HARD_EXIT if unrealized loss >= STOP_LOSS_PCT, OR >MAX_REBALANCE_PER_HOUR
 * rebalances in the trailing hour (anti-falling-knife), OR trailing 1h
 * volume dropped > VOLUME_DROP_HARD_EXIT_PCT vs. baseline.
 * REBALANCE if unclaimed fees clear the gas/slippage threshold.
 * Otherwise HOLD.
 */
export function evaluatePosition(input: PositionHealthInput, now = Date.now()): RiskEvaluation {
  const reasons: string[] = [];

  const lossPct =
    input.initialDepositUsd > 0
      ? ((input.initialDepositUsd - input.currentValueUsd) / input.initialDepositUsd) * 100
      : 0;
  if (lossPct >= env.STOP_LOSS_PCT) {
    reasons.push(`unrealized loss ${lossPct.toFixed(2)}% >= STOP_LOSS_PCT ${env.STOP_LOSS_PCT}%`);
  }
  const profitPct = -lossPct;

  const recentRebalances = countRecentRebalances(input.rebalanceTimestamps, now);
  if (recentRebalances > env.MAX_REBALANCE_PER_HOUR) {
    reasons.push(`${recentRebalances} rebalances in trailing 1h > MAX_REBALANCE_PER_HOUR ${env.MAX_REBALANCE_PER_HOUR}`);
  }

  const volDropPct =
    input.volume1hBaselineUsd > 0
      ? ((input.volume1hBaselineUsd - input.volume1hNowUsd) / input.volume1hBaselineUsd) * 100
      : 0;
  if (volDropPct > env.VOLUME_DROP_HARD_EXIT_PCT) {
    reasons.push(`1h volume dropped ${volDropPct.toFixed(2)}% > ${env.VOLUME_DROP_HARD_EXIT_PCT}%`);
  }

  if (reasons.length) {
    logger.warn('[riskManager] HARD_EXIT', { reasons });
    return { decision: 'HARD_EXIT', reasons };
  }

  if (input.peakProfitPct >= env.TAKE_PROFIT_ARM_PCT) {
    const floorPct = input.peakProfitPct - env.TAKE_PROFIT_GIVEBACK_PCT;
    if (profitPct <= floorPct) {
      const r = [
        `profit ${profitPct.toFixed(2)}% dropped to trailing floor ${floorPct.toFixed(2)}% (peak ${input.peakProfitPct.toFixed(2)}% - ${env.TAKE_PROFIT_GIVEBACK_PCT}pp giveback)`,
      ];
      logger.info('[riskManager] TAKE_PROFIT', { reasons: r });
      return { decision: 'TAKE_PROFIT', reasons: r };
    }
  }

  const rebalanceThresholdUsd = input.estimatedGasCostUsd * env.FEE_GAS_MULTIPLIER;
  if (input.unclaimedFeesUsd > rebalanceThresholdUsd) {
    const r = [`unclaimed fees $${input.unclaimedFeesUsd.toFixed(2)} > threshold $${rebalanceThresholdUsd.toFixed(2)} (gas * ${env.FEE_GAS_MULTIPLIER})`];
    logger.info('[riskManager] REBALANCE', { reasons: r });
    return { decision: 'REBALANCE', reasons: r };
  }

  // Idle-forced rebalance: out-of-range means the position stopped earning
  // new fees, so the fee-threshold check above can stall forever waiting on
  // fees that no longer accrue. Capital shouldn't just sit there once it's
  // been out of range "too long" — force a compound cycle regardless of
  // profit/loss (loss already would have HARD_EXIT'd above at STOP_LOSS_PCT,
  // so anything reaching here is an acceptable loss to crystallize in
  // exchange for redeploying idle capital). compoundCycle re-checks whether
  // this pool still qualifies for re-entry or whether capital should go find
  // a different one instead (decided by rebalanceEngine/paperTrade, not here).
  if (input.isOutOfRange && input.outOfRangeSinceMs !== undefined && input.outOfRangeSinceMs !== null) {
    const idleMinutes = (now - input.outOfRangeSinceMs) / 60_000;
    if (idleMinutes >= env.MAX_IDLE_OUT_OF_RANGE_MINUTES) {
      const r = [`out of range idle ${idleMinutes.toFixed(1)}min — forcing rebalance instead of sitting idle`];
      logger.info('[riskManager] REBALANCE (idle-forced)', { reasons: r });
      return { decision: 'REBALANCE', reasons: r };
    }
  }

  return { decision: 'HOLD', reasons: [] };
}

export interface SwitchEvaluationInput {
  /** Currently-held position's unrealized profit %, same sign convention as evaluatePosition (positive = profit). */
  currentProfitPct: number;
  currentSpikeRatio: number;
  candidateSpikeRatio: number;
  /** False if scanForBetterOpportunity found no distinct qualifying candidate this scan. */
  hasCandidate: boolean;
  /** Epoch ms of the last switch, or null if none has happened yet this run. */
  lastSwitchAtMs: number | null;
}

export interface SwitchEvaluation {
  shouldSwitch: boolean;
  reason: string;
}

/**
 * Pure decision function for the opportunistic pool-switching feature -
 * mirrors evaluatePosition's shape (no I/O, caller already did the scan).
 * Checked only at the caller's own OPPORTUNITY_SCAN_INTERVAL_MS cadence,
 * not every tick.
 */
export function evaluateSwitchOpportunity(input: SwitchEvaluationInput, now = Date.now()): SwitchEvaluation {
  if (!input.hasCandidate) {
    return { shouldSwitch: false, reason: 'no qualifying candidate found this scan' };
  }
  if (input.currentProfitPct >= env.SWITCH_PROFIT_GUARD_PCT) {
    return {
      shouldSwitch: false,
      reason: `current profit ${input.currentProfitPct.toFixed(2)}% >= SWITCH_PROFIT_GUARD_PCT ${env.SWITCH_PROFIT_GUARD_PCT}% - protecting winner`,
    };
  }
  if (input.lastSwitchAtMs !== null && now - input.lastSwitchAtMs < env.SWITCH_COOLDOWN_MS) {
    const remainingMin = ((env.SWITCH_COOLDOWN_MS - (now - input.lastSwitchAtMs)) / 60_000).toFixed(1);
    return { shouldSwitch: false, reason: `switch cooldown active, ${remainingMin}min remaining` };
  }
  const requiredRatio = input.currentSpikeRatio * env.SWITCH_SPIKE_RATIO_MARGIN;
  if (input.candidateSpikeRatio >= requiredRatio) {
    return {
      shouldSwitch: true,
      reason: `candidate spike ${input.candidateSpikeRatio.toFixed(2)}x >= current ${input.currentSpikeRatio.toFixed(2)}x * margin ${env.SWITCH_SPIKE_RATIO_MARGIN} (required ${requiredRatio.toFixed(2)}x)`,
    };
  }
  return {
    shouldSwitch: false,
    reason: `candidate spike ${input.candidateSpikeRatio.toFixed(2)}x < required ${requiredRatio.toFixed(2)}x`,
  };
}

// ── Blacklist manager ───────────────────────────────────────────────────

export function addToBlacklist(blacklistPools: Map<string, number>, poolAddress: string, now = Date.now()): void {
  const until = now + env.BLACKLIST_DURATION_MS;
  blacklistPools.set(poolAddress, until);
  logger.warn(`[riskManager] blacklisted pool ${poolAddress} until ${new Date(until).toISOString()}`);
}
