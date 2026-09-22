import { env } from './config/env.js';
import { getWalletPubkey, getWalletSolBalance } from './services/solana.js';
import { scanPools, defaultScannerConfig, getVolume1hUsd } from './services/meteoraScanner.js';
import { openPool } from './services/meteoraDLMM.js';
import {
  openInitialPosition,
  compoundCycle,
  executeHardExit,
  getPositionHealthSnapshot,
  getBinRangeStatus,
  updateOutOfRangeTracking,
  isCooldownActive,
  estimateCycleGasCostSol,
  type PoolContext,
} from './logic/rebalanceEngine.js';
import { evaluatePosition } from './logic/riskManager.js';
import { WSOL_MINT } from './services/jupiterSwap.js';
import { logger } from './utils/logger.js';

const LOOP_INTERVAL_MS = 15_000; // position health check cadence (faster than pool scan cadence)

const blacklistPools = new Map<string, number>();
let currentPool: PoolContext | null = null;
let currentCapitalSol = env.INITIAL_LP_CAPITAL_SOL;

async function tryEnterPool(): Promise<void> {
  const candidates = await scanPools(defaultScannerConfig(blacklistPools));
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
      );
      currentPool.volume1hBaselineUsd = (await getVolume1hUsd(xIsSol ? candidate.mint_y : candidate.mint_x)) ?? 0;
      logger.info(`[index] entered pool ${candidate.address}`, { capitalSol: currentCapitalSol });
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
  const [{ currentValueSol, unclaimedFeesSol }, volume1hNowUsd, binStatus] = await Promise.all([
    getPositionHealthSnapshot(ctx),
    getVolume1hUsd(ctx.xIsSol ? ctx.mintY : ctx.mintX),
    getBinRangeStatus(ctx),
  ]);
  updateOutOfRangeTracking(ctx, binStatus.isOutOfRange);

  const gasCostSol = estimateCycleGasCostSol(ctx.initialDepositSol);
  const { decision, reasons } = evaluatePosition({
    initialDepositUsd: ctx.initialDepositSol,
    currentValueUsd: currentValueSol,
    rebalanceTimestamps: ctx.rebalanceTimestamps,
    volume1hNowUsd: volume1hNowUsd ?? ctx.volume1hBaselineUsd,
    volume1hBaselineUsd: ctx.volume1hBaselineUsd,
    unclaimedFeesUsd: unclaimedFeesSol,
    estimatedGasCostUsd: gasCostSol,
    isOutOfRange: binStatus.isOutOfRange,
    outOfRangeSinceMs: ctx.outOfRangeSinceMs,
  });

  logger.info(`[index] pool ${ctx.poolAddress} health check`, {
    decision,
    reasons,
    currentValueSol,
    unclaimedFeesSol,
    isOutOfRange: binStatus.isOutOfRange,
    currentBinId: binStatus.currentBinId,
  });

  if (decision === 'HARD_EXIT') {
    currentCapitalSol = await executeHardExit(ctx, blacklistPools);
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
    // compoundCycle re-checks whether this pool still passes the entry
    // screen: null means it doesn't (capital converted to SOL, no
    // reopen) — next tick's tryEnterPool() picks up from there.
    currentPool = await compoundCycle(ctx, defaultScannerConfig(blacklistPools));
    if (!currentPool) currentCapitalSol = Math.max((await getWalletSolBalance()) - env.MIN_GAS_RESERVE_SOL, 0);
    return;
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
