/**
 * Which pools a tracked LP wallet holds positions in, without flooding the trading RPC.
 * Live 2026-10-31: check_smart_wallets_on_pool fired 35 x DLMM.getAllLbPairPositionsByUser (getProgramAccounts + getMultipleAccounts) at once,
 * ~120 Helius 429 retry lines per cold cache. Now: Meteora datapi HTTP first (same pool set as RPC, checked on 3 wallets), RPC only as fallback,
 * at most SMART_WALLET_CONCURRENCY wallets at a time, 30 min cache. A failed lookup is `null` (unknown) and is NEVER cached as "no positions".
 */
export const SMART_WALLET_CACHE_TTL_MS = 30 * 60_000;
export const SMART_WALLET_CONCURRENCY = 4;
const API_PAGE_SIZE = 100;
const API_MAX_PAGES = 5;

type FetchJson = (url: string) => Promise<unknown>;

/** Pool addresses of a wallet's open positions from Meteora datapi (paged). Throws on a bad response: the caller must not read that as "no positions". */
export async function fetchPoolsViaApi(address: string, fetchJson: FetchJson, maxPages = API_MAX_PAGES): Promise<string[]> {
  const pools: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = (await fetchJson(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${address}&page=${page}&page_size=${API_PAGE_SIZE}`)) as { pools?: { poolAddress?: unknown }[]; hasNext?: boolean } | null;
    if (!j || !Array.isArray(j.pools)) throw new Error('malformed portfolio response');
    for (const p of j.pools) if (typeof p.poolAddress === 'string') pools.push(p.poolAddress);
    if (!j.hasNext) break;
  }
  return pools;
}

export interface WalletLookupDeps {
  fetchApi: (address: string) => Promise<string[]>;
  fetchRpc: (address: string) => Promise<string[]>;
  now: () => number;
}

export function createWalletPoolLookup(deps: WalletLookupDeps) {
  const cache = new Map<string, { pools: string[]; at: number }>();
  const inflight = new Map<string, Promise<string[] | null>>();

  async function fetchOnce(address: string): Promise<string[] | null> {
    for (const fetcher of [deps.fetchApi, deps.fetchRpc]) {
      try {
        const pools = await fetcher(address);
        cache.set(address, { pools, at: deps.now() });
        return pools;
      } catch {
        /* next source */
      }
    }
    return null;
  }

  function lookup(address: string): Promise<string[] | null> {
    const hit = cache.get(address);
    if (hit && deps.now() - hit.at < SMART_WALLET_CACHE_TTL_MS) return Promise.resolve(hit.pools);
    let p = inflight.get(address);
    if (!p) {
      p = fetchOnce(address).finally(() => inflight.delete(address));
      inflight.set(address, p);
    }
    return p;
  }

  async function lookupMany(addresses: string[], concurrency = SMART_WALLET_CONCURRENCY): Promise<{ address: string; pools: string[] | null }[]> {
    const out: { address: string; pools: string[] | null }[] = new Array(addresses.length);
    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const i = next++;
        out[i] = { address: addresses[i]!, pools: await lookup(addresses[i]!) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
    return out;
  }

  return { lookup, lookupMany };
}

/** Text of the tool result. Lookups that failed are unknown, never counted as "not in this pool". */
export function smartWalletSignal(tracked: number, inPoolCount: number, failed: number, inPoolNames: string[]): string {
  if (inPoolCount > 0) {
    const tail = failed > 0 ? ` (${failed} of ${tracked} lookups failed, not counted)` : '';
    return `${inPoolCount}/${tracked} smart wallet(s) are in this pool: ${inPoolNames.join(', ')} — STRONG signal${tail}`;
  }
  if (failed > 0) return `no smart wallet found in this pool, but ${failed} of ${tracked} lookups failed — unknown for those, treat as neutral`;
  return `0/${tracked} smart wallets in this pool — neutral, rely on fundamentals`;
}
