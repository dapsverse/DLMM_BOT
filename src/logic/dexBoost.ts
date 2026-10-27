/**
 * DexScreener paid boosts (the lightning/flame icon). A boost is bought by the dev or a promoter, so on a young token it is a risk context for the
 * AI screener (often seen right before a pump-and-dump / exit liquidity), never a hard filter. The token pairs DexScreener already returns for the
 * volume/price hydration carry `boosts.active` when a boost is running, so this costs no extra request. Pure.
 */
export interface BoostPair {
  boosts?: { active?: number };
}

/** Highest active boost over the token's pairs: 0 = hydrated and no boost, undefined = no pair data at all (unknown, never 0). */
export function activeBoosts(pairs: BoostPair[] | undefined): number | undefined {
  if (!pairs?.length) return undefined;
  let max = 0;
  for (const p of pairs) {
    const a = p.boosts?.active;
    if (typeof a === 'number' && Number.isFinite(a) && a > max) max = a;
  }
  return max;
}
