/** Pure parsing/validation of the Claude agent's JSON answers. Every invalid answer fails closed (skip / hold). */

export type ScreenerDecision =
  | { action: 'skip'; reason: string; conviction?: number }
  | { action: 'deploy'; pool: string; bins: number; conviction: number; reason: string; strategy: Strategy };

/** sol_ladder: SOL-only bid-ask below the price (default). token_spot: 100% token, spot distribution above the price. */
export type Strategy = 'sol_ladder' | 'token_spot';
/** token_spot needs a high bounce conviction and may use a narrower range; anything below that is a skip (fail closed). */
export interface SpotRules {
  minConviction: number;
  minBins: number;
}
export const parseStrategy = (v: unknown): Strategy => (v === 'token_spot' ? 'token_spot' : 'sol_ladder');

export type ManagerDecision = { action: 'hold' | 'close'; reason: string };

/** First balanced top-level JSON object in free text (Claude may wrap it in prose or a code fence). */
export function extractJson(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          /* try the next '{' */
        }
        break;
      }
    }
  }
  return null;
}

const reasonOf = (o: Record<string, unknown>): string => (typeof o.reason === 'string' ? o.reason.slice(0, 600) : '(no reason given)');

export function parseScreenerDecision(text: string, allowedPools: ReadonlySet<string>, minBins: number, maxBins: number, minConviction: number, spot?: SpotRules): ScreenerDecision {
  const o = extractJson(text);
  if (!o) return { action: 'skip', reason: 'invalid answer: no JSON object' };
  const rawConv = Number(o.conviction);
  const convOpt = Number.isFinite(rawConv) ? { conviction: rawConv } : {};
  if (o.action === 'skip') return { action: 'skip', reason: reasonOf(o), ...convOpt };
  if (o.action !== 'deploy') return { action: 'skip', reason: 'invalid answer: unknown action' };
  if (typeof o.pool !== 'string' || !allowedPools.has(o.pool)) return { action: 'skip', reason: 'invalid answer: pool is not an eligible candidate' };
  const conviction = Number(o.conviction);
  if (!Number.isFinite(conviction) || conviction < minConviction) return { action: 'skip', reason: `conviction ${String(o.conviction)} below ${minConviction}: ${reasonOf(o)}`, ...convOpt };
  const binsRaw = Number(o.bins_below);
  if (!Number.isFinite(binsRaw)) return { action: 'skip', reason: 'invalid answer: bins_below missing' };
  const strategy = parseStrategy(o.strategy);
  if (strategy === 'token_spot' && spot && conviction < spot.minConviction) return { action: 'skip', reason: `token_spot needs conviction >= ${spot.minConviction}, got ${conviction}: ${reasonOf(o)}`, ...convOpt };
  const bins = Math.min(maxBins, Math.max(strategy === 'token_spot' && spot ? spot.minBins : minBins, Math.round(binsRaw)));
  return { action: 'deploy', pool: o.pool, bins, conviction, reason: reasonOf(o), strategy };
}

export function parseManagerDecision(text: string): ManagerDecision {
  const o = extractJson(text);
  if (!o) return { action: 'hold', reason: 'invalid answer: no JSON object (default hold)' };
  if (o.action === 'close') return { action: 'close', reason: reasonOf(o) };
  return { action: 'hold', reason: o.action === 'hold' ? reasonOf(o) : 'invalid answer (default hold)' };
}
