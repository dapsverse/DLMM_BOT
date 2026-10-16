import { existsSync, readFileSync } from 'node:fs';
import { getWalletPoolAddresses } from './meteoraDLMM.js';
import { logger } from '../utils/logger.js';

/** Same format as meridian's smart-wallets.json: { "wallets": [{ "name", "address", "category", "type": "lp" }] } (repo root, gitignored). */
const WALLETS_PATH = process.env.SMART_WALLETS_FILE ?? 'smart-wallets.json';
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CACHE_TTL_MS = 5 * 60_000;

interface SmartWallet {
  name: string;
  address: string;
  category?: string;
  type?: string;
}

const cache = new Map<string, { pools: string[]; at: number }>();

function loadWallets(): SmartWallet[] {
  if (!existsSync(WALLETS_PATH)) return [];
  try {
    const { wallets } = JSON.parse(readFileSync(WALLETS_PATH, 'utf8')) as { wallets?: SmartWallet[] };
    return (wallets ?? []).filter((w) => SOLANA_PUBKEY_RE.test(w.address) && (!w.type || w.type === 'lp'));
  } catch {
    return [];
  }
}

/** meridian's check_smart_wallets_on_pool: which tracked LP wallets currently hold a position in this pool. */
export async function checkSmartWalletsOnPool(poolAddress: string) {
  const wallets = loadWallets();
  if (wallets.length === 0) {
    return { pool: poolAddress, tracked_wallets: 0, in_pool: [], confidence_boost: false, signal: 'No smart wallets tracked yet — neutral signal' };
  }
  const results = await Promise.all(
    wallets.map(async (w) => {
      const hit = cache.get(w.address);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { w, pools: hit.pools };
      try {
        const pools = await getWalletPoolAddresses(w.address);
        cache.set(w.address, { pools, at: Date.now() });
        return { w, pools };
      } catch (e) {
        logger.warn('[smartWallets] position lookup failed', { wallet: w.name, error: (e as Error).message });
        return { w, pools: [] as string[] };
      }
    }),
  );
  const inPool = results.filter((r) => r.pools.includes(poolAddress)).map((r) => ({ name: r.w.name, category: r.w.category, address: r.w.address }));
  return {
    pool: poolAddress,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(', ')} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}
