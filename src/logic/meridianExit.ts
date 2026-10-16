import axios from 'axios';

/**
 * Meridian's deterministic close rules (yunus-0x/meridian index.js getDeterministicCloseRule + state.js updatePnlAndCheckExits),
 * applied in the same order. Stop loss stays our own STOP_LOSS_PCT and is handled by the caller (HARD_EXIT path).
 * Meridian defaults: takeProfit 5%, trailing trigger 3% / drop 1.5%, pumped-above 10 bins, OOR 30 min, min fee/TVL 7% after 60 min.
 */
export interface MeridianExitInput {
  pnlPct: number;
  peakPnlPct: number;
  /** bins the active bin is above the ladder in PRICE terms (<= 0 = inside or below) */
  binsAbove: number;
  isOutOfRange: boolean;
  minutesOutOfRange: number | null;
  /** Meteora pool fee/TVL over 24h, percent; null = unknown (rule skipped) */
  feePerTvl24hPct: number | null;
  ageMinutes: number | null;
}

export interface MeridianExitConfig {
  takeProfitPct: number;
  trailingTriggerPct: number;
  trailingDropPct: number;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes: number;
  minFeePerTvl24hPct: number;
  minAgeBeforeYieldCheckMin: number;
}

export function meridianExitSignal(i: MeridianExitInput, c: MeridianExitConfig): string | null {
  if (i.pnlPct >= c.takeProfitPct) return `take profit: PnL ${i.pnlPct.toFixed(2)}% >= ${c.takeProfitPct}%`;
  if (i.peakPnlPct >= c.trailingTriggerPct && i.peakPnlPct - i.pnlPct >= c.trailingDropPct) {
    return `trailing TP: peak ${i.peakPnlPct.toFixed(2)}% -> ${i.pnlPct.toFixed(2)}% (dropped >= ${c.trailingDropPct}%)`;
  }
  if (i.binsAbove > c.outOfRangeBinsToClose) return `pumped far above range: ${i.binsAbove} bins > ${c.outOfRangeBinsToClose}`;
  if (i.isOutOfRange && (i.minutesOutOfRange ?? 0) >= c.outOfRangeWaitMinutes) return `out of range ${Math.floor(i.minutesOutOfRange ?? 0)}m >= ${c.outOfRangeWaitMinutes}m`;
  if (i.feePerTvl24hPct !== null && i.feePerTvl24hPct < c.minFeePerTvl24hPct && (i.ageMinutes ?? 0) >= c.minAgeBeforeYieldCheckMin) {
    return `low yield: fee/TVL ${i.feePerTvl24hPct.toFixed(2)}% < ${c.minFeePerTvl24hPct}%`;
  }
  return null;
}

/** OOR wait: token_spot is closed fast if price never reaches the range, with more patience once it has been in range. */
export function oorWaitMinutes(tokenSpot: boolean, reachedRange: boolean, c: { standard: number; spotFirst: number; spotAfterReach: number }): number {
  if (!tokenSpot) return c.standard;
  return reachedRange ? c.spotAfterReach : c.spotFirst;
}

/** Meridian confirms an exit over consecutive polls so one noisy tick cannot close a position. */
export class ExitConfirmer {
  private key: string | null = null;
  private count = 0;
  /** returns true once the same signal kind has been seen `ticks` times in a row; a null signal resets */
  hit(signal: string | null, ticks: number): boolean {
    if (!signal) {
      this.key = null;
      this.count = 0;
      return false;
    }
    const kind = signal.split(':')[0]!;
    this.count = kind === this.key ? this.count + 1 : 1;
    this.key = kind;
    if (this.count >= ticks) {
      this.key = null;
      this.count = 0;
      return true;
    }
    return false;
  }
}

const feeCache = new Map<string, { at: number; v: number | null }>();

/** Pool fee/TVL 24h in percent from Meteora's own API (cached 5 min); null on any failure. */
export async function getPoolFeeTvl24hPct(pool: string, nowMs = Date.now()): Promise<number | null> {
  const hit = feeCache.get(pool);
  if (hit && nowMs - hit.at < 300_000) return hit.v;
  let v: number | null = null;
  try {
    const r = await axios.get<{ fee_tvl_ratio?: { '24h'?: number } }>(`https://dlmm.datapi.meteora.ag/pools/${pool}`, { timeout: 10_000 });
    const x = r.data?.fee_tvl_ratio?.['24h'];
    v = typeof x === 'number' && Number.isFinite(x) ? x : null;
  } catch {
    v = null;
  }
  feeCache.set(pool, { at: nowMs, v });
  return v;
}
