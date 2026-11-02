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

export interface SocialPair {
  info?: { websites?: { url?: unknown }[]; socials?: { type?: unknown; url?: unknown }[] };
}

const X_HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com']);
const X_RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'messages', 'settings', 'login']);

/** A link to an actual X account: an x.com / twitter.com URL whose first path segment is a handle (not /i/communities, /search, ...). */
function isXAccountUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    const handle = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    return X_HOSTS.has(u.hostname.toLowerCase()) && !!handle && !X_RESERVED.has(handle);
  } catch {
    return false;
  }
}

/**
 * Whether the token's DexScreener profile (any of its pairs) lists a website and an X account. DexScreener only returns `info` for tokens with a profile,
 * so a hydrated pair without it means "no website, no socials". undefined = no pair data at all (unknown, never false). Pure.
 */
export function socialPresence(pairs: SocialPair[] | undefined): { hasWebsite: boolean; hasX: boolean } | undefined {
  if (!pairs?.length) return undefined;
  let hasWebsite = false;
  let hasX = false;
  for (const p of pairs) {
    if (p.info?.websites?.some((w) => typeof w.url === 'string' && /^https?:\/\/\S+/i.test(w.url.trim()))) hasWebsite = true;
    if (p.info?.socials?.some((s) => isXAccountUrl(s.url))) hasX = true;
  }
  return { hasWebsite, hasX };
}
