import { env } from './config/env.js';
import { getWalletPubkey, getWalletSolBalance, getTokenBalance } from './services/solana.js';
import { scanPools, defaultScannerConfig, getVolume1hUsd, scanForBetterOpportunity, volumeSpikeRatio, getSolPriceUsd, missingEntryData } from './services/meteoraScanner.js';
import { openPool, getUserPositions } from './services/meteoraDLMM.js';
import {
  openInitialPosition,
  compoundCycle,
  executeHardExit,
  executeCleanExit,
  getPositionHealthSnapshot,
  getBinRangeStatus,
  updateOutOfRangeTracking,
  isCooldownActive,
  estimateCycleGasCostSol,
  computeGasReserveSol,
  retryPendingSwapBack,
  getPendingSwapBack,
  restorePendingSwapBack,
  POSITION_RENT_BUFFER_SOL,
  type PoolContext,
} from './logic/rebalanceEngine.js';
import { evaluatePosition, evaluateSwitchOpportunity, addToBlacklist } from './logic/riskManager.js';
import { WSOL_MINT, emergencySwapAllToSol } from './services/jupiterSwap.js';
import { getDollarVolumeBuyRatio } from './services/flowAnalysis.js';
import { isDollarFlowBreachConfirmed } from './logic/dollarFlowExit.js';
import { getEntryPriceContext, getDrawdownFromHighPct } from './services/candleContext.js';
import { shouldExitOnUpsideBreak } from './logic/upsideBreak.js';
import { recoverOnBoot } from './logic/bootRecovery.js';
import { positionToPersisted } from './logic/rebalanceEngine.js';
import { saveState, pruneExpired, STATE_VERSION } from './services/stateStore.js';
import { logger } from './utils/logger.js';

const LOOP_INTERVAL_MS = 15_000; // position health check cadence (faster than pool scan cadence)

const blacklistPools = new Map<string, number>();
const chaseGuardPools = new Map<string, number>(); // see ScannerConfig.chaseGuardPools (meteoraScanner.ts)
// Optional comma-separated pool addresses to blacklist at boot (in-memory state is lost on restart; e.g. keep a just-closed pool out).
for (const addr of (process.env.BOOT_BLACKLIST_POOLS ?? '').split(',').map((a) => a.trim()).filter(Boolean)) {
  blacklistPools.set(addr, Date.now() + env.BLACKLIST_DURATION_MS);
}
let currentPool: PoolContext | null = null;
// Non-SOL mint of the last pool we entered; used by the flat kill-switch to liquidate leftovers.
let lastOtherMint: string | null = null;
let currentCapitalSol = env.INITIAL_LP_CAPITAL_SOL;
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;
let lastDollarFlowCheckAtMs = 0;
let dollarFlowBreach: { pool: string; count: number; sinceMs?: number } = { pool: '', count: 0 };
// true while an irreversible multi-step operation (close/rebalance/entry) runs; persisted so a restart can tell an interrupted op from a clean state.
let inFlight = false;

/** Writes the bookkeeping the chain can't provide (see services/stateStore.ts). Best-effort, never throws. */
function persist(): void {
  saveState({
    version: STATE_VERSION,
    savedAtMs: Date.now(),
    wallet: getWalletPubkey().toBase58(),
    position: currentPool ? positionToPersisted(currentPool) : null,
    inFlight,
    currentCapitalSol,
    lastOtherMint,
    lastSwitchAtMs,
    blacklist: [...blacklistPools.entries()],
    chaseGuard: [...chaseGuardPools.entries()],
    dollarFlowBreach,
    pendingSwapBack: getPendingSwapBack(),
  });
}

/** Marks the state "in flight" (written BEFORE the op) around an irreversible step; cleared by the persist() that follows. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  inFlight = true;
  persist();
  try {
    return await fn();
  } finally {
    inFlight = false;
  }
}

/**
 * Found live 2026-10-07/08 (twice, via two different call sites): every
 * close-then-followup function (executeHardExit, executeCleanExit,
 * compoundCycle) does an irreversible on-chain closePositionFull as its
 * FIRST action, then does further steps (swap leftover token, reopen at a
 * new range) that can ALSO throw. index.ts had no try/catch around any of
 * these calls, so a throw left `currentPool` stale — still pointing at a
 * position that may or may not actually exist on-chain anymore. The next
 * tick's health check would then read a closed position's balance as 0 and
 * misread it as a 100% loss, looping HARD_EXIT/blacklist/retry for minutes
 * before a lucky retry resynced things by accident. Patching each specific
 * failure point as it's discovered (done twice already) only covers the
 * exact failure modes already seen live, not the general case. Root fix:
 * on ANY throw from one of these calls, re-check ground truth via
 * getUserPositions instead of guessing — if no position exists anymore,
 * the close succeeded despite the later failure, so clear state and
 * recompute capital from the real wallet balance; if a position IS still
 * there, the close itself never happened, so keep tracking it and let the
 * next tick's normal health check resume (don't treat an untouched,
 * still-open position as abandoned).
 */
async function reconcilePoolStateAfterFailure(ctx: PoolContext): Promise<PoolContext | null> {
  const positions = await getUserPositions(ctx.pool);
  if (positions.length === 0) {
    logger.warn('[index] confirmed position closed on-chain despite a failed follow-up step — clearing stale state', {
      pool: ctx.poolAddress,
    });
    const solBalance = await getWalletSolBalance();
    currentCapitalSol = Math.max(solBalance - computeGasReserveSol(solBalance), 0);
    return null;
  }
  logger.warn('[index] position still open on-chain after a failed call — keeping state, will retry next tick', {
    pool: ctx.poolAddress,
  });
  return ctx;
}

async function tryEnterPool(): Promise<void> {
  // A failed exit swap-back must land before any new entry, or the entry funds only part of the capital.
  try {
    await retryPendingSwapBack();
  } catch (err) {
    logger.error('[index] pending swap-back still failing — holding off new entries', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (env.MIN_EQUITY_STOP_SOL > 0) {
    let equitySol = await getWalletSolBalance();
    if (equitySol < env.MIN_EQUITY_STOP_SOL && lastOtherMint) {
      // SOL-only equity undercounts a token left behind by a failed close/reopen (BATON, 2026-10-09:
      // 0.635 read vs ~1.18 real). Liquidate it first, then re-read before deciding to stop.
      try {
        const stuck = await getTokenBalance(lastOtherMint);
        if (stuck.gtn(0)) {
          logger.warn('[index] equity below stop with a leftover token — swapping to SOL before deciding', { mint: lastOtherMint, equitySol });
          await emergencySwapAllToSol(lastOtherMint, stuck);
          equitySol = await getWalletSolBalance();
        }
      } catch (err) {
        logger.error('[index] leftover-token liquidation failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (equitySol < env.MIN_EQUITY_STOP_SOL) {
      logger.error('[index] equity below MIN_EQUITY_STOP_SOL while flat — stopping, no new entries', { equitySol, stopAt: env.MIN_EQUITY_STOP_SOL });
      process.exit(0);
    }
  }
  // Heal a stale capital figure (swap still pending when it was computed, 2026-10-11: 0.143 vs ~0.95 fundable).
  const walletNow = await getWalletSolBalance();
  const fundableSol = Math.max(walletNow - computeGasReserveSol(walletNow) - POSITION_RENT_BUFFER_SOL, 0);
  // Flat here, so capital should equal what the wallet can fund: refresh at <90% (CRAWL exit left 0.556 vs ~0.98 on 2026-10-12, above the 50% hard guard).
  if (fundableSol > 0 && currentCapitalSol < fundableSol * 0.9) {
    logger.warn('[index] capital figure stale vs wallet — refreshing', { was: currentCapitalSol, fundableSol });
    currentCapitalSol = Math.max(walletNow - computeGasReserveSol(walletNow), 0);
  }
  const candidates = await scanPools(defaultScannerConfig(blacklistPools, chaseGuardPools), currentCapitalSol);
  for (const candidate of candidates) {
    const xIsSol = candidate.mint_x === WSOL_MINT;
    const yIsSol = candidate.mint_y === WSOL_MINT;
    if (!xIsSol && !yIsSol) {
      // ponytail: engine only prices in SOL terms — skip non-SOL-quoted pools.
      continue;
    }

    // Dollar-volume-weighted buy/sell check (flowAnalysis.ts) — a genuinely
    // different signal from buyRatio1h (tx-count ratio, already checked
    // inside scanPools/filterAndRankPools). Deliberately only checked here,
    // for the single top candidate about to actually be entered — NOT
    // folded into the broad scan/rank step, which would mean real RPC calls
    // for every one of ~200 scanned pools every tick (this session already
    // hit multiple RPC 429-storms from unscoped per-pool work). A null
    // result (RPC hiccup, thin sample) now BLOCKS the entry (fail-closed,
    // 2026-10-08) — see missingEntryData for the same policy on the rest.
    const solPriceUsd = xIsSol ? candidate.tokenX.priceUsd : candidate.tokenY.priceUsd;
    const reserveSolAccount = xIsSol ? candidate.reserve_x : candidate.reserve_y;
    const missing = missingEntryData(candidate);
    if (missing.length > 0) {
      logger.warn(`[index] skipping pool ${candidate.address} — entry data incomplete (fail-closed)`, { missing });
      continue;
    }
    if (env.MAX_DRAWDOWN_FROM_HIGH_PCT > 0) {
      const drawdownPct = await getDrawdownFromHighPct(candidate.address, env.DRAWDOWN_WINDOW_DAYS);
      if (drawdownPct === null) {
        logger.warn(`[index] skipping pool ${candidate.address} — drawdown-from-high unavailable (fail-closed)`);
        continue;
      }
      if (drawdownPct < -env.MAX_DRAWDOWN_FROM_HIGH_PCT) {
        logger.info(`[index] skipping pool ${candidate.address} — ${drawdownPct}% below its ${env.DRAWDOWN_WINDOW_DAYS}d high (max ${env.MAX_DRAWDOWN_FROM_HIGH_PCT}%)`);
        continue;
      }
    }
    const dollarFlow = await getDollarVolumeBuyRatio(reserveSolAccount, solPriceUsd);
    if (dollarFlow === null) {
      logger.warn(`[index] skipping pool ${candidate.address} — dollar-flow check failed/insufficient sample (fail-closed)`);
      continue;
    }
    if (dollarFlow.buyRatioUsd < env.MIN_DOLLAR_BUY_RATIO) {
      logger.info(`[index] skipping pool ${candidate.address} — $ volume sell-dominant`, {
        buyRatioUsd: +dollarFlow.buyRatioUsd.toFixed(3),
        buyVolumeUsd: +dollarFlow.buyVolumeUsd.toFixed(2),
        sellVolumeUsd: +dollarFlow.sellVolumeUsd.toFixed(2),
        txSampled: dollarFlow.txSampled,
      });
      continue;
    }

    const priceContext = await getEntryPriceContext(candidate.address); // observability only, never gates entry
    try {
      const pool = await openPool(candidate.address);
      lastOtherMint = xIsSol ? candidate.mint_y : candidate.mint_x;
      currentPool = await guarded(() =>
        openInitialPosition(
          pool,
          candidate.address,
          candidate.mint_x,
          candidate.mint_y,
          xIsSol,
          currentCapitalSol,
          candidate.bin_step,
          xIsSol ? candidate.reserve_x : candidate.reserve_y,
        ),
      );
      currentPool.volume1hBaselineUsd = (await getVolume1hUsd(xIsSol ? candidate.mint_y : candidate.mint_x)) ?? 0;
      currentPool.volume1hBaselineSetAtMs = Date.now();
      // Decision-context snapshot (2026-09-24) — same reasoning as
      // paperTrade.ts's ENTER event: without this, after-the-fact "was this
      // entry chasing an already-extended pump?" analysis has to guess.
      logger.info(`[index] entered pool ${candidate.address}`, {
        capitalSol: currentCapitalSol,
        priceChange1hPct: candidate.priceChange1hPct ?? null,
        priceChange6hPct: candidate.priceChange6hPct ?? null,
        priceChange24hPct: candidate.priceChange24hPct ?? null,
        volumeSpikeRatio: +volumeSpikeRatio(candidate).toFixed(3),
        buyRatio1h: candidate.buyRatio1h ?? null,
        priceContext,
        feeYield: { r24h: candidate.feeTvlRatio24h, r4hx6: candidate.feeTvlRatio4h == null ? null : +(candidate.feeTvlRatio4h * 6).toFixed(3) },
        dollarFlow: { buyRatioUsd: +dollarFlow.buyRatioUsd.toFixed(3), txSampled: dollarFlow.txSampled },
      });
      return;
    } catch (err) {
      logger.error(`[index] failed to enter pool ${candidate.address}, trying next candidate`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!currentPool) logger.info('[index] no eligible pool found this scan');
}

async function tick(): Promise<void> {
  if (!currentPool) {
    await tryEnterPool();
    return;
  }

  const ctx = currentPool;
  const now = Date.now();
  const [{ currentValueSol, unclaimedFeesSol, otherPrincipalSol }, volume1hNowUsd, binStatus] = await Promise.all([
    getPositionHealthSnapshot(ctx),
    getVolume1hUsd(ctx.xIsSol ? ctx.mintY : ctx.mintX),
    getBinRangeStatus(ctx),
  ]);
  updateOutOfRangeTracking(ctx, binStatus.isOutOfRange);

  // Option A (VOLUME_BASELINE_REFRESH_MS, default 0/disabled) — reuses the
  // volume1hNowUsd already fetched above, no extra API call. See env.ts
  // doc comment for the full rationale/trade-off.
  if (env.VOLUME_BASELINE_REFRESH_MS > 0 && now - ctx.volume1hBaselineSetAtMs >= env.VOLUME_BASELINE_REFRESH_MS && volume1hNowUsd !== null) {
    ctx.volume1hBaselineUsd = volume1hNowUsd;
    ctx.volume1hBaselineSetAtMs = now;
  }

  const currentProfitPct = ctx.initialDepositSol > 0 ? ((currentValueSol - ctx.initialDepositSol) / ctx.initialDepositSol) * 100 : 0;
  ctx.peakProfitPct = Math.max(ctx.peakProfitPct, currentProfitPct);

  const gasCostSol = estimateCycleGasCostSol(ctx.initialDepositSol);
  const { decision, reasons } = evaluatePosition({
    initialDepositUsd: ctx.initialDepositSol,
    currentValueUsd: currentValueSol,
    rebalanceTimestamps: ctx.rebalanceTimestamps,
    volume1hNowUsd: volume1hNowUsd ?? ctx.volume1hBaselineUsd,
    volume1hBaselineUsd: ctx.volume1hBaselineUsd,
    volume1hBaselineSetAtMs: ctx.volume1hBaselineSetAtMs,
    unclaimedFeesUsd: unclaimedFeesSol,
    estimatedGasCostUsd: gasCostSol,
    isOutOfRange: binStatus.isOutOfRange,
    outOfRangeSinceMs: ctx.outOfRangeSinceMs,
    peakProfitPct: ctx.peakProfitPct,
  }, now);

  logger.info(`[index] pool ${ctx.poolAddress} health check`, {
    decision,
    reasons,
    currentValueSol,
    unclaimedFeesSol,
    isOutOfRange: binStatus.isOutOfRange,
    currentBinId: binStatus.currentBinId,
  });

  if (decision !== 'HARD_EXIT' && shouldExitOnUpsideBreak({
    exitAfterMin: env.UPSIDE_BREAK_EXIT_MIN,
    isOutOfRange: binStatus.isOutOfRange,
    outOfRangeSinceMs: ctx.outOfRangeSinceMs,
    nowMs: now,
    tokenValueSol: otherPrincipalSol,
    totalValueSol: currentValueSol,
  })) {
    logger.warn('[index] upside break: position is all SOL and out of range — exiting instead of re-buying higher', { pool: ctx.poolAddress, currentValueSol, unclaimedFeesSol });
    try {
      currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools));
      currentPool = null;
    } catch (err) {
      logger.error('[index] executeCleanExit (upside break) threw, reconciling state', {
        pool: ctx.poolAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      currentPool = await reconcilePoolStateAfterFailure(ctx);
    }
    return;
  }

  if (decision === 'HARD_EXIT') {
    try {
      currentCapitalSol = await guarded(() => executeHardExit(ctx, blacklistPools, chaseGuardPools));
      currentPool = null;
    } catch (err) {
      logger.error('[index] executeHardExit threw, reconciling state', {
        pool: ctx.poolAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      currentPool = await reconcilePoolStateAfterFailure(ctx);
    }
    return;
  }

  if (decision === 'TAKE_PROFIT') {
    try {
      currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools));
      currentPool = null;
    } catch (err) {
      logger.error('[index] executeCleanExit (TAKE_PROFIT) threw, reconciling state', {
        pool: ctx.poolAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      currentPool = await reconcilePoolStateAfterFailure(ctx);
    }
    return;
  }

  if (decision === 'REBALANCE') {
    if (!env.ENABLE_AUTO_COMPOUND) {
      logger.info('[index] rebalance triggered but ENABLE_AUTO_COMPOUND=false, holding');
      return;
    }
    if (isCooldownActive(ctx)) {
      logger.info('[index] rebalance triggered but still in cooldown, holding');
      return;
    }
    // REBALANCE only ever fires idle-forced (out-of-range) now — see
    // riskManager.ts's 2026-09-26 removal note. compoundCycle re-checks
    // whether this pool still passes the entry screen: null means it
    // doesn't (capital converted to SOL, no reopen) — next tick's
    // tryEnterPool() picks up from there.
    try {
      currentPool = await guarded(() => compoundCycle(ctx, defaultScannerConfig(blacklistPools, chaseGuardPools), currentProfitPct));
      if (!currentPool) {
        const solBalance = await getWalletSolBalance();
        currentCapitalSol = Math.max(solBalance - computeGasReserveSol(solBalance), 0);
      }
    } catch (err) {
      logger.error('[index] compoundCycle threw, reconciling state', {
        pool: ctx.poolAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      currentPool = await reconcilePoolStateAfterFailure(ctx);
    }
    return;
  }

  // Dollar-volume-weighted sell-pressure check (flowAnalysis.ts) — runs
  // for the held position regardless of ENTRY_STRATEGY_MODE (unlike the
  // momentum-only switch check below, whale-dump detection is a general
  // risk signal, not a mode-specific thesis). Reuses OPPORTUNITY_SCAN_INTERVAL_MS
  // as a cheap, already-existing cadence rather than inventing a new env
  // var. A null result (RPC hiccup, no sampled activity) is unknown — don't
  // act on it, same permissive policy as the rest of the screen.
  if (now - lastDollarFlowCheckAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
    lastDollarFlowCheckAtMs = now;
    const solPriceUsd = await getSolPriceUsd(ctx.poolAddress);
    if (solPriceUsd !== null) {
      const dollarFlow = await getDollarVolumeBuyRatio(ctx.reserveSolAccount, solPriceUsd);
      // Only a QUALIFIED read (enough samples + $ volume) counts; thin reads are ignored
      // (neither confirm nor clear). Exit needs N consecutive qualified breaches.
      if (dollarFlowBreach.pool !== ctx.poolAddress) dollarFlowBreach = { pool: ctx.poolAddress, count: 0 };
      let confirmedBreach = false;
      if (
        dollarFlow !== null &&
        dollarFlow.txSampled >= env.DOLLAR_FLOW_EXIT_MIN_SAMPLES &&
        dollarFlow.buyVolumeUsd + dollarFlow.sellVolumeUsd >= env.DOLLAR_FLOW_EXIT_MIN_VOLUME_USD
      ) {
        if (dollarFlow.buyRatioUsd < env.DOLLAR_FLOW_EXIT_MIN_RATIO) {
          if (dollarFlowBreach.count === 0 || dollarFlowBreach.sinceMs === undefined) dollarFlowBreach.sinceMs = now;
          dollarFlowBreach.count += 1;
          // Overlapping 1h windows make back-to-back reads one signal counted twice: also require the breach to span DOLLAR_FLOW_EXIT_CONFIRM_MIN minutes (2026-10-13, QI exit at -1% cost 1.2% swap friction).
          confirmedBreach = isDollarFlowBreachConfirmed(dollarFlowBreach.count, dollarFlowBreach.sinceMs, now, env.DOLLAR_FLOW_EXIT_CONFIRMATIONS, env.DOLLAR_FLOW_EXIT_CONFIRM_MIN);
          if (!confirmedBreach) {
            logger.warn(`[index] pool ${ctx.poolAddress} $ sell-dominant, awaiting confirmation`, {
              buyRatioUsd: +dollarFlow.buyRatioUsd.toFixed(3),
              txSampled: dollarFlow.txSampled,
              breach: dollarFlowBreach.count,
            });
          }
        } else {
          dollarFlowBreach.count = 0;
          delete dollarFlowBreach.sinceMs;
        }
      }
      if (dollarFlow !== null && confirmedBreach) {
        logger.warn(`[index] pool ${ctx.poolAddress} $ volume sell-dominant — leaving`, {
          buyRatioUsd: +dollarFlow.buyRatioUsd.toFixed(3),
          buyVolumeUsd: +dollarFlow.buyVolumeUsd.toFixed(2),
          sellVolumeUsd: +dollarFlow.sellVolumeUsd.toFixed(2),
          txSampled: dollarFlow.txSampled,
        });
        try {
          currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools));
          // Short cooldown, not the long HARD_EXIT blacklist — same
          // reasoning as compoundCycle's "no longer eligible" abandon path:
          // this isn't a stop-loss/risk violation on the position itself,
          // just a signal to leave for now. executeCleanExit itself never
          // blacklists (by design, see its doc comment), so do it here.
          addToBlacklist(blacklistPools, ctx.poolAddress, now, env.LEFT_POOL_COOLDOWN_MS);
          currentPool = null;
        } catch (err) {
          logger.error('[index] executeCleanExit (sell-pressure) threw, reconciling state', {
            pool: ctx.poolAddress,
            error: err instanceof Error ? err.message : String(err),
          });
          currentPool = await reconcilePoolStateAfterFailure(ctx);
        }
        return;
      }
    }
  }

  // Opportunistic switching is a momentum-only concept (spike-ratio chasing)
  // — trend/range positions are deliberately held per their own thesis
  // (trend: ride a sustained move; range: hold through volatility unless the
  // ceiling itself breaks, see rangeCeilingProfitOverride). paperTrade.ts
  // already gates this correctly; index.ts (the real bot) never got the same
  // gate — found live 2026-10-07 when a range-mode position SWITCHED on a
  // pure spike-ratio signal that has nothing to do with range's thesis.
  if (env.ENTRY_STRATEGY_MODE === 'momentum' && now - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
    lastOpportunityScanAtMs = now;
    // currentValueSol, not ctx.initialDepositSol — a SWITCH moves whatever
    // the position is actually worth right now, not the original deposit.
    const scanResult = await scanForBetterOpportunity(ctx.poolAddress, defaultScannerConfig(blacklistPools, chaseGuardPools), currentValueSol);
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
    logger.info('[index] opportunity scan', {
      decision: switchEval.shouldSwitch ? 'SWITCH' : 'HOLD',
      reason: switchEval.reason,
      currentSpikeRatio: +scanResult.currentSpikeRatio.toFixed(3),
      candidateSpikeRatio: +scanResult.candidateSpikeRatio.toFixed(3),
      currentPriceTrendPct: scanResult.currentPriceTrendPct ?? null,
      candidateBuyRatio1h: scanResult.candidateBuyRatio1h ?? null,
    });
    if (switchEval.shouldSwitch && scanResult.candidate) {
      const candidate = scanResult.candidate;
      try {
        currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'SWITCH', chaseGuardPools));
      } catch (err) {
        logger.error('[index] executeCleanExit (SWITCH) threw, reconciling state', {
          pool: ctx.poolAddress,
          error: err instanceof Error ? err.message : String(err),
        });
        currentPool = await reconcilePoolStateAfterFailure(ctx);
        return;
      }
      const xIsSol = candidate.mint_x === WSOL_MINT;
      const yIsSol = candidate.mint_y === WSOL_MINT;
      if (xIsSol || yIsSol) {
        try {
          const newPool = await openPool(candidate.address);
          lastOtherMint = xIsSol ? candidate.mint_y : candidate.mint_x;
          currentPool = await guarded(() => openInitialPosition(newPool, candidate.address, candidate.mint_x, candidate.mint_y, xIsSol, currentCapitalSol, candidate.bin_step, xIsSol ? candidate.reserve_x : candidate.reserve_y));
          currentPool.volume1hBaselineUsd = (await getVolume1hUsd(xIsSol ? candidate.mint_y : candidate.mint_x)) ?? 0;
          currentPool.volume1hBaselineSetAtMs = Date.now();
          lastSwitchAtMs = now;
          logger.info('[index] SWITCH complete', { from: ctx.poolAddress, to: candidate.address });
        } catch (err) {
          logger.error('[index] SWITCH failed to open new position, capital left in SOL for next scan', {
            candidate: candidate.address,
            error: err instanceof Error ? err.message : String(err),
          });
          currentPool = null;
        }
      } else {
        // ponytail: engine only prices in SOL terms, same guard as tryEnterPool - shouldn't happen since filterAndRankPools already requires a SOL side via nonSolToken, but stay defensive.
        currentPool = null;
      }
      return;
    }
  }

  // HOLD — nothing to do.
}

async function main(): Promise<void> {
  logger.info('[index] booting meteora-dlmm-bot', { wallet: getWalletPubkey().toBase58() });

  // Reattach to an open position (or detect a clean/flat wallet) BEFORE the capital sufficiency check:
  // with a position open the liquid SOL balance is small by design, and the old check would refuse to boot.
  const recovery = await recoverOnBoot();
  const saved = recovery.state;
  if (recovery.plan.kind === 'ambiguous') {
    logger.error('[index] ambiguous boot: wallet holds open positions in several pools — refusing to trade, resolve manually', { pools: recovery.plan.pools });
    process.exit(1);
  }
  if (saved) {
    const now = Date.now();
    for (const [addr, until] of pruneExpired(saved.blacklist, now)) if (!blacklistPools.has(addr)) blacklistPools.set(addr, until);
    for (const [mint, px] of saved.chaseGuard) chaseGuardPools.set(mint, px);
    lastOtherMint = saved.lastOtherMint;
    lastSwitchAtMs = saved.lastSwitchAtMs;
    dollarFlowBreach = saved.dollarFlowBreach;
    restorePendingSwapBack(saved.pendingSwapBack ?? null);
  }
  if (recovery.ctx) {
    currentPool = recovery.ctx;
    lastOtherMint = recovery.ctx.xIsSol ? recovery.ctx.mintY : recovery.ctx.mintX;
    const snap = await getPositionHealthSnapshot(recovery.ctx);
    logger.warn(`[index] RESUMED open position ${recovery.ctx.poolAddress} from ${recovery.source}${recovery.source === 'chain' ? ' (deposit basis approximated from current value, peak profit reset)' : ''}`, {
      initialDepositSol: recovery.ctx.initialDepositSol,
      peakProfitPct: recovery.ctx.peakProfitPct,
      currentValueSol: snap.currentValueSol,
      unclaimedFeesSol: snap.unclaimedFeesSol,
      outOfRangeSinceMs: recovery.ctx.outOfRangeSinceMs,
      inFlightWhenSaved: saved?.inFlight ?? null,
    });
  } else {
    if (saved?.position) {
      logger.warn('[index] state file listed a position but none exists on-chain — treating as closed', { pool: saved.position.poolAddress });
    }
    if (saved?.inFlight && saved.lastOtherMint) {
      // The previous process died inside a close/rebalance/entry: a token leg may be stranded in the wallet.
      try {
        const stuck = await getTokenBalance(saved.lastOtherMint);
        if (stuck.gtn(0)) {
          logger.warn('[index] previous run was interrupted mid-operation — swapping leftover token to SOL', { mint: saved.lastOtherMint, amount: stuck.toString() });
          await emergencySwapAllToSol(saved.lastOtherMint, stuck);
        }
      } catch (err) {
        logger.error('[index] boot leftover-token liquidation failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const solBalance = await getWalletSolBalance();
    const gasReserveSol = computeGasReserveSol(solBalance);
    if (solBalance < env.INITIAL_LP_CAPITAL_SOL + gasReserveSol) {
      throw new Error(
        `[index] wallet balance ${solBalance} SOL is below required INITIAL_LP_CAPITAL_SOL(${env.INITIAL_LP_CAPITAL_SOL}) + gas reserve(${gasReserveSol})`,
      );
    }
  }
  inFlight = false;
  persist();

  logger.info(`[index] wallet balance: ${await getWalletSolBalance()} SOL, starting loop every ${LOOP_INTERVAL_MS}ms (${currentPool ? 'position resumed' : 'flat'})`);

  // ponytail: plain setInterval loop, no job scheduler — single always-on
  // process is the whole deployment target here. Reach for a scheduler
  // (BullMQ, cron) only if this needs to run across multiple workers.
  const runLoop = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      logger.error('[index] tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      persist();
      setTimeout(runLoop, LOOP_INTERVAL_MS);
    }
  };

  await runLoop();
}

process.on('unhandledRejection', (reason) => {
  logger.error('[index] unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('SIGINT', () => {
  logger.info('[index] SIGINT received, shutting down');
  persist();
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('[index] SIGTERM received, shutting down');
  persist();
  process.exit(0);
});

main().catch((err) => {
  logger.error('[index] fatal error, exiting', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
