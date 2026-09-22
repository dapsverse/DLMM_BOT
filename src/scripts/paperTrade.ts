/**
 * Paper-trading simulation: runs the same scan → screen → risk-decision
 * loop as the real bot, but never touches a wallet, never signs, never
 * sends a transaction. Every tick it re-pulls live Meteora pool data and
 * estimates what the bot's virtual capital would be worth.
 *
 * No wallet needed — imports only meteoraScanner.js (screen) and
 * riskManager.js (pure decision function), never solana.ts/meteoraDLMM.ts/
 * jupiterSwap.ts. `.env`'s PRIVATE_KEY can stay the dummy placeholder.
 *
 * Usage:
 *   npm run paper-trade                  # runs for PAPER_TRADE_HOURS (default 12)
 *   PAPER_TRADE_HOURS=1 npm run paper-trade   # shorter smoke test
 *   npm run paper-trade:report           # prints current state anytime, from any terminal
 *
 * ── Simulation model (approximation, read before trusting the numbers) ──
 * Fee accrual: pro-rata share of the pool's trailing fee rate —
 *   ourShare = capitalUsd / (poolTvlUsd + capitalUsd), applied to
 *   pool.fees_24h prorated over the elapsed tick interval. This assumes
 *   our liquidity earns the SAME rate as the pool average. Real DLMM is
 *   concentrated (bins): a position held tight around the active bin
 *   (radius derived per-pool from bin_step, see logic/binRange.ts) usually captures MORE than a naive TVL-share
 *   while price stays in range, and captures ZERO once price exits the
 *   range (liquidity goes idle, one-sided). This sim does not model bin
 *   exit — treat its fee number as a rough floor, not a ceiling.
 * Price PnL / IL: standard constant-product impermanent-loss formula
 *   (2*sqrt(r)/(1+r), r = price-ratio change since entry) applied to the
 *   memecoin/SOL price ratio. Real DLMM IL inside a narrow range is
 *   typically WORSE than constant-product once price nears the range edge
 *   (position goes single-sided) — this sim also doesn't model that edge
 *   effect. Treat the reported PnL as directional, not a precise backtest.
 * Costs: every ENTER/REBALANCE/HARD_EXIT deducts an estimated cycle cost
 *   (priority fees + swap slippage/DEX fee, see logic/costEstimate.ts) from
 *   capital before it's reinvested — this is the SAME formula rebalanceEngine
 *   uses for its real fee-vs-gas threshold check, so an overly cheap
 *   estimate here means the real bot's threshold is equally too loose, not
 *   just an artifact of the sim.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchTopPools,
  filterAndRankPools,
  defaultScannerConfig,
  nonSolToken,
  solToken,
  type MeteoraPair,
} from '../services/meteoraScanner.js';
import { evaluatePosition, addToBlacklist } from '../logic/riskManager.js';
import { estimateCycleGasCostSol } from '../logic/costEstimate.js';
import { computeBinRadius } from '../logic/binRange.js';
import { getActiveBinId } from '../services/rpc.js';
import { env } from '../config/env.js';

const TICK_MS = 60_000; // matches MIN_SCAN_INTERVAL_MS — no point polling Meteora faster
const DURATION_HOURS = Number(process.env.PAPER_TRADE_HOURS ?? 12);
const DURATION_MS = DURATION_HOURS * 3_600_000;

// PAPER_TRADE_LABEL lets multiple sims run side by side (e.g. different
// strategy branches) without clobbering each other's state file — each
// label gets its own paper-trade-state-<label>.json. Unset = legacy plain
// filename, so an already-running unlabeled process (started before this
// existed) keeps writing where it always has.
const LABEL = process.env.PAPER_TRADE_LABEL?.trim() || null;

fs.mkdirSync(env.LOG_DIR, { recursive: true });
const runStartedAtMs = Date.now();
const jsonlPath = path.join(env.LOG_DIR, LABEL ? `paper-trade-${LABEL}-${runStartedAtMs}.jsonl` : `paper-trade-${runStartedAtMs}.jsonl`);
const statePath = path.join(env.LOG_DIR, LABEL ? `paper-trade-state-${LABEL}.json` : 'paper-trade-state.json');
const logStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

interface VirtualPosition {
  poolAddress: string;
  poolName: string;
  enteredAtMs: number;
  lastRebalanceAtMs: number;
  lastFeeAccrualAtMs: number;
  rebalanceTimestamps: number[];
  capitalUsd: number; // capital as of last entry/compound
  feesEarnedUsd: number; // accrued since last entry/compound
  entrySolPriceUsd: number;
  entryMemePriceUsd: number;
  volume1hBaselineUsd: number;
  /** Pool's bin_step — constant for the pool's lifetime, used to derive the bin radius (see logic/binRange.ts). */
  binStep: number;
  /** Active bin id when the position was opened/last compounded — null if the RPC read failed. */
  centerBinId: number | null;
  /** When the position first went out-of-range (epoch ms) — null while in-range/unknown. */
  outOfRangeSinceMs: number | null;
}

interface PoolVisit {
  pool: string;
  address: string;
  enteredAtMs: number;
  entryCapitalUsd: number;
  exitedAtMs?: number;
  exitType?: 'HARD_EXIT' | 'STILL_OPEN';
  exitValueUsd?: number;
  exitReasons?: string[];
  rebalanceCount: number;
}

interface RunSummary {
  label: string;
  startedAtMs: number;
  startingCapitalUsd: number | null;
  poolsEntered: number;
  rebalances: number;
  hardExits: number;
  poolHistory: PoolVisit[];
}

let position: VirtualPosition | null = null;
let idleCapitalUsd = 0; // capital not currently in a position (between hard-exit and next entry)
let lastKnownSolPriceUsd = 0;
const blacklist = new Map<string, number>();
const summary: RunSummary = {
  label: LABEL ?? 'default',
  startedAtMs: runStartedAtMs,
  startingCapitalUsd: null,
  poolsEntered: 0,
  rebalances: 0,
  hardExits: 0,
  poolHistory: [],
};

function logEvent(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  logStream.write(line + '\n');
  console.log(line);
}

/**
 * Extrapolates the memecoin-in-SOL price at a given bin, from a known
 * (currentBinId, currentPriceInSol) reference point, using DLMM's bin
 * price formula (price compounds by (1+binStep/10000) per bin, monotonic
 * in the pool's own X-in-Y direction — inverted here when SOL is token_x,
 * since callers always want "memecoin price in SOL", not "SOL price in
 * memecoin"). No decimals lookup needed: the current price is already
 * decimal-adjusted (it comes straight from the Meteora API), and this only
 * extrapolates a ratio from it.
 */
function priceAtBinOffset(currentPriceInSol: number, binStep: number, binOffsetFromCurrent: number, xIsSol: boolean): number {
  const factor = Math.pow(1 + binStep / 10_000, binOffsetFromCurrent);
  return xIsSol ? currentPriceInSol / factor : currentPriceInSol * factor;
}

interface PriceRangeContext {
  currentPriceInSol: number;
  currentBinId: number;
  binStep: number;
  xIsSol: boolean;
}

function writeState(currentValueUsd: number, currentBinId?: number | null, priceCtx?: PriceRangeContext | null): void {
  const elapsedMs = Date.now() - runStartedAtMs;
  const pnlUsd = summary.startingCapitalUsd === null ? 0 : currentValueUsd - summary.startingCapitalUsd;
  const pnlPct = summary.startingCapitalUsd ? (pnlUsd / summary.startingCapitalUsd) * 100 : 0;

  let binInfo: Record<string, unknown> | null = null;
  if (position) {
    const center = position.centerBinId;
    const radius = computeBinRadius(position.binStep);
    const rangeMinBinId = center === null ? null : center - radius;
    const rangeMaxBinId = center === null ? null : center + radius;
    const inRange =
      center !== null && currentBinId !== undefined && currentBinId !== null ? Math.abs(currentBinId - center) <= radius : null;
    const binsFromCenter = center !== null && currentBinId !== undefined && currentBinId !== null ? currentBinId - center : null;

    let priceRangeSol: { low: number; high: number; current: number } | null = null;
    if (priceCtx && rangeMinBinId !== null && rangeMaxBinId !== null) {
      const priceAtMin = priceAtBinOffset(priceCtx.currentPriceInSol, priceCtx.binStep, rangeMinBinId - priceCtx.currentBinId, priceCtx.xIsSol);
      const priceAtMax = priceAtBinOffset(priceCtx.currentPriceInSol, priceCtx.binStep, rangeMaxBinId - priceCtx.currentBinId, priceCtx.xIsSol);
      priceRangeSol = { low: Math.min(priceAtMin, priceAtMax), high: Math.max(priceAtMin, priceAtMax), current: priceCtx.currentPriceInSol };
    }

    binInfo = { centerBinId: center, rangeMinBinId, rangeMaxBinId, currentBinId: currentBinId ?? null, inRange, binsFromCenter, priceRangeSol };
  }

  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        ...summary,
        elapsedHours: +(elapsedMs / 3_600_000).toFixed(2),
        durationHours: DURATION_HOURS,
        finished: elapsedMs >= DURATION_MS,
        currentValueUsd: +currentValueUsd.toFixed(2),
        pnlUsd: +pnlUsd.toFixed(2),
        pnlPct: +pnlPct.toFixed(2),
        currentPosition: position
          ? {
              pool: position.poolName,
              address: position.poolAddress,
              capitalUsd: +position.capitalUsd.toFixed(2),
              feesEarnedUsd: +position.feesEarnedUsd.toFixed(2),
              bin: binInfo,
            }
          : null,
        jsonlLog: jsonlPath,
      },
      null,
      2,
    ),
  );
}

/** Constant-product IL multiplier: LP value / held-value at price-ratio change r. */
function ilMultiplier(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 1;
  return (2 * Math.sqrt(r)) / (1 + r);
}

async function enterBestPool(pairs: MeteoraPair[]): Promise<VirtualPosition | null> {
  const candidates = await filterAndRankPools(pairs, defaultScannerConfig(blacklist));
  if (!candidates.length) {
    logEvent({ type: 'NO_CANDIDATE', note: 'no pool passes screen this tick' });
    return null;
  }
  const chosen = candidates[0]!;
  const sol = solToken(chosen);
  const meme = nonSolToken(chosen);
  if (!sol || !meme) return null; // shouldn't happen post-screen, defensive

  if (summary.startingCapitalUsd === null) {
    idleCapitalUsd = env.INITIAL_LP_CAPITAL_SOL * sol.priceUsd;
    summary.startingCapitalUsd = idleCapitalUsd;
  }
  lastKnownSolPriceUsd = sol.priceUsd;

  // Entry costs real gas + a balancing swap too — deduct before the capital starts earning.
  const entryCostSol = estimateCycleGasCostSol(idleCapitalUsd / sol.priceUsd);
  const entryCostUsd = entryCostSol * sol.priceUsd;
  const capitalAfterEntryCostUsd = Math.max(idleCapitalUsd - entryCostUsd, 0);
  const centerBinId = await getActiveBinId(chosen.address);

  const now = Date.now();
  const entered: VirtualPosition = {
    poolAddress: chosen.address,
    poolName: chosen.name,
    enteredAtMs: now,
    lastRebalanceAtMs: now,
    lastFeeAccrualAtMs: now,
    rebalanceTimestamps: [],
    capitalUsd: capitalAfterEntryCostUsd,
    feesEarnedUsd: 0,
    entrySolPriceUsd: sol.priceUsd,
    entryMemePriceUsd: meme.priceUsd,
    volume1hBaselineUsd: chosen.volume1hUsd,
    binStep: chosen.bin_step,
    centerBinId,
    outOfRangeSinceMs: null,
  };
  position = entered;
  summary.poolsEntered++;
  summary.poolHistory.push({
    pool: chosen.name,
    address: chosen.address,
    enteredAtMs: now,
    entryCapitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
    rebalanceCount: 0,
  });
  logEvent({
    type: 'ENTER',
    pool: chosen.name,
    address: chosen.address,
    capitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
    entryCostUsd: +entryCostUsd.toFixed(2),
    solPriceUsd: sol.priceUsd,
    memePriceUsd: meme.priceUsd,
    tvlUsd: Number(chosen.liquidity),
    vol24hUsd: chosen.trade_volume_24h,
    centerBinId,
    binRange: centerBinId === null ? null : [centerBinId - computeBinRadius(chosen.bin_step), centerBinId + computeBinRadius(chosen.bin_step)],
  });
  return entered;
}

async function tick(): Promise<void> {
  const pairs = await fetchTopPools();

  if (!position) {
    // revalue idle capital against latest SOL price (any pool with a SOL side works)
    const anySol = pairs.map(solToken).find((t) => t !== null);
    if (anySol && lastKnownSolPriceUsd > 0) {
      idleCapitalUsd = (idleCapitalUsd / lastKnownSolPriceUsd) * anySol.priceUsd;
      lastKnownSolPriceUsd = anySol.priceUsd;
    }
    const entered = await enterBestPool(pairs);
    writeState(entered ? entered.capitalUsd : idleCapitalUsd);
    return;
  }

  const live = pairs.find((p) => p.address === position!.poolAddress);
  if (!live) {
    logEvent({ type: 'STALE_POOL', pool: position.poolName, note: 'dropped out of top-200 volume window; holding last known value' });
    writeState(position.capitalUsd + position.feesEarnedUsd);
    return;
  }

  const sol = solToken(live);
  const meme = nonSolToken(live);
  if (!sol || !meme) return; // defensive, shouldn't happen for a pool we entered
  lastKnownSolPriceUsd = sol.priceUsd;

  const now = Date.now();
  const tvlUsd = Number(live.liquidity);
  const currentBinId = await getActiveBinId(position.poolAddress);
  const binsFromCenter = position.centerBinId !== null && currentBinId !== null ? currentBinId - position.centerBinId : null;
  const inRange = binsFromCenter === null ? null : Math.abs(binsFromCenter) <= computeBinRadius(position.binStep);
  const isOutOfRange = inRange === false; // null (unknown) is treated as "not (confirmed) out of range" — don't force on missing data
  if (isOutOfRange && position.outOfRangeSinceMs === null) position.outOfRangeSinceMs = now;
  else if (!isOutOfRange) position.outOfRangeSinceMs = null;

  // Fee accrual since last tick, pro-rata TVL share (see file header caveat).
  const elapsedHours = (now - position.lastFeeAccrualAtMs) / 3_600_000;
  const ourShare = position.capitalUsd / (tvlUsd + position.capitalUsd);
  const feeThisTick = ourShare * live.fees_24h * (elapsedHours / 24);
  position.feesEarnedUsd += feeThisTick;
  position.lastFeeAccrualAtMs = now;

  // Price PnL via constant-product IL proxy (see file header caveat).
  const priceRatioNow = meme.priceUsd / sol.priceUsd;
  const xIsSol = live.mint_x === sol.address;
  const priceCtx: PriceRangeContext | null =
    currentBinId !== null ? { currentPriceInSol: priceRatioNow, currentBinId, binStep: live.bin_step, xIsSol } : null;
  const priceRatioEntry = position.entryMemePriceUsd / position.entrySolPriceUsd;
  const r = priceRatioNow / priceRatioEntry;
  const heldValueUsd =
    0.5 * position.capitalUsd * (sol.priceUsd / position.entrySolPriceUsd) +
    0.5 * position.capitalUsd * (meme.priceUsd / position.entryMemePriceUsd);
  const lpPrincipalUsd = heldValueUsd * ilMultiplier(r);
  const currentValueUsd = lpPrincipalUsd + position.feesEarnedUsd;

  const gasCostSol = estimateCycleGasCostSol(position.capitalUsd / sol.priceUsd);
  const gasCostUsd = gasCostSol * sol.priceUsd;
  const { decision, reasons } = evaluatePosition({
    initialDepositUsd: position.capitalUsd,
    currentValueUsd,
    rebalanceTimestamps: position.rebalanceTimestamps,
    volume1hNowUsd: live.volume1hUsd,
    volume1hBaselineUsd: position.volume1hBaselineUsd,
    unclaimedFeesUsd: position.feesEarnedUsd,
    estimatedGasCostUsd: gasCostUsd,
    isOutOfRange,
    outOfRangeSinceMs: position.outOfRangeSinceMs,
  });

  if (decision === 'HARD_EXIT') {
    const exitValueAfterCostUsd = Math.max(currentValueUsd - gasCostUsd, 0);
    logEvent({
      type: 'HARD_EXIT',
      pool: position.poolName,
      reasons,
      finalValueUsd: +exitValueAfterCostUsd.toFixed(2),
      exitCostUsd: +gasCostUsd.toFixed(2),
      capitalAtEntryUsd: +position.capitalUsd.toFixed(2),
      centerBinId: position.centerBinId,
      currentBinId,
      binsFromCenter,
    });
    addToBlacklist(blacklist, position.poolAddress, now);
    summary.hardExits++;
    const visit = summary.poolHistory[summary.poolHistory.length - 1];
    if (visit) {
      visit.exitedAtMs = now;
      visit.exitType = 'HARD_EXIT';
      visit.exitValueUsd = +exitValueAfterCostUsd.toFixed(2);
      visit.exitReasons = reasons;
    }
    idleCapitalUsd = exitValueAfterCostUsd;
    position = null;
    writeState(idleCapitalUsd);
    return;
  }

  if (decision === 'REBALANCE') {
    const cooldownActive = now - position.lastRebalanceAtMs < env.REBALANCE_COOLDOWN_MS;
    if (!env.ENABLE_AUTO_COMPOUND) {
      logEvent({ type: 'HOLD', pool: position.poolName, note: 'rebalance triggered but ENABLE_AUTO_COMPOUND=false', currentValueUsd: +currentValueUsd.toFixed(2), currentBinId, inRange });
    } else if (cooldownActive) {
      logEvent({ type: 'HOLD', pool: position.poolName, note: 'rebalance triggered but still in cooldown', currentValueUsd: +currentValueUsd.toFixed(2), currentBinId, inRange });
    } else {
      const compoundedToUsd = Math.max(currentValueUsd - gasCostUsd, 0);
      // Re-check the held pool against the full entry screen using the
      // SAME fresh `live` data already fetched this tick (no extra
      // request) — decides "reopen here" vs "leave for a fresh scan",
      // instead of blindly reopening in whatever pool we happened to be in.
      const stillEligible = (await filterAndRankPools([live], defaultScannerConfig(blacklist))).length > 0;
      const visit = summary.poolHistory[summary.poolHistory.length - 1];

      if (stillEligible) {
        logEvent({
          type: 'REBALANCE',
          pool: position.poolName,
          reasons,
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          compoundedToUsd: +compoundedToUsd.toFixed(2),
          feesClaimedUsd: +position.feesEarnedUsd.toFixed(2),
          rebalanceCostUsd: +gasCostUsd.toFixed(2),
          oldCenterBinId: position.centerBinId,
          newCenterBinId: currentBinId,
        });
        position.capitalUsd = compoundedToUsd;
        position.feesEarnedUsd = 0;
        position.entrySolPriceUsd = sol.priceUsd;
        position.entryMemePriceUsd = meme.priceUsd;
        position.volume1hBaselineUsd = live.volume1hUsd;
        position.rebalanceTimestamps.push(now);
        position.lastRebalanceAtMs = now;
        position.centerBinId = currentBinId; // reopening re-centers the range on the current active bin
        position.outOfRangeSinceMs = null;
        summary.rebalances++;
        if (visit) visit.rebalanceCount++;
      } else {
        // Pool no longer passes the entry screen (e.g. no longer trending)
        // — leave with the compounded capital instead of forcing a reopen
        // here. Not a violation, so no blacklist (unlike HARD_EXIT) — the
        // next tick's scan is free to reconsider it later if it recovers.
        logEvent({
          type: 'LEAVE_POOL',
          pool: position.poolName,
          reasons: [...reasons, 'pool no longer passes entry screen — leaving for a fresh scan instead of reopening'],
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          finalValueUsd: +compoundedToUsd.toFixed(2),
          feesClaimedUsd: +position.feesEarnedUsd.toFixed(2),
        });
        if (visit) {
          visit.exitedAtMs = now;
          visit.exitType = 'HARD_EXIT'; // reusing the report's exit-status field; distinguishable via jsonl LEAVE_POOL events
          visit.exitValueUsd = +compoundedToUsd.toFixed(2);
          visit.exitReasons = reasons;
        }
        idleCapitalUsd = compoundedToUsd;
        position = null;
      }
    }
  } else {
    logEvent({
      type: 'HOLD',
      pool: position.poolName,
      currentValueUsd: +currentValueUsd.toFixed(2),
      feesEarnedUsd: +position.feesEarnedUsd.toFixed(2),
      tvlUsd,
      priceRatioChangePct: +((r - 1) * 100).toFixed(2),
      centerBinId: position.centerBinId,
      currentBinId,
      binsFromCenter,
      inRange,
    });
  }

  writeState(position ? position.capitalUsd + position.feesEarnedUsd : idleCapitalUsd, currentBinId, priceCtx);
}

async function main(): Promise<void> {
  logEvent({
    type: 'SIM_START',
    label: summary.label,
    durationHours: DURATION_HOURS,
    initialLpCapitalSol: env.INITIAL_LP_CAPITAL_SOL,
    note: 'paper trading — no wallet, no real transactions',
  });

  while (Date.now() - runStartedAtMs < DURATION_MS) {
    try {
      await tick();
    } catch (err) {
      logEvent({ type: 'ERROR', error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  logEvent({ type: 'SIM_END', note: `${DURATION_HOURS}h simulation window elapsed` });
  logStream.end();
}

process.on('SIGINT', () => {
  logEvent({ type: 'SIM_INTERRUPTED', note: 'SIGINT received' });
  logStream.end();
  process.exit(0);
});

main().catch((err) => {
  logEvent({ type: 'FATAL', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
