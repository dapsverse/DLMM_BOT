/**
 * Spot (buy → hold → sell) paper-trade executor — reuses the exact same
 * entry/exit/switch decision signals as the DLMM executor in
 * paperTrade.ts (rankCandidates/filterAndRankPools from meteoraScanner.ts,
 * evaluatePosition/evaluateSwitchOpportunity from riskManager.ts,
 * unchanged) but holds the token directly instead of opening an LP
 * position: no bin range, no rebalance, no IL, no LP fee income.
 *
 * Exists to A/B the LP wrapper itself against a straight spot strategy on
 * the SAME candidate/price basis — see paperTrade.ts's shared scan loop
 * for how a candidate picked once per tick is fed to both executors when
 * ENABLE_SPOT_EXECUTOR/ENABLE_LP_EXECUTOR are both on. Added 2026-09-25
 * after paper-trade data showed every running LP instance's
 * rebalance+entry/exit tx costs exceeding its fee income — see
 * env.ts's ENABLE_SPOT_EXECUTOR doc comment for the numbers.
 *
 * Because spot never rebalances/compounds in place, its decision space is
 * simpler than DLMM's: HARD_EXIT (stop-loss/volume-drop) / TAKE_PROFIT /
 * periodic re-screen (sell if the held token no longer passes the entry
 * screen, even with no replacement candidate yet — same intent as DLMM's
 * idle-out-of-range → LEAVE_POOL, but spot has no "out of range" concept,
 * so this rides the existing OPPORTUNITY_SCAN_INTERVAL_MS cadence instead
 * of its own timer) / SWITCH (opportunistic, same as DLMM) / HOLD.
 * REBALANCE is unreachable here: unclaimedFeesUsd is always 0 (no LP fees,
 * so the fee-threshold trigger never fires) and isOutOfRange is always
 * false (no bin range, so the idle-forced trigger never fires either).
 *
 * Mirrors paperTrade.ts's state/log file shape (paper-trade-state-<label>.json
 * + paper-trade-<label>-<ts>.jsonl) so paperTradeReport.ts picks it up with
 * zero changes — a position with no `bin` field just renders without a
 * range line.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  filterAndRankPools,
  defaultScannerConfig,
  nonSolToken,
  solToken,
  poolRejectReasons,
  scanForBetterOpportunity,
  volumeSpikeRatio,
  type MeteoraPair,
} from '../services/meteoraScanner.js';
import { evaluatePosition, evaluateSwitchOpportunity, addToBlacklist } from './riskManager.js';
import { estimateSpotSwapCostSol } from './costEstimate.js';
import { env } from '../config/env.js';

interface SpotPosition {
  poolAddress: string;
  poolName: string;
  tokenQty: number; // fixed at entry — spot never rebalances/compounds in place, so this never changes until exit
  initialDepositUsd: number; // == capital basis at entry; STOP_LOSS_PCT/TAKE_PROFIT/peakProfitPct track against this, mirrors DLMM's VirtualPosition.initialDepositUsd
  entrySolPriceUsd: number;
  entryMemePriceUsd: number;
  volume1hBaselineUsd: number;
  volume1hBaselineSetAtMs: number;
  peakProfitPct: number;
  /** Consecutive periodic re-screen failures (see tick()'s re-screen block) — requires 2 in a row before actually leaving, so one noisy 5m-window snapshot (tx count/activity are inherently jittery over 5min) doesn't force a sell. Resets to 0 on any pass. */
  rescreenFailStreak: number;
}

interface PoolVisit {
  pool: string;
  address: string;
  enteredAtMs: number;
  entryCapitalUsd: number;
  entryCapitalSol: number;
  exitedAtMs?: number;
  exitType?: 'HARD_EXIT' | 'LEFT_POOL' | 'TAKE_PROFIT' | 'SWITCHED';
  exitValueUsd?: number;
  exitValueSol?: number;
  exitReasons?: string[];
  rebalanceCount: number; // always 0 — kept only so paperTradeReport.ts's existing display code needs zero changes
}

interface RunSummary {
  label: string;
  startedAtMs: number;
  startingCapitalUsd: number | null;
  startingCapitalSol: number;
  poolsEntered: number;
  rebalances: number; // always 0
  hardExits: number;
  harvestedFeesUsd: number; // always 0 — no LP fees
  totalFeesEarnedUsd: number; // always 0
  poolHistory: PoolVisit[];
}

/**
 * Profit guard for the periodic re-screen-without-replacement path (see
 * tick()'s doc comment for the baton-SOL incident this fixes) — a currently
 * profitable position shouldn't get force-sold over an activity-metric
 * snapshot alone. Extracted as a pure function purely so it has an
 * independent self-check (tick() itself is fs/network-entangled).
 */
export function shouldForceLeaveOnFailedRescreen(currentProfitPct: number): boolean {
  return currentProfitPct <= 0;
}

/**
 * Idle capital (not currently in a position), in SOL, given a lazily-set
 * price/capital pair. Bug found live 2026-09-26: both spotExecutor's own
 * lastKnownSolPriceUsd/idleCapitalUsd AND paperTrade.ts's separate DLMM-side
 * copies are only ever set for real inside their respective enterPool() —
 * so before a process's first-ever entry they're still 0, and the naive
 * `priceUsd > 0 ? capitalUsd / priceUsd : undefined` used to silently pass
 * `undefined` as the capital/TVL ratio check's basis, skipping that
 * slippage-safety gate entirely for the first entry (confirmed live:
 * STEVEWILLDOIT-SOL entered at a 6.7% ratio, over the 5% ceiling).
 * lastKnownSolPriceUsd never resets back to 0 after the first entry, so
 * ===0 reliably means "still pristine, pre-first-entry" — the true idle
 * capital there IS exactly INITIAL_LP_CAPITAL_SOL, not an unknown. Pulled
 * into one shared function (spotExecutor.ts and paperTrade.ts each had
 * their own inline copy of this exact ternary) so the two can't drift out
 * of sync again — see checkSpotExecutor.ts for the self-check.
 */
export function resolveIdleCapitalSol(lastKnownSolPriceUsd: number, idleCapitalUsd: number): number {
  return lastKnownSolPriceUsd > 0 ? idleCapitalUsd / lastKnownSolPriceUsd : env.INITIAL_LP_CAPITAL_SOL;
}

export interface SpotExecutor {
  hasPosition(): boolean;
  /** Idle capital (not currently in a position), in SOL — falls back to INITIAL_LP_CAPITAL_SOL in the pristine pre-first-entry state (see the implementation's 2026-09-26 bug-fix comment). Used by paperTrade.ts to pick the capital/TVL ratio basis for the shared candidate scan. */
  idleCapitalSol(): number;
  tick(pairs: MeteoraPair[], now: number, sharedCandidate: MeteoraPair | null): Promise<void>;
  /** Flush and close this executor's own jsonl stream — call on process shutdown alongside the DLMM executor's. */
  close(): void;
}

export function createSpotExecutor(label: string, blacklist: Map<string, number>): SpotExecutor {
  let position: SpotPosition | null = null;
  let idleCapitalUsd = 0;
  let lastKnownSolPriceUsd = 0;
  let lastOpportunityScanAtMs = 0;
  let lastSwitchAtMs: number | null = null;

  const runStartedAtMs = Date.now();
  fs.mkdirSync(env.LOG_DIR, { recursive: true });
  const jsonlPath = path.join(env.LOG_DIR, `paper-trade-${label}-${runStartedAtMs}.jsonl`);
  const statePath = path.join(env.LOG_DIR, `paper-trade-state-${label}.json`);
  const logStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

  const summary: RunSummary = {
    label,
    startedAtMs: runStartedAtMs,
    startingCapitalUsd: null,
    startingCapitalSol: env.INITIAL_LP_CAPITAL_SOL,
    poolsEntered: 0,
    rebalances: 0,
    hardExits: 0,
    harvestedFeesUsd: 0,
    totalFeesEarnedUsd: 0,
    poolHistory: [],
  };

  function logEvent(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    logStream.write(line + '\n');
    console.log(line);
  }

  logEvent({
    type: 'SIM_START',
    label,
    initialLpCapitalSol: env.INITIAL_LP_CAPITAL_SOL,
    note: 'spot paper trading — buy/hold/sell, no LP position, no wallet, no real transactions',
  });

  function writeState(currentValueUsd: number): void {
    const elapsedMs = Date.now() - runStartedAtMs;
    const pnlUsd = summary.startingCapitalUsd === null ? 0 : currentValueUsd - summary.startingCapitalUsd;
    const pnlPct = summary.startingCapitalUsd ? (pnlUsd / summary.startingCapitalUsd) * 100 : 0;
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          ...summary,
          pid: process.pid,
          elapsedHours: +(elapsedMs / 3_600_000).toFixed(2),
          durationHours: Number(process.env.PAPER_TRADE_HOURS ?? 12),
          finished: false, // spot executor runs for the same process lifetime as the DLMM tick loop; paperTrade.ts's main() owns the actual duration check
          currentValueUsd: +currentValueUsd.toFixed(2),
          currentValueSol: lastKnownSolPriceUsd > 0 ? +(currentValueUsd / lastKnownSolPriceUsd).toFixed(4) : null,
          pnlUsd: +pnlUsd.toFixed(2),
          pnlPct: +pnlPct.toFixed(2),
          totalFeesEarnedSol: 0,
          currentPosition: position
            ? {
                pool: position.poolName,
                address: position.poolAddress,
                capitalUsd: +currentValueUsd.toFixed(2),
                capitalSol: lastKnownSolPriceUsd > 0 ? +(currentValueUsd / lastKnownSolPriceUsd).toFixed(4) : null,
                feesEarnedUsd: 0,
                // no `bin` field — paperTradeReport.ts skips the range line when absent
              }
            : null,
          jsonlLog: jsonlPath,
        },
        null,
        2,
      ),
    );
  }

  function enterPool(chosen: MeteoraPair): SpotPosition | null {
    const sol = solToken(chosen);
    const meme = nonSolToken(chosen);
    if (!sol || !meme) return null; // shouldn't happen post-screen, defensive

    if (summary.startingCapitalUsd === null) {
      idleCapitalUsd = env.INITIAL_LP_CAPITAL_SOL * sol.priceUsd;
      summary.startingCapitalUsd = idleCapitalUsd;
    }
    lastKnownSolPriceUsd = sol.priceUsd;

    const entryCostSol = estimateSpotSwapCostSol(idleCapitalUsd / sol.priceUsd);
    const entryCostUsd = entryCostSol * sol.priceUsd;
    const capitalAfterEntryCostUsd = Math.max(idleCapitalUsd - entryCostUsd, 0);
    const tokenQty = capitalAfterEntryCostUsd / meme.priceUsd;

    const now = Date.now();
    const entered: SpotPosition = {
      poolAddress: chosen.address,
      poolName: chosen.name,
      tokenQty,
      initialDepositUsd: capitalAfterEntryCostUsd,
      entrySolPriceUsd: sol.priceUsd,
      entryMemePriceUsd: meme.priceUsd,
      volume1hBaselineUsd: chosen.volume1hUsd,
      volume1hBaselineSetAtMs: now,
      peakProfitPct: 0,
      rescreenFailStreak: 0,
    };
    position = entered;
    summary.poolsEntered++;
    const capitalAfterEntryCostSol = capitalAfterEntryCostUsd / sol.priceUsd;
    summary.poolHistory.push({
      pool: chosen.name,
      address: chosen.address,
      enteredAtMs: now,
      entryCapitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
      entryCapitalSol: +capitalAfterEntryCostSol.toFixed(4),
      rebalanceCount: 0,
    });
    logEvent({
      type: 'ENTER',
      pool: chosen.name,
      address: chosen.address,
      capitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
      capitalSol: +capitalAfterEntryCostSol.toFixed(4),
      tokenQty,
      entryCostUsd: +entryCostUsd.toFixed(2),
      solPriceUsd: sol.priceUsd,
      memePriceUsd: meme.priceUsd,
      tvlUsd: Number(chosen.liquidity),
      vol24hUsd: chosen.trade_volume_24h,
      priceChange1hPct: chosen.priceChange1hPct ?? null,
      priceChange6hPct: chosen.priceChange6hPct ?? null,
      priceChange24hPct: chosen.priceChange24hPct ?? null,
      volumeSpikeRatio: +volumeSpikeRatio(chosen).toFixed(3),
      buyRatio1h: chosen.buyRatio1h ?? null,
    });
    return entered;
  }

  function exitPosition(
    reasonType: 'HARD_EXIT' | 'TAKE_PROFIT' | 'LEFT_POOL' | 'SWITCHED',
    reasons: string[],
    currentValueUsd: number,
    solPriceUsd: number,
    now: number,
  ): number {
    const costSol = estimateSpotSwapCostSol(currentValueUsd / solPriceUsd);
    const exitValueAfterCostUsd = Math.max(currentValueUsd - costSol * solPriceUsd, 0);
    const exitValueAfterCostSol = exitValueAfterCostUsd / solPriceUsd;
    logEvent({
      type: reasonType,
      pool: position!.poolName,
      reasons,
      finalValueUsd: +exitValueAfterCostUsd.toFixed(2),
      finalValueSol: +exitValueAfterCostSol.toFixed(4),
      exitCostUsd: +(costSol * solPriceUsd).toFixed(2),
    });
    if (reasonType === 'HARD_EXIT') {
      addToBlacklist(blacklist, position!.poolAddress, now);
      summary.hardExits++;
    }
    const visit = summary.poolHistory[summary.poolHistory.length - 1];
    if (visit) {
      visit.exitedAtMs = now;
      visit.exitType = reasonType;
      visit.exitValueUsd = +exitValueAfterCostUsd.toFixed(2);
      visit.exitValueSol = +exitValueAfterCostSol.toFixed(4);
      visit.exitReasons = reasons;
    }
    position = null;
    idleCapitalUsd = exitValueAfterCostUsd;
    return exitValueAfterCostUsd;
  }

  async function pickAndEnter(pairs: MeteoraPair[], sharedCandidate: MeteoraPair | null): Promise<void> {
    const anySol = pairs.map(solToken).find((t) => t !== null);
    if (anySol && lastKnownSolPriceUsd > 0) {
      idleCapitalUsd = (idleCapitalUsd / lastKnownSolPriceUsd) * anySol.priceUsd;
      lastKnownSolPriceUsd = anySol.priceUsd;
    }
    if (sharedCandidate) {
      enterPool(sharedCandidate);
    } else {
      logEvent({ type: 'NO_CANDIDATE', note: 'no pool passes screen this tick' });
    }
    writeState(position ? position.tokenQty * position.entryMemePriceUsd : idleCapitalUsd);
  }

  async function tick(pairs: MeteoraPair[], now: number, sharedCandidate: MeteoraPair | null): Promise<void> {
    if (!position) {
      await pickAndEnter(pairs, sharedCandidate);
      return;
    }

    const live = pairs.find((p) => p.address === position!.poolAddress);
    if (!live) {
      logEvent({ type: 'STALE_POOL', pool: position.poolName, note: 'dropped out of top-200 volume window; holding last known value' });
      writeState(position.tokenQty * position.entryMemePriceUsd);
      return;
    }

    const sol = solToken(live);
    const meme = nonSolToken(live);
    if (!sol || !meme) return; // defensive, shouldn't happen for a pool we entered
    lastKnownSolPriceUsd = sol.priceUsd;

    const currentValueUsd = position.tokenQty * meme.priceUsd; // pure mark-to-market, no IL
    const currentProfitPct = position.initialDepositUsd > 0 ? ((currentValueUsd - position.initialDepositUsd) / position.initialDepositUsd) * 100 : 0;
    position.peakProfitPct = Math.max(position.peakProfitPct, currentProfitPct);

    if (env.VOLUME_BASELINE_REFRESH_MS > 0 && now - position.volume1hBaselineSetAtMs >= env.VOLUME_BASELINE_REFRESH_MS) {
      position.volume1hBaselineUsd = live.volume1hUsd;
      position.volume1hBaselineSetAtMs = now;
    }

    const exitCostUsd = estimateSpotSwapCostSol(currentValueUsd / sol.priceUsd) * sol.priceUsd;
    const { decision, reasons } = evaluatePosition(
      {
        initialDepositUsd: position.initialDepositUsd,
        currentValueUsd,
        rebalanceTimestamps: [], // spot never rebalances — MAX_REBALANCE_PER_HOUR anti-thrash guard is a no-op here by construction
        volume1hNowUsd: live.volume1hUsd,
        volume1hBaselineUsd: position.volume1hBaselineUsd,
        volume1hBaselineSetAtMs: position.volume1hBaselineSetAtMs,
        unclaimedFeesUsd: 0, // no LP fees — the fee-threshold REBALANCE trigger can never fire
        estimatedGasCostUsd: exitCostUsd,
        isOutOfRange: false, // no bin range — the idle-forced REBALANCE trigger can never fire
        outOfRangeSinceMs: null,
        peakProfitPct: position.peakProfitPct,
      },
      now,
    );

    if (decision === 'HARD_EXIT' || decision === 'TAKE_PROFIT') {
      const value = exitPosition(decision, reasons, currentValueUsd, sol.priceUsd, now);
      writeState(value);
      return;
    }
    // REBALANCE is unreachable for spot (see file header) — anything else falls through to HOLD/opportunity-scan below.

    logEvent({
      type: 'HOLD',
      pool: position.poolName,
      currentValueUsd: +currentValueUsd.toFixed(2),
      priceChangeSinceEntryPct: +currentProfitPct.toFixed(2),
    });

    if (now - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
      lastOpportunityScanAtMs = now;

      // Periodic re-screen-without-replacement: spot has no "out of range"
      // signal to force this check on its own timer like DLMM's
      // idle-forced-rebalance does, so it rides this same cadence instead.
      // Same intent as DLMM's LEAVE_POOL: sell if the held token no longer
      // passes the entry screen, even with no better candidate lined up yet.
      // Requires 2 CONSECUTIVE failures (10min sustained) before acting —
      // confirmed live 2026-09-25/26: a single 5min-window snapshot check
      // (tx count / 5m activity are inherently jittery) whipsawed spot
      // instances into 14-25 entries/9h vs DLMM's 4-9 (DLMM's equivalent
      // trigger only fires after 10min of SUSTAINED out-of-range, not one
      // reading) — cost of the extra round-trips alone drove spot to
      // -40%..-70% vs DLMM's -31%..-43% on the SAME bad night, an
      // apples-to-oranges comparison, not a real LP-vs-spot signal.
      const reScreenOpts = { skipSizingChecks: true };
      const stillEligible = (await filterAndRankPools([live], defaultScannerConfig(blacklist), reScreenOpts)).length > 0;
      if (!stillEligible) {
        position.rescreenFailStreak++;
        if (position.rescreenFailStreak >= 2) {
          // Profit guard: unlike DLMM's LEAVE_POOL (only ever reachable
          // after price already left the bin range — itself a concrete
          // "this isn't working" signal), spot's re-screen runs on a blind
          // timer regardless of whether the position is actually winning.
          // Confirmed live 2026-09-26: trend-optAB-10sol-spot sold baton-SOL
          // at a real -2.3% loss on a transient "5m tx count 3 < min 20"
          // dip, right before its DLMM sibling (which never even re-screened
          // — price stayed in-range) rode the SAME pool to +3.89%. Don't
          // force out a currently-profitable position over an activity
          // metric alone — same "don't force-exit a held winner" philosophy
          // already applied to the entry-only sizing checks (FilterOpts).
          if (!shouldForceLeaveOnFailedRescreen(currentProfitPct)) {
            logEvent({
              type: 'HOLD',
              pool: position.poolName,
              note: `re-screen failed ${position.rescreenFailStreak}x but position is profitable (${currentProfitPct.toFixed(2)}%) — holding instead of forcing an exit`,
            });
          } else {
            const rejectReasons = poolRejectReasons(live, defaultScannerConfig(blacklist), reScreenOpts);
            const leaveReasons = ['pool no longer passes entry screen (2 consecutive checks) — leaving for a fresh scan instead of holding', ...rejectReasons];
            const value = exitPosition('LEFT_POOL', leaveReasons, currentValueUsd, sol.priceUsd, now);
            writeState(value);
            return;
          }
        } else {
          logEvent({ type: 'HOLD', pool: position.poolName, note: `re-screen failed (streak ${position.rescreenFailStreak}/2) — not leaving yet` });
        }
      } else {
        position.rescreenFailStreak = 0;
      }

      // Opportunistic switching is a momentum-mode concept (chase whatever's
      // spiking harder) — a 'trend' position isn't chasing acceleration, so
      // skip it entirely; the re-screen-without-replacement check above
      // already covers "is this still worth holding" for both modes.
      if (env.ENTRY_STRATEGY_MODE === 'momentum') {
        const scanResult = await scanForBetterOpportunity(position.poolAddress, defaultScannerConfig(blacklist), currentValueUsd / sol.priceUsd);
        const switchEval = evaluateSwitchOpportunity(
          {
            currentProfitPct,
            currentSpikeRatio: scanResult.currentSpikeRatio,
            candidateSpikeRatio: scanResult.candidateSpikeRatio,
            hasCandidate: scanResult.candidate !== null,
            lastSwitchAtMs,
            currentPriceTrendPct: scanResult.currentPriceTrendPct,
            candidateBuyRatio1h: scanResult.candidateBuyRatio1h,
          },
          now,
        );
        if (switchEval.shouldSwitch && scanResult.candidate) {
          const candidate = scanResult.candidate;
          logEvent({
            type: 'SWITCH',
            fromPool: position.poolName,
            toPool: candidate.name,
            reason: switchEval.reason,
            currentSpikeRatio: +scanResult.currentSpikeRatio.toFixed(3),
            candidateSpikeRatio: +scanResult.candidateSpikeRatio.toFixed(3),
          });
          exitPosition('SWITCHED', [switchEval.reason], currentValueUsd, sol.priceUsd, now);
          const entered = enterPool(candidate);
          if (entered) lastSwitchAtMs = now;
          writeState(entered ? entered.tokenQty * entered.entryMemePriceUsd : idleCapitalUsd);
          return;
        }
        logEvent({
          type: 'OPPORTUNITY_SCAN',
          pool: position.poolName,
          decision: 'HOLD',
          reason: switchEval.reason,
          currentSpikeRatio: +scanResult.currentSpikeRatio.toFixed(3),
          candidateSpikeRatio: +scanResult.candidateSpikeRatio.toFixed(3),
          candidate: scanResult.candidate?.name ?? null,
        });
      }
    }

    writeState(currentValueUsd);
  }

  return {
    hasPosition: () => position !== null,
    idleCapitalSol: () => resolveIdleCapitalSol(lastKnownSolPriceUsd, idleCapitalUsd),
    tick,
    close: () => logStream.end(),
  };
}
