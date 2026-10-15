/** Holder/bot/fee facts for a token (Jupiter datapi `assets/search`, keyless). Null field = the API did not report it. */
export interface TokenAudit {
  topHoldersPct: number | null;
  botHoldersPct: number | null;
  globalFeesSol: number | null;
  organicScore: number | null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Parse one asset object from `datapi.jup.ag/v1/assets/search`. null = not a usable asset. */
export function parseTokenAudit(asset: unknown): TokenAudit | null {
  if (!asset || typeof asset !== 'object') return null;
  const a = asset as { fees?: unknown; organicScore?: unknown; audit?: { topHoldersPercentage?: unknown; botHoldersPercentage?: unknown } };
  return { topHoldersPct: num(a.audit?.topHoldersPercentage), botHoldersPct: num(a.audit?.botHoldersPercentage), globalFeesSol: num(a.fees), organicScore: num(a.organicScore) };
}

export interface AuditLimits {
  maxTopHoldersPct: number;
  maxBotHoldersPct: number;
  minGlobalFeesSol: number;
  /** 0/undefined = off */
  minOrganicScore?: number;
}

/** Entry gate: returns the reject reason, or null if the token passes. A limit <= 0 (or max >= 100) disables that check; a missing value on an enabled check fails closed. */
export function auditRejectReason(a: TokenAudit, l: AuditLimits): string | null {
  const check = (v: number | null, name: string, bad: (x: number) => boolean, limit: string): string | null =>
    v === null ? `${name} unknown (fail-closed)` : bad(v) ? `${name} ${v.toFixed(1)} ${limit}` : null;
  return (
    (l.maxTopHoldersPct > 0 && l.maxTopHoldersPct < 100 ? check(a.topHoldersPct, 'top holders %', (x) => x > l.maxTopHoldersPct, `> max ${l.maxTopHoldersPct}`) : null) ??
    (l.maxBotHoldersPct > 0 && l.maxBotHoldersPct < 100 ? check(a.botHoldersPct, 'bot holders %', (x) => x > l.maxBotHoldersPct, `> max ${l.maxBotHoldersPct}`) : null) ??
    (l.minGlobalFeesSol > 0 ? check(a.globalFeesSol, 'global fees SOL', (x) => x < l.minGlobalFeesSol, `< min ${l.minGlobalFeesSol}`) : null) ??
    (l.minOrganicScore && l.minOrganicScore > 0 ? check(a.organicScore, 'organic score', (x) => x < l.minOrganicScore!, `< min ${l.minOrganicScore}`) : null)
  );
}
