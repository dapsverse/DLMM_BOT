import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface XPost { text: string; author: string | null; engagement: number; ageMin: number | null }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ENG_KEYS = ['favorite_count', 'favorites', 'like_count', 'retweet_count', 'retweets', 'reply_count', 'replies', 'quote_count', 'quotes'];

/** Pure: collect post-like objects from ANY RapidAPI Twitter response shape (nested or flat); never throws. */
export function extractPosts(raw: unknown, nowMs: number): XPost[] {
  const out = new Map<string, XPost>();
  const walk = (o: unknown, depth: number): void => {
    if (depth > 12 || o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    const r = o as Record<string, unknown>;
    const text = typeof r.full_text === 'string' ? r.full_text : typeof r.text === 'string' ? r.text : '';
    if (text && (ENG_KEYS.some((k) => k in r) || 'created_at' in r)) {
      const t = text.replace(/\s+/g, ' ').trim();
      const u = (r.user ?? r.author ?? r.user_info) as Record<string, unknown> | undefined;
      const a = r.screen_name ?? u?.screen_name ?? u?.username;
      const ts = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
      if (t && !out.has(t)) out.set(t, { text: t, author: typeof a === 'string' ? a : null, engagement: ENG_KEYS.reduce((s, k) => s + num(r[k]), 0), ageMin: Number.isFinite(ts) ? Math.max(0, Math.round((nowMs - ts) / 60_000)) : null });
    }
    for (const v of Object.values(r)) walk(v, depth + 1);
  };
  walk(raw, 0);
  return [...out.values()];
}

/** Pure: short summary for the prompt (counts, engagement, accounts, age, 3 sample texts); null when there are no posts. All text is untrusted. */
export function summarizeX(byTicker: XPost[], byMint: XPost[]): Record<string, unknown> | null {
  const seen = new Map<string, XPost>(); // first wins: a duplicate text from the second query must not replace the richer first copy
  for (const p of [...byTicker, ...byMint]) if (!seen.has(p.text)) seen.set(p.text, p);
  const all = [...seen.values()];
  if (!all.length) return null;
  const authors = [...new Set(all.map((p) => p.author).filter((a): a is string => !!a))];
  const ages = all.map((p) => p.ageMin).filter((a): a is number => a !== null);
  return {
    postsByTicker: byTicker.length,
    postsByMint: byMint.length,
    uniqueAuthors: authors.length,
    topAuthors: authors.slice(0, 5),
    totalEngagement: all.reduce((s, p) => s + p.engagement, 0),
    newestPostMin: ages.length ? Math.min(...ages) : null,
    oldestPostMin: ages.length ? Math.max(...ages) : null,
    samples: [...all].sort((a, b) => b.engagement - a.engagement).slice(0, 3).map((p) => `${p.author ? '@' + p.author + ': ' : ''}${p.text.slice(0, 160)} (eng ${p.engagement})`),
  };
}

type Fetcher = (query: string) => Promise<unknown>;
let blockedUntil = 0; // after a 429/5xx: skip X for a while, never retry in a loop
const cache = new Map<string, { at: number; v: Record<string, unknown> | null }>();
const CACHE_MS = 15 * 60_000;

async function rapidFetch(query: string): Promise<unknown> {
  const qs = new URLSearchParams(env.RAPIDAPI_TWITTER_EXTRA);
  qs.set(env.RAPIDAPI_TWITTER_QUERY_PARAM, query);
  const res = await fetch(`https://${env.RAPIDAPI_TWITTER_HOST}${env.RAPIDAPI_TWITTER_PATH}?${qs}`, {
    headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': env.RAPIDAPI_TWITTER_HOST },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw Object.assign(new Error(`rapidapi ${res.status}`), { status: res.status });
  return res.json();
}

/** X posts about a token (ticker cashtag + mint) via RapidAPI. Returns null on no key, no posts, any error: the caller falls back to the other sources. Never throws. */
export async function fetchXNarrative(ticker: string, mint: string, fetcher: Fetcher = rapidFetch, nowMs = Date.now(), hasKey = !!env.RAPIDAPI_KEY): Promise<Record<string, unknown> | null> {
  if (!hasKey || nowMs < blockedUntil) return null;
  const hit = cache.get(mint);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.v;
  try {
    const sym = ticker.replace(/[^A-Za-z0-9_]/g, '');
    const [a, b] = await Promise.all([sym ? fetcher(`$${sym}`) : Promise.resolve(null), fetcher(mint)]);
    const v = summarizeX(extractPosts(a, nowMs), extractPosts(b, nowMs));
    cache.set(mint, { at: nowMs, v });
    return v;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 429 || status === 401 || status === 403 || (status ?? 0) >= 500) blockedUntil = nowMs + 10 * 60_000;
    logger.warn('[xNarrative] RapidAPI failed, falling back', { error: e instanceof Error ? e.message : String(e), status });
    return null;
  }
}
