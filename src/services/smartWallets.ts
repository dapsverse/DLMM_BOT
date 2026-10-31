import { existsSync, readFileSync } from 'node:fs';
import { getWalletPoolAddresses } from './meteoraDLMM.js';
import { logger } from '../utils/logger.js';
import { createWalletPoolLookup, fetchPoolsViaApi, smartWalletSignal } from '../logic/smartWalletLookup.js';

/** Same format as meridian's smart-wallets.json: { "wallets": [{ "name", "address", "category", "type": "lp" }] } (repo root, gitignored). */
const WALLETS_PATH = process.env.SMART_WALLETS_FILE ?? 'smart-wallets.json';
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface SmartWallet {
  name: string;
  address: string;
  category?: string;
  type?: string;
}

const lookup = createWalletPoolLookup({
  fetchApi: (address) => fetchPoolsViaApi(address, async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`meteora datapi ${res.status}`);
    return res.json();
  }),
  fetchRpc: getWalletPoolAddresses,
  now: Date.now,
});

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
  const results = (await lookup.lookupMany(wallets.map((w) => w.address))).map((r, i) => ({ w: wallets[i]!, pools: r.pools }));
  const failed = results.filter((r) => r.pools === null).length;
  if (failed > 0) logger.warn('[smartWallets] position lookup failed (API and RPC)', { failed, tracked: wallets.length });
  const inPool = results.filter((r) => r.pools?.includes(poolAddress)).map((r) => ({ name: r.w.name, category: r.w.category, address: r.w.address }));
  return {
    pool: poolAddress,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    unknown_lookups: failed,
    signal: smartWalletSignal(wallets.length, inPool.length, failed, inPool.map((w) => w.name)),
  };
}
