import { env } from './config/env.js';
import { getWalletPubkey, getWalletSolBalance } from './services/solana.js';
import { scanPools, defaultScannerConfig, getVolume1hUsd, scanForBetterOpportunity, volumeSpikeRatio } from './services/meteoraScanner.js';
import { openPool } from './services/meteoraDLMM.js';
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
  type PoolContext,
} from './logic/rebalanceEngine.js';
import { evaluatePosition, evaluateSwitchOpportunity } from './logic/riskManager.js';
import { WSOL_MINT } from './services/jupiterSwap.js';
import { logger } from './utils/logger.js';

const LOOP_INTERVAL_MS = 15_000; // position health check cadence (faster than pool scan cadence)

const blacklistPools = new Map<string, number>();
const chaseGuardPools = new Map<string, number>(); // see ScannerConfig.chaseGuardPools (meteoraScanner.ts)
let currentPool: PoolContext | null = null;
let currentCapitalSol = env.INITIAL_LP_CAPITAL_SOL;
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;

async function tryEnterPool(): Promise<void> {
  const candidates = await scanPools(defaultScannerConfig(blacklistPools, chaseGuardPools), currentCapitalSol);
  for (const candidate of candidates) {
    const xIsSol = candidate.mint_x === WSOL_MINT;
    const yIsSol = candidate.mint_y === WSOL_MINT;
    if (!xIsSol && !yIsSol) {
      // ponytail: engine only prices in SOL terms — skip non-SOL-quoted pools.
      continue;
    }

    try {
      const pool = await openPool(candidate.address);
      currentPool = await openInitialPosition(
        pool,
        candidate.address,
        candidate.mint_x,
        candidate.mint_y,
        xIsSol,
        currentCapitalSol,
        candidate.bin_step,
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
  const [{ currentValueSol, unclaimedFeesSol }, volume1hNowUsd, binStatus] = await Promise.all([
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

  if (decision === 'HARD_EXIT') {
    currentCapitalSol = await executeHardExit(ctx, blacklistPools, chaseGuardPools);
    currentPool = null;
    return;
  }

  if (decision === 'TAKE_PROFIT') {
    currentCapitalSol = await executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools);
    currentPool = null;
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
    currentPool = await compoundCycle(ctx, defaultScannerConfig(blacklistPools, chaseGuardPools), currentProfitPct);
    if (!currentPool) currentCapitalSol = Math.max((await getWalletSolBalance()) - env.MIN_GAS_RESERVE_SOL, 0);
    return;
  }

  if (now - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
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
      currentCapitalSol = await executeCleanExit(ctx, 'SWITCH', chaseGuardPools);
      const xIsSol = candidate.mint_x === WSOL_MINT;
      const yIsSol = candidate.mint_y === WSOL_MINT;
      if (xIsSol || yIsSol) {
        try {
          const newPool = await openPool(candidate.address);
          currentPool = await openInitialPosition(newPool, candidate.address, candidate.mint_x, candidate.mint_y, xIsSol, currentCapitalSol, candidate.bin_step);
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

  const solBalance = await getWalletSolBalance();
  if (solBalance < env.INITIAL_LP_CAPITAL_SOL + env.MIN_GAS_RESERVE_SOL) {
    throw new Error(
      `[index] wallet balance ${solBalance} SOL is below required INITIAL_LP_CAPITAL_SOL(${env.INITIAL_LP_CAPITAL_SOL}) + MIN_GAS_RESERVE_SOL(${env.MIN_GAS_RESERVE_SOL})`,
    );
  }

  logger.info(`[index] wallet balance: ${solBalance} SOL, starting loop every ${LOOP_INTERVAL_MS}ms`);

  // ponytail: plain setInterval loop, no job scheduler — single always-on
  // process is the whole deployment target here. Reach for a scheduler
  // (BullMQ, cron) only if this needs to run across multiple workers.
  const runLoop = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      logger.error('[index] tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
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
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('[index] SIGTERM received, shutting down');
  process.exit(0);
});

main().catch((err) => {
  logger.error('[index] fatal error, exiting', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
