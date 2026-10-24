import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getPoolStats } from '../logic/meridianExit.js';
import { advanceSim, canOpenSim, openSim, type SimParams, type SimPosition } from '../logic/shadowSim.js';
import { fetchCandles5m, type LoggedShadowDecision } from './shadowLog.js';
import { appendSimLine, loadOpenSims, readSimLines, saveOpenSims } from './shadowSimStore.js';
import { slCooldownActive } from '../logic/shadowSimReport.js';

/**
 * One simulation cycle for the shadow runner (see logic/shadowSim.ts for the model): open one paper position per fresh shadow decision (no second one
 * in a pool that still has an open one), then advance every open position over the 5m candles that closed since its last step and log entries/exits.
 * Reads Meteora (OHLCV, pool stats) only; no wallet, no transaction. Never throws.
 */
export function simParamsFromEnv(): SimParams {
  return {
    capitalSol: env.SHADOW_SIM_CAPITAL_SOL,
    ladderBins: env.LADDER_BINS,
    targetRangePct: env.TARGET_RANGE_PCT,
    minRadius: env.MIN_BIN_RADIUS,
    maxRadius: env.MAX_BIN_RADIUS,
    slPct: env.STOP_LOSS_PCT,
    exit: {
      takeProfitPct: env.MERIDIAN_TAKE_PROFIT_PCT,
      trailingTriggerPct: env.MERIDIAN_TRAILING_TRIGGER_PCT,
      trailingDropPct: env.MERIDIAN_TRAILING_DROP_PCT,
      outOfRangeBinsToClose: env.MERIDIAN_OOR_BINS_TO_CLOSE,
      outOfRangeWaitMinutes: env.MERIDIAN_OOR_WAIT_MIN,
      minFeePerTvl24hPct: env.MERIDIAN_MIN_FEE_TVL_24H_PCT,
      minAgeBeforeYieldCheckMin: env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN,
    },
    trailingFloorPct: env.TRAILING_MIN_PNL_PCT,
    flipOorAboveMin: env.FLIP_OOR_ABOVE_EXIT_MIN,
    flipTvlCollapsePct: env.FLIP_TVL_COLLAPSE_PCT,
    exitCostPct: env.EXIT_COST_PCT,
    exitCostGasSol: env.EXIT_COST_GAS_SOL,
    feeFactor: env.SHADOW_SIM_FEE_FACTOR,
    maxHours: env.SHADOW_SIM_MAX_HOURS,
  };
}

export interface SimCandidate {
  pool: string;
  name: string | null;
  mint: string;
  binStep: number;
  solPriceUsd: number | null;
  decision: LoggedShadowDecision;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function runSimCycle(cands: SimCandidate[], nowMs = Date.now()): Promise<{ opened: number; closed: number; open: number }> {
  if (!env.SHADOW_SIM_ENABLED) return { opened: 0, closed: 0, open: 0 };
  let opened = 0;
  let closed = 0;
  let open: SimPosition[] = [];
  try {
    const p = simParamsFromEnv();
    open = loadOpenSims();
    const exitLines = env.SL_POOL_COOLDOWN_HOURS > 0 ? readSimLines().filter((l) => l.type === 'sim_exit') : [];
    for (const c of cands) {
      const d = c.decision;
      const price = d.inputs?.lastClose;
      if (d.mode === 'unknown' || !price || d.lastCandleTs === null) continue;
      if (slCooldownActive(exitLines, c.pool, nowMs, env.SL_POOL_COOLDOWN_HOURS)) continue; // same stop-loss pool cooldown as the live bot
      const modes: ('A' | 'B')[] = env.SHADOW_SIM_PAIRED ? ['A', 'B'] : [d.mode];
      // a pair opens whole or not at all (room for both, none of them open in this pool), so A vs B always compares the same decision
      const room = env.SHADOW_SIM_PAIRED ? env.SHADOW_SIM_MAX_OPEN - 1 : env.SHADOW_SIM_MAX_OPEN;
      if (!modes.every((m) => canOpenSim(open, c.pool, room, env.SHADOW_SIM_PAIRED ? m : undefined))) continue;
      const stats = await getPoolStats(c.pool);
      for (const mode of modes) {
        const chosen = mode === d.mode;
        const pos = openSim(
          { id: `sim:${d.id}:${mode}`, decisionId: d.id, mode, chosen, pool: c.pool, name: c.name, mint: c.mint, binStep: c.binStep, solPriceUsd: c.solPriceUsd, entryTs: Math.floor(d.ts / 1000), lastTs: d.lastCandleTs, entryPrice: price, feeTvl24hPct: stats.feeTvl24hPct },
          p,
        );
        open.push(pos);
        opened++;
        appendSimLine({ type: 'sim_entry', id: pos.id, decisionId: d.id, ts: iso(d.ts), pool: c.pool, name: c.name, mode, chosen, paired: env.SHADOW_SIM_PAIRED, price, capitalSol: p.capitalSol, binStep: c.binStep, rangeBins: [pos.lo, pos.hi], feeTvl24hPct: stats.feeTvl24hPct, solPriceUsd: c.solPriceUsd });
      }
    }
    const still: SimPosition[] = [];
    for (const pos of open) {
      try {
        const hours = Math.ceil((nowMs / 1000 - pos.lastTs) / 3600) + 1;
        // only candles that have CLOSED: the one in progress has a moving close
        const candles = (await fetchCandles5m(pos.pool, env.SHADOW_FETCH_TIMEOUT_MS, hours)).filter((c) => c.timestamp + 300 <= nowMs / 1000);
        const stats = await getPoolStats(pos.pool);
        const r = advanceSim(pos, candles, { tvlUsd: stats.tvlUsd, feeTvl24hPct: stats.feeTvl24hPct }, p);
        if (r.flipped) logger.info('[shadowSim] flipped', { pool: pos.pool, name: pos.name });
        if (r.exit) {
          closed++;
          const e = r.exit;
          appendSimLine({ type: 'sim_exit', id: pos.id, ts: iso(e.ts * 1000), pool: pos.pool, name: pos.name, mode: pos.mode, chosen: pos.chosen !== false, price: e.price, reason: e.reason, pnlSol: +e.pnlSol.toFixed(5), pnlUsd: e.pnlUsd === null ? null : +e.pnlUsd.toFixed(2), pnlPct: +e.pnlPct.toFixed(2), valueSol: +e.valueSol.toFixed(5), feesSol: +e.feesSol.toFixed(5), minutesHeld: Math.round(e.minutesHeld), flipped: e.flipped });
        } else still.push(r.pos);
      } catch (err) {
        still.push(pos); // retried next cycle
        logger.warn('[shadowSim] step skipped', { pool: pos.pool, error: err instanceof Error ? err.message : String(err) });
      }
    }
    open = still;
    saveOpenSims(open);
  } catch (err) {
    logger.warn('[shadowSim] cycle failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return { opened, closed, open: open.length };
}
