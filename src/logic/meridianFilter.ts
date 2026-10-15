/** Pool/token size window of the `meridian` entry mode (from yunus-0x/meridian's screening defaults). Pure, no I/O. */
export interface MeridianLimits {
  minMcapUsd: number;
  maxMcapUsd: number;
  minTvlUsd: number;
  maxTvlUsd: number;
  minBinStep: number;
  maxBinStep: number;
  minHolders: number;
}

export interface MeridianPoolFacts {
  tvlUsd: number;
  binStep: number;
  mcapUsd: number;
  holders: number;
}

/** Returns the reject reason, or null if the pool is inside the window. A non-finite fact fails closed. */
export function meridianPoolReject(p: MeridianPoolFacts, l: MeridianLimits): string | null {
  if (![p.tvlUsd, p.binStep, p.mcapUsd, p.holders].every(Number.isFinite)) return 'pool facts unknown (fail-closed)';
  if (p.mcapUsd < l.minMcapUsd || p.mcapUsd > l.maxMcapUsd) return `mcap $${Math.round(p.mcapUsd)} outside $${l.minMcapUsd}-$${l.maxMcapUsd}`;
  if (p.tvlUsd < l.minTvlUsd || p.tvlUsd > l.maxTvlUsd) return `TVL $${Math.round(p.tvlUsd)} outside $${l.minTvlUsd}-$${l.maxTvlUsd}`;
  if (p.binStep < l.minBinStep || p.binStep > l.maxBinStep) return `bin step ${p.binStep} outside ${l.minBinStep}-${l.maxBinStep}`;
  if (p.holders < l.minHolders) return `holders ${p.holders} < ${l.minHolders}`;
  return null;
}
