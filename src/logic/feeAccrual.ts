/**
 * Pro-rata TVL-share fee accrual for one paper-trade tick — ONLY while
 * CONFIRMED in-range (inRange === true). A real DLMM position earns zero
 * swap fees once price exits its bin range (one-sided, idle liquidity) —
 * see paperTrade.ts's file header caveat for the full fee-model writeup.
 * Fixed 2026-09-30: this used to accrue unconditionally regardless of
 * range status, silently cushioning paper-trade's reported drawdown during
 * exactly the stretches (price moving against the position, likely to go
 * out-of-range) that matter most for the go-live drawdown criterion.
 * inRange === null (bin lookup failed) also accrues nothing — can't
 * confirm we're actually earning, so don't assume we are.
 *
 * Split out from paperTrade.ts (not just kept as a private function there)
 * so it's importable for a self-check without triggering that script's
 * unguarded top-level side effects (starts a live simulation on import).
 */
export function computeFeeAccrual(capitalUsd: number, tvlUsd: number, fees24hUsd: number, elapsedHours: number, inRange: boolean | null): number {
  if (inRange !== true) return 0;
  const ourShare = capitalUsd / (tvlUsd + capitalUsd);
  return ourShare * fees24hUsd * (elapsedHours / 24);
}
