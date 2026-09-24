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
  poolRejectReasons,
  scanForBetterOpportunity,
  volumeSpikeRatio,
  type MeteoraPair,
} from '../services/meteoraScanner.js';
import { evaluatePosition, evaluateSwitchOpportunity, addToBlacklist } from '../logic/riskManager.js';
import { estimateCycleGasCostSol, estimateClaimCostSol } from '../logic/costEstimate.js';
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
  /** Highest unrealized profit % since entry/last-compound. Reset to 0 whenever capitalUsd/entrySolPriceUsd/entryMemePriceUsd reset (compound or switch) - unlike the real bot, paper-trade's profit basis DOES reset on every compound (position.capitalUsd = compoundedToUsd), so the peak must reset with it to stay consistent. */
  peakProfitPct: number;
}

interface PoolVisit {
  pool: string;
  address: string;
  enteredAtMs: number;
  entryCapitalUsd: number;
  entryCapitalSol: number;
  exitedAtMs?: number;
  /** HARD_EXIT = risk-triggered (stop-loss/rebalance-count/volume-drop). LEFT_POOL = pool no longer passes the entry screen, not a violation. TAKE_PROFIT = profit-protection exit. SWITCHED = opportunistic pool-switch exit. */
  exitType?: 'HARD_EXIT' | 'LEFT_POOL' | 'TAKE_PROFIT' | 'SWITCHED';
  exitValueUsd?: number;
  exitValueSol?: number;
  exitReasons?: string[];
  rebalanceCount: number;
}

interface RunSummary {
  label: string;
  startedAtMs: number;
  startingCapitalUsd: number | null;
  /** Constant — this is just env.INITIAL_LP_CAPITAL_SOL, the config value itself, not derived. */
  startingCapitalSol: number;
  poolsEntered: number;
  rebalances: number;
  hardExits: number;
  /** Fees claimed via the in-range claim-only path (net of claim cost) — cash outside the position, added into portfolio value. */
  harvestedFeesUsd: number;
  /** Cumulative fees earned across the whole run (gross, before claim/exit costs) — every claim, compound, and exit rolls its position.feesEarnedUsd in here before resetting/closing. Compare against pnlUsd to see how much of total PnL is fee income vs. price/IL. */
  totalFeesEarnedUsd: number;
  poolHistory: PoolVisit[];
}

let position: VirtualPosition | null = null;
let idleCapitalUsd = 0; // capital not currently in a position (between hard-exit and next entry)
let lastKnownSolPriceUsd = 0;
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;
const blacklist = new Map<string, number>();
const summary: RunSummary = {
  label: LABEL ?? 'default',
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

/** Total portfolio value = whatever's tied up right now + fees harvested-and-kept-as-cash so far. */
function portfolioValueUsd(baseUsd: number): number {
  return baseUsd + summary.harvestedFeesUsd;
}

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
        pid: process.pid, // lets paperTradeReport.ts tell a live run apart from an orphaned state file (process killed without cleaning up)
        elapsedHours: +(elapsedMs / 3_600_000).toFixed(2),
        durationHours: DURATION_HOURS,
        finished: elapsedMs >= DURATION_MS,
        currentValueUsd: +currentValueUsd.toFixed(2),
        currentValueSol: lastKnownSolPriceUsd > 0 ? +(currentValueUsd / lastKnownSolPriceUsd).toFixed(4) : null,
        // pnlUsd/pnlPct are total PnL WITH fees already baked in (currentValueUsd
        // already nets out price/IL + all fee effects) — totalFeesEarnedUsd (from
        // ...summary above) is the fees-only slice of that total, so
        // pnlUsd - totalFeesEarnedUsd isolates the price/IL-only component.
        pnlUsd: +pnlUsd.toFixed(2),
        pnlPct: +pnlPct.toFixed(2),
        totalFeesEarnedSol: lastKnownSolPriceUsd > 0 ? +(summary.totalFeesEarnedUsd / lastKnownSolPriceUsd).toFixed(4) : null,
        currentPosition: position
          ? {
              pool: position.poolName,
              address: position.poolAddress,
              capitalUsd: +position.capitalUsd.toFixed(2),
              capitalSol: lastKnownSolPriceUsd > 0 ? +(position.capitalUsd / lastKnownSolPriceUsd).toFixed(4) : null,
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

/** Entry mechanics for an already-chosen pool - shared by enterBestPool (fresh full-market pick) and the upcoming SWITCH path (a specific pre-validated candidate from scanForBetterOpportunity, no re-pick needed). */
async function enterPool(chosen: MeteoraPair): Promise<VirtualPosition | null> {
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
    peakProfitPct: 0,
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
    entryCostUsd: +entryCostUsd.toFixed(2),
    solPriceUsd: sol.priceUsd,
    memePriceUsd: meme.priceUsd,
    tvlUsd: Number(chosen.liquidity),
    vol24hUsd: chosen.trade_volume_24h,
    // Decision-context snapshot (2026-09-24) — without this, after-the-fact
    // "was this entry chasing an already-extended pump?" analysis has to
    // guess. See CLAUDE.md / SCREEN_RULE.MD for the P0-P4 tuning this fed into.
    priceChange1hPct: chosen.priceChange1hPct ?? null,
    priceChange6hPct: chosen.priceChange6hPct ?? null,
    priceChange24hPct: chosen.priceChange24hPct ?? null,
    volumeSpikeRatio: +volumeSpikeRatio(chosen).toFixed(3),
    buyRatio1h: chosen.buyRatio1h ?? null,
    centerBinId,
    binRange: centerBinId === null ? null : [centerBinId - computeBinRadius(chosen.bin_step), centerBinId + computeBinRadius(chosen.bin_step)],
  });
  return entered;
}

async function enterBestPool(pairs: MeteoraPair[]): Promise<VirtualPosition | null> {
  const candidates = await filterAndRankPools(pairs, defaultScannerConfig(blacklist));
  if (!candidates.length) {
    logEvent({ type: 'NO_CANDIDATE', note: 'no pool passes screen this tick' });
    return null;
  }
  return enterPool(candidates[0]!);
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
    writeState(portfolioValueUsd(entered ? entered.capitalUsd : idleCapitalUsd));
    return;
  }

  const live = pairs.find((p) => p.address === position!.poolAddress);
  if (!live) {
    logEvent({ type: 'STALE_POOL', pool: position.poolName, note: 'dropped out of top-200 volume window; holding last known value' });
    writeState(portfolioValueUsd(position.capitalUsd + position.feesEarnedUsd));
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
  // Default: nothing changes the position this tick, so the mark-to-market
  // value IS currentValueUsd (includes live price/IL — position.capitalUsd
  // is just the static entry/last-compound anchor and does NOT track price
  // movement between compounds; using it directly for the final
  // portfolio-value write silently drops IL until the next compound event).
  // Only the branches below that actually touch the position override this.
  let finalPositionValueUsd = currentValueUsd;

  const currentProfitPct = position.capitalUsd > 0 ? ((currentValueUsd - position.capitalUsd) / position.capitalUsd) * 100 : 0;
  position.peakProfitPct = Math.max(position.peakProfitPct, currentProfitPct);

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
    peakProfitPct: position.peakProfitPct,
  });

  if (decision === 'HARD_EXIT') {
    const exitValueAfterCostUsd = Math.max(currentValueUsd - gasCostUsd, 0);
    const exitValueAfterCostSol = exitValueAfterCostUsd / sol.priceUsd;
    logEvent({
      type: 'HARD_EXIT',
      pool: position.poolName,
      reasons,
      finalValueUsd: +exitValueAfterCostUsd.toFixed(2),
      finalValueSol: +exitValueAfterCostSol.toFixed(4),
      exitCostUsd: +gasCostUsd.toFixed(2),
      capitalAtEntryUsd: +position.capitalUsd.toFixed(2),
      capitalAtEntrySol: +(position.capitalUsd / sol.priceUsd).toFixed(4),
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
      visit.exitValueSol = +exitValueAfterCostSol.toFixed(4);
      visit.exitReasons = reasons;
    }
    summary.totalFeesEarnedUsd += position.feesEarnedUsd;
    idleCapitalUsd = exitValueAfterCostUsd;
    position = null;
    writeState(portfolioValueUsd(idleCapitalUsd));
    return;
  }

  if (decision === 'TAKE_PROFIT') {
    const exitValueAfterCostUsd = Math.max(currentValueUsd - gasCostUsd, 0);
    const exitValueAfterCostSol = exitValueAfterCostUsd / sol.priceUsd;
    logEvent({
      type: 'TAKE_PROFIT',
      pool: position.poolName,
      reasons,
      finalValueUsd: +exitValueAfterCostUsd.toFixed(2),
      finalValueSol: +exitValueAfterCostSol.toFixed(4),
      exitCostUsd: +gasCostUsd.toFixed(2),
      capitalAtEntryUsd: +position.capitalUsd.toFixed(2),
      capitalAtEntrySol: +(position.capitalUsd / sol.priceUsd).toFixed(4),
      peakProfitPct: +position.peakProfitPct.toFixed(2),
    });
    // No blacklist - profit-protection exit, not a violation. Matches LEAVE_POOL's policy.
    const visit = summary.poolHistory[summary.poolHistory.length - 1];
    if (visit) {
      visit.exitedAtMs = now;
      visit.exitType = 'TAKE_PROFIT';
      visit.exitValueUsd = +exitValueAfterCostUsd.toFixed(2);
      visit.exitValueSol = +exitValueAfterCostSol.toFixed(4);
      visit.exitReasons = reasons;
    }
    summary.totalFeesEarnedUsd += position.feesEarnedUsd;
    idleCapitalUsd = exitValueAfterCostUsd;
    position = null;
    writeState(portfolioValueUsd(idleCapitalUsd));
    return;
  }

  if (decision === 'REBALANCE') {
    const cooldownActive = now - position.lastRebalanceAtMs < env.REBALANCE_COOLDOWN_MS;
    if (!env.ENABLE_AUTO_COMPOUND) {
      logEvent({ type: 'HOLD', pool: position.poolName, note: 'rebalance triggered but ENABLE_AUTO_COMPOUND=false', currentValueUsd: +currentValueUsd.toFixed(2), currentBinId, inRange });
    } else if (cooldownActive) {
      logEvent({ type: 'HOLD', pool: position.poolName, note: 'rebalance triggered but still in cooldown', currentValueUsd: +currentValueUsd.toFixed(2), currentBinId, inRange });
    } else if (!isOutOfRange) {
      // Fee-threshold trigger while still in-range: just claim, don't
      // close/reopen — nothing about the range needs to change, and
      // closing would only crystallize unrealized price/IL PnL for no
      // reason. (Idle-forced REBALANCE only ever fires when isOutOfRange
      // is true, so this branch is unreachable for that case — it only
      // ever sees the fee-threshold trigger.)
      const claimCostUsd = estimateClaimCostSol() * sol.priceUsd;
      const netHarvestedUsd = Math.max(position.feesEarnedUsd - claimCostUsd, 0);
      logEvent({
        type: 'CLAIM_FEES',
        pool: position.poolName,
        reasons,
        feesClaimedUsd: +position.feesEarnedUsd.toFixed(2),
        feesClaimedSol: +(position.feesEarnedUsd / sol.priceUsd).toFixed(4),
        claimCostUsd: +claimCostUsd.toFixed(2),
        netHarvestedUsd: +netHarvestedUsd.toFixed(2),
        netHarvestedSol: +(netHarvestedUsd / sol.priceUsd).toFixed(4),
      });
      summary.harvestedFeesUsd += netHarvestedUsd;
      summary.totalFeesEarnedUsd += position.feesEarnedUsd;
      finalPositionValueUsd = currentValueUsd - position.feesEarnedUsd; // = lpPrincipalUsd — fees just moved out to harvestedFeesUsd
      position.feesEarnedUsd = 0;
      position.lastRebalanceAtMs = now; // respect cooldown before claiming again
    } else {
      const compoundedToUsd = Math.max(currentValueUsd - gasCostUsd, 0);
      // Re-check the held pool against the entry screen using the SAME
      // fresh `live` data already fetched this tick (no extra request) —
      // decides "reopen here" vs "leave for a fresh scan". Skips the
      // capital-sizing checks (TVL ceiling/vol-TVL-ratio/mcap ceiling) —
      // this is a "should I keep holding" decision; a pool that simply
      // grew past those ceilings succeeded, it didn't go bad. See
      // FilterOpts in meteoraScanner.ts.
      const reScreenOpts = { skipSizingChecks: true };
      const stillEligible = (await filterAndRankPools([live], defaultScannerConfig(blacklist), reScreenOpts)).length > 0;
      const visit = summary.poolHistory[summary.poolHistory.length - 1];

      if (stillEligible) {
        logEvent({
          type: 'REBALANCE',
          pool: position.poolName,
          reasons,
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          compoundedFromSol: +(position.capitalUsd / sol.priceUsd).toFixed(4),
          compoundedToUsd: +compoundedToUsd.toFixed(2),
          compoundedToSol: +(compoundedToUsd / sol.priceUsd).toFixed(4),
          feesClaimedUsd: +position.feesEarnedUsd.toFixed(2),
          feesClaimedSol: +(position.feesEarnedUsd / sol.priceUsd).toFixed(4),
          rebalanceCostUsd: +gasCostUsd.toFixed(2),
          oldCenterBinId: position.centerBinId,
          newCenterBinId: currentBinId,
        });
        summary.totalFeesEarnedUsd += position.feesEarnedUsd;
        position.capitalUsd = compoundedToUsd;
        position.feesEarnedUsd = 0;
        finalPositionValueUsd = compoundedToUsd;
        position.entrySolPriceUsd = sol.priceUsd;
        position.entryMemePriceUsd = meme.priceUsd;
        position.peakProfitPct = 0;
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
        const rejectReasons = poolRejectReasons(live, defaultScannerConfig(blacklist), reScreenOpts);
        const leaveReasons = [...reasons, 'pool no longer passes entry screen — leaving for a fresh scan instead of reopening', ...rejectReasons];
        logEvent({
          type: 'LEAVE_POOL',
          pool: position.poolName,
          reasons: leaveReasons,
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          compoundedFromSol: +(position.capitalUsd / sol.priceUsd).toFixed(4),
          finalValueUsd: +compoundedToUsd.toFixed(2),
          finalValueSol: +(compoundedToUsd / sol.priceUsd).toFixed(4),
          feesClaimedUsd: +position.feesEarnedUsd.toFixed(2),
          feesClaimedSol: +(position.feesEarnedUsd / sol.priceUsd).toFixed(4),
        });
        if (visit) {
          visit.exitedAtMs = now;
          visit.exitType = 'LEFT_POOL';
          visit.exitValueUsd = +compoundedToUsd.toFixed(2);
          visit.exitValueSol = +(compoundedToUsd / sol.priceUsd).toFixed(4);
          visit.exitReasons = leaveReasons;
        }
        summary.totalFeesEarnedUsd += position.feesEarnedUsd;
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

  if (position && decision !== 'REBALANCE') {
    const opportunityNow = Date.now();
    if (opportunityNow - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
      lastOpportunityScanAtMs = opportunityNow;
      const scanResult = await scanForBetterOpportunity(position.poolAddress, defaultScannerConfig(blacklist));
      const currentProfitPctForSwitch = position.capitalUsd > 0 ? ((finalPositionValueUsd - position.capitalUsd) / position.capitalUsd) * 100 : 0;
      const switchEval = evaluateSwitchOpportunity(
        {
          currentProfitPct: currentProfitPctForSwitch,
          currentSpikeRatio: scanResult.currentSpikeRatio,
          candidateSpikeRatio: scanResult.candidateSpikeRatio,
          hasCandidate: scanResult.candidate !== null,
          lastSwitchAtMs,
          currentPriceTrendPct: scanResult.currentPriceTrendPct,
          candidateBuyRatio1h: scanResult.candidateBuyRatio1h,
        },
        opportunityNow,
      );
      if (switchEval.shouldSwitch && scanResult.candidate) {
        const candidate = scanResult.candidate;
        const switchExitValueUsd = Math.max(finalPositionValueUsd - gasCostUsd, 0);
        logEvent({
          type: 'SWITCH',
          fromPool: position.poolName,
          toPool: candidate.name,
          reason: switchEval.reason,
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          compoundedFromSol: +(position.capitalUsd / sol.priceUsd).toFixed(4),
          exitValueUsd: +switchExitValueUsd.toFixed(2),
          exitValueSol: +(switchExitValueUsd / sol.priceUsd).toFixed(4),
          exitCostUsd: +gasCostUsd.toFixed(2),
          // Structured decision-context (2026-09-24), same reasoning as
          // enterPool's log — `reason` already has these as text but not
          // machine-parseable for later analysis.
          currentSpikeRatio: +scanResult.currentSpikeRatio.toFixed(3),
          candidateSpikeRatio: +scanResult.candidateSpikeRatio.toFixed(3),
          currentPriceTrendPct: scanResult.currentPriceTrendPct ?? null,
          candidateBuyRatio1h: scanResult.candidateBuyRatio1h ?? null,
        });
        const visit = summary.poolHistory[summary.poolHistory.length - 1];
        if (visit) {
          visit.exitedAtMs = opportunityNow;
          visit.exitType = 'SWITCHED';
          visit.exitValueUsd = +switchExitValueUsd.toFixed(2);
          visit.exitValueSol = +(switchExitValueUsd / sol.priceUsd).toFixed(4);
          visit.exitReasons = [switchEval.reason];
        }
        summary.totalFeesEarnedUsd += position.feesEarnedUsd;
        idleCapitalUsd = switchExitValueUsd;
        position = null;
        const entered = await enterPool(candidate);
        if (entered) lastSwitchAtMs = opportunityNow;
        writeState(portfolioValueUsd(entered ? entered.capitalUsd : idleCapitalUsd));
        return;
      }
      // Log every opportunity-scan tick, not just the ones that switch —
      // previously silent on HOLD, so there was no way to tell from the
      // event log whether the scan ran and declined (and why: no
      // candidate? blocked by a guard? cooldown?) or hadn't run at all.
      // Mirrors index.ts's logger.info('[index] opportunity scan', ...),
      // which already logged unconditionally.
      logEvent({
        type: 'OPPORTUNITY_SCAN',
        pool: position.poolName,
        decision: 'HOLD', // SWITCH outcome returns early above with its own 'SWITCH' event — reaching here means holding
        reason: switchEval.reason,
        currentSpikeRatio: +scanResult.currentSpikeRatio.toFixed(3),
        candidateSpikeRatio: +scanResult.candidateSpikeRatio.toFixed(3),
        currentPriceTrendPct: scanResult.currentPriceTrendPct ?? null,
        candidateBuyRatio1h: scanResult.candidateBuyRatio1h ?? null,
        candidate: scanResult.candidate?.name ?? null,
      });
    }
  }

  writeState(portfolioValueUsd(position ? finalPositionValueUsd : idleCapitalUsd), currentBinId, priceCtx);
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
