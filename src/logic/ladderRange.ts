/**
 * Geometry of the SOL-only ladder (see buildLadderTx): `centerBinId` is the active bin at open time.
 * SOL is token Y: bins [center-(n-1), center]; SOL is token X: [center, center+(n-1)] (a falling token price raises the bin id there).
 */
export function ladderBounds(centerBinId: number, bins: number, xIsSol: boolean): { lo: number; hi: number } {
  return xIsSol ? { lo: centerBinId, hi: centerBinId + bins - 1 } : { lo: centerBinId - (bins - 1), hi: centerBinId };
}

export interface LadderRangeStatus {
  isOutOfRange: boolean;
  /** price fell through the whole ladder: the position is all token */
  tokenBelowRange: boolean;
}

export function ladderRangeStatus(activeBinId: number, centerBinId: number | null, bins: number, xIsSol: boolean): LadderRangeStatus {
  if (centerBinId === null) return { isOutOfRange: true, tokenBelowRange: false };
  const { lo, hi } = ladderBounds(centerBinId, bins, xIsSol);
  const isOutOfRange = activeBinId < lo || activeBinId > hi;
  const fellThrough = xIsSol ? activeBinId > hi : activeBinId < lo;
  return { isOutOfRange, tokenBelowRange: isOutOfRange && fellThrough };
}
