/**
 * Entry risk gates added after the Anakin-SOL stop loss (2026-11-02, -25.8%): a DexScreener boost of 500 with no website and no X account, entered 17% under the 4h high
 * with a volume spike of 0.22x and sells ahead of buys (buyRatio1h 0.386). All pure; every threshold is an env key (env.ts), 0 = rule off.
 * Unknown data never blocks (a missing boost / social / ratio / volume figure returns null): these rules need positive evidence of the risk.
 */

/** A paid boost on a token with no website AND no X account: visibility bought for something with nothing behind it. */
export function boostNoPresenceReject(boost: number | null | undefined, hasWebsite: boolean | undefined, hasX: boolean | undefined, minBoost: number): string | null {
  if (!(minBoost > 0)) return null;
  if (typeof boost !== 'number' || !Number.isFinite(boost) || boost < minBoost) return null;
  if (hasWebsite !== false || hasX !== false) return null; // unknown or present
  return `DexScreener boost ${boost} >= ${minBoost} with no website and no X account`;
}

/** Price more than `maxBelowPct` under its 4h high while the volume spike is under `minSpike`: a fading sell-off, not a dip with buyers returning. `dropPct` is signed (<= 0). */
export function dipFadingReject(dropPct: number | null | undefined, spike: number | null | undefined, maxBelowPct: number, minSpike: number): string | null {
  if (!(maxBelowPct > 0)) return null;
  if (typeof dropPct !== 'number' || !Number.isFinite(dropPct)) return null;
  if (typeof spike !== 'number' || !Number.isFinite(spike)) return null;
  const below = -dropPct;
  if (below > maxBelowPct && spike < minSpike) return `${below.toFixed(1)}% below the 4h high with volume spike ${spike.toFixed(2)}x < ${minSpike}x (fading sell-off)`;
  return null;
}

/** 1h sells per buy (DexScreener txn counts): above `maxSellBuy` the flow is sell-dominant. buyRatio1h = buys / (buys + sells). */
export function sellBuyReject(buyRatio1h: number | null | undefined, maxSellBuy: number): string | null {
  if (!(maxSellBuy > 0)) return null;
  if (typeof buyRatio1h !== 'number' || !Number.isFinite(buyRatio1h)) return null;
  const ratio = buyRatio1h <= 0 ? Infinity : (1 - buyRatio1h) / buyRatio1h;
  return ratio > maxSellBuy ? `sell:buy 1h ${ratio.toFixed(2)} > ${maxSellBuy}` : null;
}
