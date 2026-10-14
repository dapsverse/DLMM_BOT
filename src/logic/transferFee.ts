/**
 * Token-2022 transfer fee (basis points) from a parsed mint account (`getParsedAccountInfo(...).value.data.parsed.info`).
 * Every token transfer (swap leg, LP deposit, LP withdraw) loses this share, so a round trip costs several times it
 * (MASK 2026-10-14: 3% fee, -12% on the token half of a flat-ish cycle).
 * 0 = no fee extension. Takes the larger of the older/newer config (the newer one only applies from its epoch on).
 * null = unparseable (caller treats as unknown -> fail-closed).
 */
export function transferFeeBps(mintInfo: unknown): number | null {
  if (!mintInfo || typeof mintInfo !== 'object') return null;
  const ext = (mintInfo as { extensions?: unknown }).extensions;
  if (ext === undefined) return 0;
  if (!Array.isArray(ext)) return null;
  const cfg = ext.find((e) => (e as { extension?: string })?.extension === 'transferFeeConfig') as
    | { state?: { olderTransferFee?: { transferFeeBasisPoints?: number }; newerTransferFee?: { transferFeeBasisPoints?: number } } }
    | undefined;
  if (!cfg) return 0;
  const bps = [cfg.state?.olderTransferFee?.transferFeeBasisPoints, cfg.state?.newerTransferFee?.transferFeeBasisPoints].filter(
    (b): b is number => typeof b === 'number' && Number.isFinite(b),
  );
  return bps.length > 0 ? Math.max(...bps) : null;
}
