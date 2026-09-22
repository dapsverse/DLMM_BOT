import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export type RiskDecision = 'HOLD' | 'REBALANCE' | 'HARD_EXIT';

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

  const rebalanceThresholdUsd = input.estimatedGasCostUsd * env.FEE_GAS_MULTIPLIER;
  if (input.unclaimedFeesUsd > rebalanceThresholdUsd) {
    const r = [`unclaimed fees $${input.unclaimedFeesUsd.toFixed(2)} > threshold $${rebalanceThresholdUsd.toFixed(2)} (gas * ${env.FEE_GAS_MULTIPLIER})`];
    logger.info('[riskManager] REBALANCE', { reasons: r });
    return { decision: 'REBALANCE', reasons: r };
  }

  return { decision: 'HOLD', reasons: [] };
}

// ── Blacklist manager ───────────────────────────────────────────────────

export function addToBlacklist(blacklistPools: Map<string, number>, poolAddress: string, now = Date.now()): void {
  const until = now + env.BLACKLIST_DURATION_MS;
  blacklistPools.set(poolAddress, until);
  logger.warn(`[riskManager] blacklisted pool ${poolAddress} until ${new Date(until).toISOString()}`);
}
