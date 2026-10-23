import { env } from './config/env.js';
import { getWalletPubkey, getWalletSolBalance, getTokenBalance } from './services/solana.js';
import { nonSolToken, type MeteoraPair } from './services/meteoraScanner.js';
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
  walletCapitalSol,
  openLadderEntry,
  openTokenSpotEntry,
  executeFlip,
  getLastClose,
  retryPendingSwapBack,
  getPendingSwapBack,
  restorePendingSwapBack,
  processPendingLimitOrder,
  getPendingLimitOrder,
  restorePendingLimitOrder,
  executeDownBreakExit,
  POSITION_RENT_BUFFER_SOL,
  type PoolContext,
} from './logic/rebalanceEngine.js';
import { evaluatePosition, evaluateSwitchOpportunity, addToBlacklist } from './logic/riskManager.js';
import { WSOL_MINT, emergencySwapAllToSol } from './services/jupiterSwap.js';
import { getDollarVolumeBuyRatio, type DollarFlowResult } from './services/flowAnalysis.js';
import { aiScreen, aiManage } from './services/aiAgent.js';
import type { AiCandidate } from './logic/aiPrompts.js';
import { outcomeLine, priorFor } from './logic/aiMemory.js';
import { managerTrigger } from './logic/aiTriggers.js';
import { loadOutcomes, recordOutcome } from './services/aiOutcomes.js';
import type { TokenAudit } from './logic/tokenAudit.js';
import { getTransferFeeBps } from './services/tokenFee.js';
import { getTokenAudit } from './services/tokenAudit.js';
import { auditRejectReason } from './logic/tokenAudit.js';
import { isDollarFlowBreachConfirmed } from './logic/dollarFlowExit.js';
import { getEntryPriceContext, getDrawdownFromHighPct } from './services/candleContext.js';
import { shouldExitOnUpsideBreak } from './logic/upsideBreak.js';
import { meridianExitSignal, ExitConfirmer, getPoolFeeTvl24hPct, getPoolStats, oorWaitMinutes, trailingBlockedByFloor } from './logic/meridianExit.js';
import { ladderBounds } from './logic/ladderRange.js';
import { closeKindFromReason, cooldownHoursAfterClose, type CloseRec } from './logic/meridianCooldown.js';
import { recoverOnBoot } from './logic/bootRecovery.js';
import { positionToPersisted } from './logic/rebalanceEngine.js';
import { saveState, pruneExpired, STATE_VERSION } from './services/stateStore.js';
import { logger } from './utils/logger.js';
import { isTokenSide, strategyLabel, shouldFlip, pnlBasisSol, flipExitSignal, selectExitSignal, aiExitAllowed } from './logic/flip.js';
import { estimateExitCostSol, realizedPnl } from './logic/realizedPnl.js';

const meridianConfirmer = new ExitConfirmer();
const flipConfirmer = new ExitConfirmer();
// per-pool close history for meridian's cooldowns; in memory only (lost on restart)
const closeHistory = new Map<string, CloseRec[]>();
const LOOP_INTERVAL_MS = 15_000; // position health check cadence (faster than pool scan cadence)

const blacklistPools = new Map<string, number>();
const chaseGuardPools = new Map<string, number>(); // see ScannerConfig.chaseGuardPools (meteoraScanner.ts)
// Optional comma-separated pool addresses to blacklist at boot (in-memory state is lost on restart; e.g. keep a just-closed pool out).
for (const addr of (process.env.BOOT_BLACKLIST_POOLS ?? '').split(',').map((a) => a.trim()).filter(Boolean)) {
  blacklistPools.set(addr, Date.now() + env.BLACKLIST_DURATION_MS);
}
// User-managed pools: kept out of every scan for good (10y expiry; also hard-blocked in meteoraDLMM.ts).
for (const addr of (process.env.PROTECTED_POOLS ?? '').split(',').map((a) => a.trim()).filter(Boolean)) {
  blacklistPools.set(addr, Date.now() + 10 * 365 * 86_400_000);
}
let currentPool: PoolContext | null = null;
// Non-SOL mint of the last pool we entered; used by the flat kill-switch to liquidate leftovers.
let lastOtherMint: string | null = null;
let currentCapitalSol = env.INITIAL_LP_CAPITAL_SOL;
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;
let lastDollarFlowCheckAtMs = 0;
let lastDollarFlowBuyRatio: number | null = null;
// AI manager: one in-flight `claude -p` call at a time, never awaited by the tick (deterministic exits keep running).
let lastSnap = { valueSol: 0, profitPct: 0, peakPct: 0, feesSol: 0 };
let pendingExit: { ctx: PoolContext; reason: string; snap: typeof lastSnap } | null = null;
/** Remember why the position is about to be closed; the outcome is written once the position is really gone (next tick). */
function noteExit(ctx: PoolContext, reason: string): void {
  pendingExit = { ctx, reason, snap: { ...lastSnap } };
}
function flushOutcome(now: number): void {
  if (!pendingExit) return;
  const { ctx, reason, snap } = pendingExit;
  pendingExit = null;
  if (currentPool) return; // exit failed or reopened: the position lives on
  if (env.MERIDIAN_RULES && env.ENTRY_STRATEGY_MODE === 'meridian' && ctx.ladderBins !== undefined) {
    const hist = [...(closeHistory.get(ctx.poolAddress) ?? []), { kind: closeKindFromReason(reason), feesSol: snap.feesSol }].slice(-10);
    closeHistory.set(ctx.poolAddress, hist);
    const hours = cooldownHoursAfterClose(hist, { oorCount: 3, oorHours: 12, repeatCount: 3, repeatHours: 12 });
    if (hours > 0) {
      // meridian cools both the pool and its base mint (the scanner checks the blacklist for either key)
      addToBlacklist(blacklistPools, ctx.poolAddress, now, hours * 3_600_000);
      addToBlacklist(blacklistPools, ctx.xIsSol ? ctx.mintY : ctx.mintX, now, hours * 3_600_000);
    }
  }
  const lc = getLastClose();
  const real = lc && lc.pool === ctx.poolAddress ? realizedPnl(ctx.openSpentSol, lc.receivedSol, ctx.bankedSol ?? 0, ctx.initialDepositSol) : null;
  logger.info('[index] outcome', { pool: ctx.poolAddress, snapshotPnlPct: +snap.profitPct.toFixed(2), realizedPnlPct: real ? +real.pnlPct.toFixed(2) : null, realizedPnlSol: real ? +real.pnlSol.toFixed(5) : null, spentSol: ctx.openSpentSol ?? null, receivedSol: lc && lc.pool === ctx.poolAddress ? lc.receivedSol : null });
  recordOutcome({
    at: new Date(now).toISOString(),
    pool: ctx.poolAddress,
    name: ctx.poolName ?? null,
    tokenMint: ctx.xIsSol ? ctx.mintY : ctx.mintX,
    minutesHeld: ctx.openedAtMs ? Math.round((now - ctx.openedAtMs) / 60_000) : null,
    depositSol: ctx.initialDepositSol,
    lastValueSol: snap.valueSol,
    pnlPct: +snap.profitPct.toFixed(2),
    ...(real ? { realizedPnlPct: +real.pnlPct.toFixed(2), realizedPnlSol: +real.pnlSol.toFixed(5) } : {}),
    peakPct: +snap.peakPct.toFixed(2),
    exitReason: reason,
    entryConviction: ctx.aiEntryConviction ?? null,
    entryReason: ctx.aiEntryReason ?? null,
    strategy: strategyLabel(ctx),
  });
}
let aiManagerBusy = false;
let aiManagerLastAtMs = 0;
let aiManagerClose: { pool: string; reason: string } | null = null;
const aiOn = (): boolean => env.AI_AGENT && env.ENTRY_STRATEGY_MODE === 'meridian';

interface EligibleCandidate {
  candidate: MeteoraPair;
  xIsSol: boolean;
  reserveSolAccount: string;
  solPriceUsd: number;
  dollarFlow: DollarFlowResult | null;
  audit: TokenAudit;
}

async function toAiCandidate(e: EligibleCandidate): Promise<AiCandidate> {
  const c = e.candidate;
  const tok = nonSolToken(c);
  const dd = await getDrawdownFromHighPct(c.address, env.DRAWDOWN_WINDOW_DAYS).catch(() => null);
  const feeBps = await getTransferFeeBps(e.xIsSol ? c.mint_y : c.mint_x).catch(() => null);
  return {
    pool: c.address,
    name: c.name,
    tokenMint: e.xIsSol ? c.mint_y : c.mint_x,
    binStep: c.bin_step,
    baseFeePct: c.baseFeePct,
    tvlUsd: Math.round(Number(c.liquidity)),
    vol24hUsd: Math.round(Number(c.trade_volume_24h)),
    vol1hUsd: Math.round(c.volume1hUsd),
    feeTvl24hPct: c.feeTvlRatio24h ?? null,
    feeTvl4hScaledTo24hPct: c.feeTvlRatio4h == null ? null : +(c.feeTvlRatio4h * 6).toFixed(2),
    mcapUsd: Math.round(tok?.marketCapUsd ?? 0),
    holders: tok?.holders ?? 0,
    organicScore: e.audit.organicScore,
    topHoldersPct: e.audit.topHoldersPct,
    botHoldersPct: e.audit.botHoldersPct,
    globalFeesSol: e.audit.globalFeesSol,
    priceChange1hPct: c.priceChange1hPct ?? null,
    priceChange6hPct: c.priceChange6hPct ?? null,
    priceChange24hPct: c.priceChange24hPct ?? null,
    drawdownFrom14dHighPct: dd,
    transferFeePct: feeBps === null ? null : feeBps / 100,
    freezeAuthorityDisabled: tok?.freezeAuthorityDisabled ?? null,
    mintAuthorityRevoked: tok?.mintAuthorityRevoked ?? null,
    buyRatio1hByTxCount: c.buyRatio1h ?? null,
    dollarFlowBuyRatio: e.dollarFlow ? +e.dollarFlow.buyRatioUsd.toFixed(3) : null,
    dollarFlowTxSampled: e.dollarFlow?.txSampled ?? null,
    poolAgeHours: Math.round((Date.now() - c.createdAtMs) / 3_600_000),
    priorOutcomes: priorFor(loadOutcomes(), c.address, e.xIsSol ? c.mint_y : c.mint_x).map(outcomeLine),
  };
}
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
    pendingLimitOrder: getPendingLimitOrder(),
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
    currentCapitalSol = walletCapitalSol(solBalance);
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
  // An open limit order (exit ask / leftover entry bid) holds the capital: settle it first, entries wait while an ask is inside its window.
  try {
    if ((await processPendingLimitOrder()) === 'waiting') return;
  } catch (err) {
    logger.error('[index] pending limit order could not be settled — holding off new entries', { error: err instanceof Error ? err.message : String(err) });
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
  const fundableSol = Math.max(Math.min(walletNow - computeGasReserveSol(walletNow) - POSITION_RENT_BUFFER_SOL, env.MAX_CAPITAL_SOL > 0 ? env.MAX_CAPITAL_SOL : Infinity), 0);
  // Flat here, so capital should equal what the wallet can fund: refresh at <90% (CRAWL exit left 0.556 vs ~0.98 on 2026-10-12, above the 50% hard guard).
  if (fundableSol > 0 && currentCapitalSol < fundableSol * 0.9) {
    logger.warn('[index] capital figure stale vs wallet — refreshing', { was: currentCapitalSol, fundableSol });
    currentCapitalSol = walletCapitalSol(walletNow);
  }
  const candidates = await scanPools(defaultScannerConfig(blacklistPools, chaseGuardPools), currentCapitalSol);
  const eligible: EligibleCandidate[] = [];
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
    const missing = env.ENTRY_STRATEGY_MODE === 'meridian' ? [] : missingEntryData(candidate);
    if (missing.length > 0) {
      logger.warn(`[index] skipping pool ${candidate.address} — entry data incomplete (fail-closed)`, { missing });
      continue;
    }
    if (env.MAX_DRAWDOWN_FROM_HIGH_PCT > 0 && env.ENTRY_STRATEGY_MODE !== 'meridian') {
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
    if (env.MAX_BELOW_HIGH_48H_PCT > 0 && env.ENTRY_STRATEGY_MODE !== 'meridian') {
      const below48hPct = await getDrawdownFromHighPct(candidate.address, 2);
      if (below48hPct === null) {
        logger.warn(`[index] skipping pool ${candidate.address} — 48h-high distance unavailable (fail-closed)`);
        continue;
      }
      if (below48hPct < -env.MAX_BELOW_HIGH_48H_PCT) {
        logger.info(`[index] skipping pool ${candidate.address} — ${below48hPct}% below its 48h high (max ${env.MAX_BELOW_HIGH_48H_PCT}%)`);
        continue;
      }
    }
    const tokenMint = xIsSol ? candidate.mint_y : candidate.mint_x;
    const feeBps = await getTransferFeeBps(tokenMint);
    // meridian mode: the AI judges transfer-fee tokens (it sees transferFeePct), no hard gate
    if (env.ENTRY_STRATEGY_MODE !== 'meridian' && feeBps === null) {
      logger.warn(`[index] skipping pool ${candidate.address} — transfer-fee lookup failed (fail-closed)`);
      continue;
    }
    if (env.ENTRY_STRATEGY_MODE !== 'meridian' && feeBps !== null && feeBps > env.MAX_TRANSFER_FEE_BPS) {
      logger.info(`[index] skipping pool ${candidate.address} — token has a ${feeBps / 100}% transfer fee (max ${env.MAX_TRANSFER_FEE_BPS / 100}%)`);
      continue;
    }
    const audit = await getTokenAudit(tokenMint);
    if (audit === null) {
      logger.warn(`[index] skipping pool ${candidate.address} — token audit lookup failed (fail-closed)`);
      continue;
    }
    const auditReject = auditRejectReason(audit, {
      maxTopHoldersPct: env.MAX_TOP_HOLDERS_PCT,
      maxBotHoldersPct: env.MAX_BOT_HOLDERS_PCT,
      minGlobalFeesSol: env.MIN_TOKEN_GLOBAL_FEES_SOL,
      minOrganicScore: env.MIN_ORGANIC_SCORE,
    });
    if (auditReject) {
      logger.info(`[index] skipping pool ${candidate.address} — token audit: ${auditReject}`, { audit });
      continue;
    }
    logger.info('[index] token audit ok', { pool: candidate.address, audit });
    const dollarFlow = env.DOLLAR_FLOW_ENABLED ? await getDollarVolumeBuyRatio(reserveSolAccount, solPriceUsd) : null;
    if (env.DOLLAR_FLOW_ENABLED) {
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
    }

    eligible.push({ candidate, xIsSol, reserveSolAccount, solPriceUsd, dollarFlow, audit });
  }

  // AI agent (meridian-style screener): picks ONE of the eligible candidates or skips. Fail-closed.
  let toTry = eligible;
  let aiBins: number | undefined;
  let aiStrategy: 'sol_ladder' | 'token_spot' = 'sol_ladder';
  let aiReason: string | undefined;
  let aiConviction: number | undefined;
  if (aiOn() && eligible.length > 0) {
    const decision = await aiScreen(await Promise.all(eligible.map((e) => toAiCandidate(e))), currentCapitalSol);
    if (decision.action === 'skip') {
      logger.info('[index] AI screener: skip', { reason: decision.reason });
      toTry = [];
    } else {
      toTry = eligible.filter((e) => e.candidate.address === decision.pool);
      aiBins = decision.bins;
      aiStrategy = decision.strategy;
      aiReason = decision.reason;
      aiConviction = decision.conviction;
    }
  }
  for (const { candidate, xIsSol, reserveSolAccount, solPriceUsd, dollarFlow } of toTry) {
    const priceContext = await getEntryPriceContext(candidate.address); // observability only, never gates entry
    try {
      const pool = await openPool(candidate.address);
      lastOtherMint = xIsSol ? candidate.mint_y : candidate.mint_x;
      currentPool = await guarded(() =>
        env.ENTRY_STRATEGY_MODE === 'meridian' && aiStrategy === 'token_spot'
          ? openTokenSpotEntry(pool, candidate.address, candidate.mint_x, candidate.mint_y, xIsSol, currentCapitalSol, candidate.bin_step, xIsSol ? candidate.reserve_x : candidate.reserve_y, aiBins)
          : env.ENTRY_STRATEGY_MODE === 'meridian'
          ? openLadderEntry(pool, candidate.address, candidate.mint_x, candidate.mint_y, xIsSol, currentCapitalSol, candidate.bin_step, xIsSol ? candidate.reserve_x : candidate.reserve_y, aiBins)
          : openInitialPosition(
          pool,
          candidate.address,
          candidate.mint_x,
          candidate.mint_y,
          xIsSol,
          currentCapitalSol,
          candidate.bin_step,
          xIsSol ? candidate.reserve_x : candidate.reserve_y,
          // after an entry-bid wait the flow may have turned: same $-flow gate as above, fail-closed
          async () => {
            const again = await getDollarVolumeBuyRatio(reserveSolAccount, solPriceUsd);
            return again !== null && again.buyRatioUsd >= env.MIN_DOLLAR_BUY_RATIO;
          },
        ),
      );
      currentPool.poolName = candidate.name;
      aiManagerLastAtMs = Date.now(); // first manager check comes after the periodic interval, not at entry
      if (aiReason) currentPool.aiEntryReason = aiReason;
      if (aiConviction !== undefined) currentPool.aiEntryConviction = aiConviction;
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
        dollarFlow: dollarFlow ? { buyRatioUsd: +dollarFlow.buyRatioUsd.toFixed(3), txSampled: dollarFlow.txSampled } : null,
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
  flushOutcome(Date.now());
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
  // token_spot: out of range BELOW = still all token (not reached); inside, or above (sold out into SOL), counts as reached
  if (ctx.tokenSpot && !ctx.tokenSpotReached && (!binStatus.isOutOfRange || !binStatus.tokenBelowRange)) ctx.tokenSpotReached = true;

  // Option A (VOLUME_BASELINE_REFRESH_MS, default 0/disabled) — reuses the
  // volume1hNowUsd already fetched above, no extra API call. See env.ts
  // doc comment for the full rationale/trade-off.
  if (env.VOLUME_BASELINE_REFRESH_MS > 0 && now - ctx.volume1hBaselineSetAtMs >= env.VOLUME_BASELINE_REFRESH_MS && volume1hNowUsd !== null) {
    ctx.volume1hBaselineUsd = volume1hNowUsd;
    ctx.volume1hBaselineSetAtMs = now;
  }

  // Meridian's PnL (Meteora's own) includes unclaimed fees: value excludes them, so add them back in meridian mode (TP/trailing/SL all read this).
  const meridianRules = env.MERIDIAN_RULES && env.ENTRY_STRATEGY_MODE === 'meridian' && ctx.ladderBins !== undefined;
  // flip phase: the SOL banked at the flip sits in the wallet; the cycle PnL (SL, trailing, peak) must count it
  // meridian mode: net of the estimated cost of selling the token side (user decision 2026-10-18), so TP/trailing/SL see what the exit would really return
  const exitCostSol = meridianRules ? estimateExitCostSol(otherPrincipalSol, env.EXIT_COST_PCT, env.EXIT_COST_GAS_SOL) : 0;
  const pnlValueSol = pnlBasisSol(currentValueSol, unclaimedFeesSol, ctx.bankedSol ?? 0, meridianRules, exitCostSol);
  const currentProfitPct = ctx.initialDepositSol > 0 ? ((pnlValueSol - ctx.initialDepositSol) / ctx.initialDepositSol) * 100 : 0;
  ctx.peakProfitPct = Math.max(ctx.peakProfitPct, currentProfitPct);
  lastSnap = { valueSol: currentValueSol + (ctx.bankedSol ?? 0), profitPct: currentProfitPct, peakPct: ctx.peakProfitPct, feesSol: unclaimedFeesSol };

  const gasCostSol = estimateCycleGasCostSol(ctx.initialDepositSol);
  const evald = evaluatePosition({
    initialDepositUsd: ctx.initialDepositSol,
    currentValueUsd: pnlValueSol,
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
  // Meridian mode: its deterministic close rules replace our own exit heuristics (volume drop, tiered TP, idle rebalance, upside break).
  // Only the stop loss (STOP_LOSS_PCT) is kept from evaluatePosition.
  const slHit = evald.reasons.some((r) => r.includes('STOP_LOSS_PCT'));
  const decision = meridianRules ? 'HOLD' : evald.decision;
  const reasons = meridianRules ? [] : evald.reasons;

  logger.info(`[index] pool ${ctx.poolAddress} health check`, {
    decision,
    reasons,
    currentValueSol,
    unclaimedFeesSol,
    isOutOfRange: binStatus.isOutOfRange,
    currentBinId: binStatus.currentBinId,
  });

  if (!meridianRules && decision !== 'HARD_EXIT' && shouldExitOnUpsideBreak({
    exitAfterMin: ctx.ladderBins !== undefined ? env.LADDER_OOR_EXIT_MIN : env.UPSIDE_BREAK_EXIT_MIN,
    isOutOfRange: binStatus.isOutOfRange,
    outOfRangeSinceMs: ctx.outOfRangeSinceMs,
    nowMs: now,
    tokenValueSol: otherPrincipalSol,
    totalValueSol: currentValueSol,
  })) {
    logger.warn('[index] upside break: position is all SOL and out of range — exiting instead of re-buying higher', { pool: ctx.poolAddress, currentValueSol, unclaimedFeesSol });
    try {
      noteExit(ctx, 'UPSIDE_BREAK');
      currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools, false));
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

  if (meridianRules && decision === 'HOLD') {
    let binsAbove = 0;
    if (ctx.centerBinId !== null && ctx.ladderBins !== undefined) {
      const { lo, hi } = ladderBounds(ctx.centerBinId, ctx.ladderBins, isTokenSide(ctx) ? !ctx.xIsSol : ctx.xIsSol);
      binsAbove = ctx.xIsSol ? lo - binStatus.currentBinId : binStatus.currentBinId - hi;
    }
    const ageMinutes = ctx.openedAtMs !== undefined ? (now - ctx.openedAtMs) / 60_000 : null;
    const slReason = slHit ? evald.reasons.find((r) => r.includes('STOP_LOSS_PCT')) : undefined;
    // Flip: the SOL ladder is 100% token (price below its lowest bin). The flip wins over every non-stop-loss exit signal (low yield, ...): selling the dip is what it avoids.
    const flipWanted = env.FLIP_ENABLED && shouldFlip({ enabled: true, belowRange: binStatus.tokenBelowRange, isLadder: ctx.ladderBins !== undefined, tokenSpot: !!ctx.tokenSpot, flipPhase: !!ctx.flipPhase });
    const exitCfg = {
      takeProfitPct: env.MERIDIAN_TAKE_PROFIT_PCT,
      trailingTriggerPct: env.MERIDIAN_TRAILING_TRIGGER_PCT,
      trailingDropPct: env.MERIDIAN_TRAILING_DROP_PCT,
      outOfRangeBinsToClose: env.MERIDIAN_OOR_BINS_TO_CLOSE,
      outOfRangeWaitMinutes: oorWaitMinutes(!!ctx.tokenSpot, !!ctx.tokenSpotReached, { standard: env.MERIDIAN_OOR_WAIT_MIN, spotFirst: env.MERIDIAN_TOKEN_SPOT_OOR_WAIT_MIN, spotAfterReach: env.MERIDIAN_TOKEN_SPOT_OOR_AFTER_REACH_MIN }),
      minFeePerTvl24hPct: env.MERIDIAN_MIN_FEE_TVL_24H_PCT,
      minAgeBeforeYieldCheckMin: env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN,
    };
    const minutesOutOfRange = ctx.outOfRangeSinceMs !== null ? (now - ctx.outOfRangeSinceMs) / 60_000 : null;
    // Flip phase: only the cycle stop loss (above), a pool TVL collapse and "sold out above the range for N min" can exit (logic/flip.ts flipExitSignal).
    const flipPhaseSignal = ctx.flipPhase ? flipExitSignal({ isOutOfRange: binStatus.isOutOfRange, tokenBelowRange: binStatus.tokenBelowRange, minutesOutOfRange, tvlUsd: (await getPoolStats(ctx.poolAddress)).tvlUsd, flipTvlUsd: ctx.flipTvlUsd ?? null }, { oorAboveExitMin: env.FLIP_OOR_ABOVE_EXIT_MIN, tvlCollapsePct: env.FLIP_TVL_COLLAPSE_PCT }) : null;
    // meridian's own rules only matter on a SOL ladder that is not about to flip (no needless fee/TVL call otherwise)
    const meridianSignal = ctx.flipPhase || flipWanted || slReason !== undefined ? null : meridianExitSignal(
      {
        pnlPct: currentProfitPct,
        peakPnlPct: ctx.peakProfitPct,
        binsAbove,
        isOutOfRange: binStatus.isOutOfRange,
        minutesOutOfRange,
        feePerTvl24hPct: ageMinutes !== null && ageMinutes >= env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN ? await getPoolFeeTvl24hPct(ctx.poolAddress) : null,
        ageMinutes,
      },
      exitCfg,
    );
    const signal = selectExitSignal({ stopLoss: slReason !== undefined ? `stop loss: ${slReason}` : null, flipPhase: !!ctx.flipPhase, flipWanted, flipPhaseSignal, meridianSignal });
    if (signal) logger.info('[index] meridian rule signal', { pool: ctx.poolAddress, signal });
    if (meridianConfirmer.hit(signal, env.MERIDIAN_CONFIRM_TICKS)) {
      if (trailingBlockedByFloor(signal, currentProfitPct, env.TRAILING_MIN_PNL_PCT)) {
        // overshoot: the dump outran the 2-tick confirmation, so closing now would only realise a loss. Keep the position and re-arm from here.
        ctx.peakProfitPct = currentProfitPct;
        logger.warn('[index] trailing TP confirmed below the PnL floor: NOT closing, peak reset to current PnL', { pool: ctx.poolAddress, signal, pnlPct: +currentProfitPct.toFixed(2), floorPct: env.TRAILING_MIN_PNL_PCT });
        return;
      }
      logger.warn('[index] meridian close rule confirmed — closing', { pool: ctx.poolAddress, signal });
      try {
        noteExit(ctx, `MERIDIAN: ${signal!.slice(0, 120)}`);
        currentCapitalSol = await guarded(() =>
          signal!.startsWith('stop loss')
            ? executeCleanExit(ctx, 'STOP_LOSS', chaseGuardPools, false)
            : env.DOWNBREAK_ASK_PCT > 0 && binStatus.tokenBelowRange && !isTokenSide(ctx)
              ? executeDownBreakExit(ctx)
              : executeCleanExit(ctx, 'TAKE_PROFIT', chaseGuardPools, false),
        );
        currentPool = null;
      } catch (err) {
        logger.error('[index] meridian close threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
        currentPool = await reconcilePoolStateAfterFailure(ctx);
        // A failed trailing close lets PnL drift far below the old peak; re-arm from where it is now so a later
        // success does not dump the position at a loss on a stale peak (live 2026-10-16: peak 4.41% -> -0.55% during 388 failed closes).
        if (currentPool && signal!.startsWith('trailing TP')) {
          currentPool.peakProfitPct = currentProfitPct;
          logger.warn('[index] trailing close failed: peak reset to current PnL', { pool: ctx.poolAddress, peakPct: +currentProfitPct.toFixed(2) });
        }
      }
      return;
    }

    // Bid-ask flip: price fell below the lowest bin, so the whole SOL side is token. Only when no stop loss is pending (it wins), confirmed over FLIP_CONFIRM_TICKS ticks (1 = at once).
    if (!signal && flipWanted) {
      if (flipConfirmer.hit('flip', env.FLIP_CONFIRM_TICKS)) {
        logger.warn('[index] flip confirmed — price is below the lowest bin, closing the ladder and redepositing the token above the old bottom', { pool: ctx.poolAddress, tokenSharePct: currentValueSol > 0 ? +((otherPrincipalSol / currentValueSol) * 100).toFixed(1) : 0 });
        try {
          // reference for the liquidity-collapse exit; unknown (undefined) skips that check
          ctx.flipTvlUsd = (await getPoolStats(ctx.poolAddress)).tvlUsd ?? undefined;
          currentPool = await guarded(() => executeFlip(ctx, persist));
        } catch (err) {
          logger.error('[index] executeFlip threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
          currentPool = await reconcilePoolStateAfterFailure(ctx);
        }
        return;
      }
    } else {
      flipConfirmer.hit(null, env.MERIDIAN_CONFIRM_TICKS);
    }
  }

  if (decision === 'HARD_EXIT') {
    try {
      noteExit(ctx, `HARD_EXIT: ${reasons.join('; ').slice(0, 120)}`);
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
      noteExit(ctx, `TAKE_PROFIT: ${reasons.join('; ').slice(0, 120)}`);
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
    // Token price stayed BELOW the range for the whole idle window: close and sell on an ask above the price instead of recentering (DOWNBREAK_ASK_PCT > 0).
    if (env.DOWNBREAK_ASK_PCT > 0 && binStatus.tokenBelowRange) {
      logger.warn('[index] down-break held out of range — closing and selling the token on an ask limit order', { pool: ctx.poolAddress, askPct: env.DOWNBREAK_ASK_PCT });
      try {
        noteExit(ctx, 'DOWN_BREAK_ASK');
        currentCapitalSol = await guarded(() => executeDownBreakExit(ctx));
        currentPool = null;
      } catch (err) {
        logger.error('[index] executeDownBreakExit threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
        currentPool = await reconcilePoolStateAfterFailure(ctx);
      }
      return;
    }
    // Ladder (meridian mode): never recenter/re-buy. Above the ladder is handled by the upside-break exit; anything else
    // that reaches REBALANCE is closed to SOL and the scanner picks the next pool.
    if (ctx.ladderBins !== undefined) {
      logger.warn('[index] ladder idle-forced rebalance — closing to SOL instead of recentering', { pool: ctx.poolAddress });
      try {
        noteExit(ctx, 'LADDER_IDLE_REBALANCE');
        currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'SWITCH', chaseGuardPools));
        currentPool = null;
      } catch (err) {
        logger.error('[index] executeCleanExit (ladder rebalance) threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
        currentPool = await reconcilePoolStateAfterFailure(ctx);
      }
      return;
    }
    // REBALANCE only ever fires idle-forced (out-of-range) now — see
    // riskManager.ts's 2026-09-26 removal note. compoundCycle re-checks
    // whether this pool still passes the entry screen: null means it
    // doesn't (capital converted to SOL, no reopen) — next tick's
    // tryEnterPool() picks up from there.
    try {
      noteExit(ctx, 'REBALANCE');
      currentPool = await guarded(() => compoundCycle(ctx, defaultScannerConfig(blacklistPools, chaseGuardPools), currentProfitPct));
      if (!currentPool) {
        const solBalance = await getWalletSolBalance();
        currentCapitalSol = walletCapitalSol(solBalance);
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

  // Flip phase: the AI manager is not consulted and a close it asked for earlier is dropped (AI_EXIT blocked). The bot waits for the bounce;
  // only the cycle stop loss, a pool TVL collapse and "sold out above the range" exit (see flipExitSignal), plus the existing dollar-flow exit when enabled.
  if (!aiExitAllowed(ctx) && aiManagerClose && aiManagerClose.pool === ctx.poolAddress) {
    logger.warn('[ai] AI_EXIT blocked in flip phase (waiting for the bounce)', { pool: ctx.poolAddress, reason: aiManagerClose.reason.slice(0, 160) });
    aiManagerClose = null;
  }
  // AI manager (meridian-style): hold/close from Claude. Never blocks the tick; the automatic exits above/below always run first.
  if (aiOn() && ctx.ladderBins !== undefined && aiExitAllowed(ctx)) {
    if (aiManagerClose && aiManagerClose.pool === ctx.poolAddress) {
      const { reason } = aiManagerClose;
      aiManagerClose = null;
      logger.warn('[index] AI manager: closing position', { pool: ctx.poolAddress, reason });
      try {
        noteExit(ctx, `AI_EXIT: ${reason.slice(0, 120)}`);
        currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'AI_EXIT', chaseGuardPools));
        addToBlacklist(blacklistPools, ctx.poolAddress, now, env.LEFT_POOL_COOLDOWN_MS);
        currentPool = null;
      } catch (err) {
        logger.error('[index] executeCleanExit (AI manager) threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
        currentPool = await reconcilePoolStateAfterFailure(ctx);
      }
      return;
    }
    const tokenShare = currentValueSol > 0 ? (otherPrincipalSol / currentValueSol) * 100 : 0;
    const volVsBase = volume1hNowUsd !== null && ctx.volume1hBaselineUsd > 0 ? Math.round((volume1hNowUsd / ctx.volume1hBaselineUsd) * 100) : null;
    const trigger = aiManagerBusy
      ? null
      : managerTrigger(
          {
            isOutOfRange: binStatus.isOutOfRange,
            minutesOutOfRange: ctx.outOfRangeSinceMs ? Math.round((now - ctx.outOfRangeSinceMs) / 60_000) : null,
            profitPct: currentProfitPct,
            volumeVsBaselinePct: volVsBase,
            tokenSharePct: tokenShare,
            minutesSinceLastCall: aiManagerLastAtMs === 0 ? Infinity : (now - aiManagerLastAtMs) / 60_000,
          },
          { periodicMin: env.AI_MANAGE_INTERVAL_MIN, cooldownMin: env.AI_MANAGE_TRIGGER_COOLDOWN_MIN, oorMin: env.AI_TRIGGER_OOR_MIN, lossPct: env.AI_TRIGGER_LOSS_PCT, volumeBelowPct: env.AI_TRIGGER_VOLUME_BELOW_PCT },
        );
    if (trigger) {
      logger.info('[ai] manager triggered', { pool: ctx.poolAddress, trigger });
      aiManagerBusy = true;
      aiManagerLastAtMs = now;
      const priceVsLadder = !binStatus.isOutOfRange ? 'inside' : binStatus.tokenBelowRange ? 'below (all token)' : 'above (all SOL, earning nothing)';
      void aiManage(
        {
          pool: ctx.poolAddress,
          tokenMint: ctx.xIsSol ? ctx.mintY : ctx.mintX,
          minutesOpen: ctx.openedAtMs ? Math.round((now - ctx.openedAtMs) / 60_000) : null,
          depositSol: ctx.initialDepositSol,
          valueSol: currentValueSol,
          profitPct: +currentProfitPct.toFixed(2),
          peakProfitPct: +ctx.peakProfitPct.toFixed(2),
          unclaimedFeesSol,
          tokenShareOfValuePct: +tokenShare.toFixed(1),
          isOutOfRange: binStatus.isOutOfRange,
          minutesOutOfRange: ctx.outOfRangeSinceMs ? Math.round((now - ctx.outOfRangeSinceMs) / 60_000) : null,
          priceVsLadder,
          strategy: strategyLabel(ctx),
          bankedSol: ctx.bankedSol,
          ladderBins: ctx.ladderBins,
          volume1hNowUsd,
          volume1hBaselineUsd: ctx.volume1hBaselineUsd,
          volumeVsBaselinePct: volume1hNowUsd !== null && ctx.volume1hBaselineUsd > 0 ? Math.round((volume1hNowUsd / ctx.volume1hBaselineUsd) * 100) : null,
          dollarFlowBuyRatio: lastDollarFlowBuyRatio,
          entryReason: ctx.aiEntryReason ?? null,
        },
        { stopLossPct: env.STOP_LOSS_PCT, ladderOorExitMin: env.LADDER_OOR_EXIT_MIN, idleOutOfRangeMin: env.MAX_IDLE_OUT_OF_RANGE_MINUTES, volumeDropExitPct: env.VOLUME_DROP_HARD_EXIT_PCT },
      )
        .then((d) => {
          if (d.action === 'close') aiManagerClose = { pool: ctx.poolAddress, reason: d.reason };
        })
        .finally(() => {
          aiManagerBusy = false;
        });
    }
  }

  // Dollar-volume-weighted sell-pressure check (flowAnalysis.ts) — runs
  // for the held position regardless of ENTRY_STRATEGY_MODE (unlike the
  // momentum-only switch check below, whale-dump detection is a general
  // risk signal, not a mode-specific thesis). Reuses OPPORTUNITY_SCAN_INTERVAL_MS
  // as a cheap, already-existing cadence rather than inventing a new env
  // var. A null result (RPC hiccup, no sampled activity) is unknown — don't
  // act on it, same permissive policy as the rest of the screen.
  if (env.DOLLAR_FLOW_ENABLED && now - lastDollarFlowCheckAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
    lastDollarFlowCheckAtMs = now;
    const solPriceUsd = await getSolPriceUsd(ctx.poolAddress);
    if (solPriceUsd !== null) {
      const dollarFlow = await getDollarVolumeBuyRatio(ctx.reserveSolAccount, solPriceUsd);
      lastDollarFlowBuyRatio = dollarFlow?.buyRatioUsd ?? null;
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
          noteExit(ctx, 'FLOW_EXIT');
          currentCapitalSol = await guarded(() => executeCleanExit(ctx, 'FLOW_EXIT', chaseGuardPools));
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
    restorePendingLimitOrder(saved.pendingLimitOrder ?? null);
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
    // with an open limit order the capital is inside the order, not liquid in the wallet
    if (!saved?.pendingLimitOrder && solBalance < env.INITIAL_LP_CAPITAL_SOL + gasReserveSol) {
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
