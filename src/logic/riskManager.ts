import { env } from '../config/env.js';
import { TAKE_PROFIT_TIERS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export type RiskDecision = 'HOLD' | 'REBALANCE' | 'HARD_EXIT' | 'TAKE_PROFIT';

/**
 * Sticky-per-tier trailing floor — see TAKE_PROFIT_TIERS (constants.ts) for
 * the table and rationale. Returns null if peak hasn't armed yet (below the
 * first tier's armPct). Pure/exported so it's independently testable — see
 * checkTakeProfitTiers.ts.
 */
export function trailingTakeProfitFloorPct(peakProfitPct: number, tiers = TAKE_PROFIT_TIERS): number | null {
  if (tiers.length === 0 || peakProfitPct < tiers[0]!.armPct) return null;

  let floorPct = tiers[0]!.floorPct;
  for (const tier of tiers) {
    if (peakProfitPct >= tier.armPct) floorPct = tier.floorPct;
  }

  // Beyond the last tier, keep rolling using its own giveback delta instead
  // of freezing forever — never below the sticky floor above.
  const last = tiers[tiers.length - 1]!;
  if (peakProfitPct >= last.armPct) {
    const giveback = last.armPct - last.floorPct;
    floorPct = Math.max(floorPct, peakProfitPct - giveback);
  }

  return floorPct;
}

export interface PositionHealthInput {
  /** USD value of capital deposited when the position was FIRST opened — deliberately NOT updated on a compound/rebalance within the same pool (only a fresh entry or a SWITCH into a different pool resets this), so STOP_LOSS_PCT/TAKE_PROFIT track cumulative gain/loss since the original deposit, not since the last compound. Stale wording fixed 2026-09-24 — this docstring used to say "opened/last compounded", which didn't match either caller: index.ts always passes ctx.initialDepositSol (never reset on compound, see PoolContext's own doc comment), and paper-trade had a real bug where it WAS reset on compound (via position.capitalUsd) until this fix. */
  initialDepositUsd: number;
  /** Current USD value of principal + unclaimed fees in the position. */
  currentValueUsd: number;
  /** Epoch-ms timestamps of every rebalance done on this pool so far. */
  rebalanceTimestamps: number[];
  /** Pool's trailing 1h volume, now vs. when the position was opened. */
  volume1hNowUsd: number;
  volume1hBaselineUsd: number;
  /** Epoch-ms the baseline above was last set (fresh entry, switch, or an Option-A periodic refresh) — used to gate VOLUME_DROP_GRACE_MS (Option B). Undefined = no grace applied, same as the check always being active. */
  volume1hBaselineSetAtMs?: number;
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
  // Option B (VOLUME_DROP_GRACE_MS, default 0/disabled): a volume spike
  // decaying back toward normal in the hours right after entry isn't
  // necessarily a real problem — see env.ts doc comment. Confirmed live
  // twice (same pool, two instances, 31s apart) that this false-positives
  // a HARD_EXIT purely from expected spike decay.
  const withinVolumeDropGrace =
    env.VOLUME_DROP_GRACE_MS > 0 &&
    input.volume1hBaselineSetAtMs !== undefined &&
    now - input.volume1hBaselineSetAtMs < env.VOLUME_DROP_GRACE_MS;
  if (volDropPct > env.VOLUME_DROP_HARD_EXIT_PCT && !withinVolumeDropGrace) {
    reasons.push(`1h volume dropped ${volDropPct.toFixed(2)}% > ${env.VOLUME_DROP_HARD_EXIT_PCT}%`);
  }

  if (reasons.length) {
    logger.warn('[riskManager] HARD_EXIT', { reasons });
    return { decision: 'HARD_EXIT', reasons };
  }

  const floorPct = trailingTakeProfitFloorPct(input.peakProfitPct);
  if (floorPct !== null && profitPct <= floorPct) {
    const r = [
      `profit ${profitPct.toFixed(2)}% dropped to trailing floor ${floorPct.toFixed(2)}% (peak ${input.peakProfitPct.toFixed(2)}%, sticky tier — see TAKE_PROFIT_TIERS)`,
    ];
    logger.info('[riskManager] TAKE_PROFIT', { reasons: r });
    return { decision: 'TAKE_PROFIT', reasons: r };
  }

  // Removed 2026-09-26: a standalone fee-threshold REBALANCE (claim fees
  // without closing, while still in-range) used to fire here whenever
  // unclaimedFeesUsd cleared FEE_GAS_MULTIPLIER * gas cost. Traced through
  // both callers (rebalanceEngine.ts's claimFeesOnly / paperTrade.ts's
  // CLAIM_FEES branch) and confirmed it bought NOTHING: claiming mid-position
  // never reinvests into the LP (claimFeesOnly just sends fee tokens to the
  // wallet; real compounding only happens in compoundCycle's close+reopen,
  // which already re-reads the FULL wallet SOL balance at that point — so
  // any fee claimed earlier gets swept in anyway, just later). Meanwhile
  // every position-changing event (SWITCH, idle-forced REBALANCE reopen,
  // HARD_EXIT, TAKE_PROFIT) already folds accrued fees into its exit value
  // for free, no separate claim tx needed. Net effect of the old trigger:
  // pure extra gas cost for zero compounding benefit. Fees now only ever
  // get realized as a side effect of an already-necessary transaction.
  //
  // Idle-forced rebalance: out-of-range means the position stopped earning
  // new fees. Capital shouldn't just sit there once it's been out of range
  // "too long" — force a compound cycle regardless of profit/loss (loss
  // already would have HARD_EXIT'd above at STOP_LOSS_PCT, so anything
  // reaching here is an acceptable loss to crystallize in exchange for
  // redeploying idle capital). compoundCycle re-checks whether this pool
  // still qualifies for re-entry or whether capital should go find a
  // different one instead (decided by rebalanceEngine/paperTrade, not here).
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
  /** Currently-held pool's own 6h price trend, undefined if unhydrated. Protects a position that's still genuinely trending up even if its volume spike has cooled — a separate signal from currentProfitPct (personal PnL depends on entry timing; this is the pool's own price direction regardless of when we got in). */
  currentPriceTrendPct?: number;
  /** Candidate's 1h buy ratio (buys/(buys+sells)), undefined if DexScreener never returned tx-side data. A volume spike can be genuine buying pressure OR a sell-off/dump wearing the same $ number — this tells them apart. */
  candidateBuyRatio1h?: number;
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
  // Separate protection from the profit guard above: profit depends on entry
  // timing (a position can be genuinely trending up but only recently
  // entered, so profit% hasn't caught up yet), this looks at the pool's own
  // price direction directly. Confirmed live 2026-09-23: SI-SOL switched
  // away at only +11% unrealized profit (well under the 30% profit guard)
  // right as its own volume spike cooled to 0.56x — mcap kept climbing
  // 2M->6M+ for hours after the bot left. A still-strongly-trending pool
  // shouldn't get abandoned just because volume momentum dipped.
  if (input.currentPriceTrendPct !== undefined && input.currentPriceTrendPct >= env.SWITCH_TREND_PROTECT_PCT) {
    return {
      shouldSwitch: false,
      reason: `current pool 6h trend ${input.currentPriceTrendPct.toFixed(2)}% >= SWITCH_TREND_PROTECT_PCT ${env.SWITCH_TREND_PROTECT_PCT}% - still trending up, protecting position regardless of volume spike`,
    };
  }
  if (input.lastSwitchAtMs !== null && now - input.lastSwitchAtMs < env.SWITCH_COOLDOWN_MS) {
    const remainingMin = ((env.SWITCH_COOLDOWN_MS - (now - input.lastSwitchAtMs)) / 60_000).toFixed(1);
    return { shouldSwitch: false, reason: `switch cooldown active, ${remainingMin}min remaining` };
  }
  if (!(input.currentSpikeRatio > 0)) {
    return { shouldSwitch: false, reason: 'current pool spike ratio unknown or zero - no valid comparison, holding' };
  }
  // Absolute floor, not just relative margin: 1.0x means "running exactly at
  // its own recent 5h pace" (see volumeSpikeRatio) — no spike at all. Without
  // this, two dead-quiet pools (e.g. 0.26x vs 0.17x) can clear the relative
  // margin against each other despite neither genuinely spiking. Confirmed
  // live 2026-09-23: SWITCH SI-SOL -> SI-SOL (same pool!) fired on exactly
  // this — 0.26x "beat" 0.17x * 1.5 margin (required 0.26x) — burning a full
  // exit+re-entry gas cost for zero net position change.
  const SWITCH_CANDIDATE_MIN_ABSOLUTE_SPIKE_RATIO = 1.0;
  if (input.candidateSpikeRatio < SWITCH_CANDIDATE_MIN_ABSOLUTE_SPIKE_RATIO) {
    return {
      shouldSwitch: false,
      reason: `candidate spike ${input.candidateSpikeRatio.toFixed(2)}x below absolute floor ${SWITCH_CANDIDATE_MIN_ABSOLUTE_SPIKE_RATIO}x - not a genuine spike even if it beats current on margin`,
    };
  }
  // A $ volume spike is ambiguous on its own — it's the same number whether
  // it's genuine buying pressure or a dump/sell-off. Require buys to
  // actually dominate before trusting the spike as a switch-worthy signal.
  // Unknown (DexScreener never returned h1 tx-side data) doesn't block —
  // same "unknown, don't block" policy as the rest of the screen.
  const SWITCH_CANDIDATE_MIN_BUY_RATIO = 0.5;
  if (input.candidateBuyRatio1h !== undefined && input.candidateBuyRatio1h <= SWITCH_CANDIDATE_MIN_BUY_RATIO) {
    return {
      shouldSwitch: false,
      reason: `candidate 1h buy ratio ${(input.candidateBuyRatio1h * 100).toFixed(0)}% <= ${SWITCH_CANDIDATE_MIN_BUY_RATIO * 100}% - volume spike looks sell-dominant, not genuine buying pressure`,
    };
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
