/** Pure parsing/validation of the Claude agent's JSON answers. Every invalid answer fails closed (skip / hold). */

export type ScreenerDecision =
  | { action: 'skip'; reason: string }
  | { action: 'deploy'; pool: string; bins: number; conviction: number; reason: string };

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

export function parseScreenerDecision(text: string, allowedPools: ReadonlySet<string>, minBins: number, maxBins: number, minConviction: number): ScreenerDecision {
  const o = extractJson(text);
  if (!o) return { action: 'skip', reason: 'invalid answer: no JSON object' };
  if (o.action === 'skip') return { action: 'skip', reason: reasonOf(o) };
  if (o.action !== 'deploy') return { action: 'skip', reason: 'invalid answer: unknown action' };
  if (typeof o.pool !== 'string' || !allowedPools.has(o.pool)) return { action: 'skip', reason: 'invalid answer: pool is not an eligible candidate' };
  const conviction = Number(o.conviction);
  if (!Number.isFinite(conviction) || conviction < minConviction) return { action: 'skip', reason: `conviction ${String(o.conviction)} below ${minConviction}: ${reasonOf(o)}` };
  const binsRaw = Number(o.bins_below);
  if (!Number.isFinite(binsRaw)) return { action: 'skip', reason: 'invalid answer: bins_below missing' };
  const bins = Math.min(maxBins, Math.max(minBins, Math.round(binsRaw)));
  return { action: 'deploy', pool: o.pool, bins, conviction, reason: reasonOf(o) };
}

export function parseManagerDecision(text: string): ManagerDecision {
  const o = extractJson(text);
  if (!o) return { action: 'hold', reason: 'invalid answer: no JSON object (default hold)' };
  if (o.action === 'close') return { action: 'close', reason: reasonOf(o) };
  return { action: 'hold', reason: o.action === 'hold' ? reasonOf(o) : 'invalid answer (default hold)' };
}
