/**
 * Entry hard skips (not cautions): two patterns that the AI used to weigh away (Moustache-SOL 2026-10-25: -67% in 24h, volume spike 0.07x,
 * early buyers all sold, KOLs net selling -> deployed anyway, mcap fell below 100k). Pure; unknown data never blocks (only a proven pattern does).
 */
export interface FallingKnifeLimits {
  /** reject when the 24h price change is at or below -this percent; 0 = off */
  minDrop24hPct: number;
  /** ...AND the 1h volume pace vs the preceding hours (volumeSpikeRatio) is below this */
  maxSpikeRatio: number;
}

/** Rule 1: price down more than `minDrop24hPct` in 24h AND volume not accelerating (spike < `maxSpikeRatio`): a dead-cat bounce, not a base. */
export function fallingKnifeReject(chg24hPct: number | null | undefined, spikeRatio: number, l: FallingKnifeLimits): string | null {
  if (l.minDrop24hPct <= 0 || typeof chg24hPct !== 'number' || !Number.isFinite(chg24hPct) || !Number.isFinite(spikeRatio)) return null;
  if (chg24hPct <= -l.minDrop24hPct && spikeRatio < l.maxSpikeRatio) {
    return `falling knife: 24h ${chg24hPct.toFixed(1)}% <= -${l.minDrop24hPct}% and volume spike ${spikeRatio.toFixed(2)}x < ${l.maxSpikeRatio}x`;
  }
  return null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * Rule 2 on a MadeOnSol summary (services/madeonSol.ts summarizeToken): KOLs net distributing (net flow < 0 and more selling than buying KOLs)
 * AND every early buyer already sold (cohort > 0, none still holding). Missing/unavailable intel -> null (neutral, as the prompt says).
 */
export function distributionReject(intel: Record<string, unknown> | null | undefined): string | null {
  if (!intel) return null;
  const kols = rec(intel.kols);
  const net = num(kols.net_flow_sol);
  const selling = num(kols.selling_kols);
  const buying = num(kols.buying_kols);
  if (net === null || selling === null || buying === null || !(net < 0 && selling > buying)) return null;
  const eb = rec(intel.earlyBuyers);
  const cohort = num(eb.cohort);
  const holding = num(eb.still_holding);
  const holdingPct = num(eb.still_holding_pct);
  const allSold = cohort !== null && cohort > 0 && (holding === 0 || (holding === null && holdingPct === 0));
  if (!allSold) return null;
  return `distribution: KOLs net selling (${net.toFixed(1)} SOL, ${selling} sellers vs ${buying} buyers) and all ${cohort} early buyers already sold`;
}

/**
 * Rule 3 (hard skip): the 1h volume pace vs the preceding hours (volumeSpikeRatio) is under `minRatio`: the pool is going quiet, so a SOL-only ladder just sits
 * below a price that drifts away (PURR 2026-10-30: spike 0.025, ladder out of range within minutes, fees ~0). Unknown (null) never blocks; minRatio <= 0 = off.
 */
export function lowVolumeSpikeReject(spikeRatio: number | null | undefined, minRatio: number): string | null {
  if (minRatio <= 0 || typeof spikeRatio !== 'number' || !Number.isFinite(spikeRatio)) return null;
  return spikeRatio < minRatio ? `low volume spike: ${spikeRatio.toFixed(2)}x < ${minRatio}x (volume pace fading)` : null;
}

/**
 * Re-entry cooldown after an exit while the price was ABOVE the ladder (out of range above / pumped far above range): milliseconds to keep the pool blacklisted
 * from `nowMs`, never shortening an existing longer blacklist. 0 = nothing to add (disabled or an existing blacklist already outlasts it).
 */
export function reentryCooldownMs(existingUntilMs: number | undefined, nowMs: number, minutes: number): number {
  if (!(minutes > 0)) return 0;
  const ms = minutes * 60_000;
  return typeof existingUntilMs === 'number' && existingUntilMs - nowMs >= ms ? 0 : ms;
}
