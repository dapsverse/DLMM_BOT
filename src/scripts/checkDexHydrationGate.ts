/**
 * Self-check for the dexHydrationFailed reject gate (meteoraScanner.ts) —
 * see STONK10 incident in project CLAUDE.md: a whole-batch DexScreener
 * failure left txCountM5 undefined, and the "unknown, don't block" policy
 * let the pool through on a fresh entry despite real 5m tx count being 4
 * (min 20). Fresh entries must now reject on dexHydrationFailed; re-screens
 * of an already-held pool (skipSizingChecks: true) must not, so a transient
 * 429 doesn't force-exit a healthy position.
 *
 * No test framework in this repo (see package.json) — plain assert, run via
 * `tsx src/scripts/checkDexHydrationGate.ts`.
 */
import assert from 'node:assert';
import { poolRejectReasons, defaultScannerConfig, type MeteoraPair } from '../services/meteoraScanner.js';

const config = defaultScannerConfig(new Map());

// A pair that would otherwise pass every check (healthy tvl/volume/age/etc),
// but whose DexScreener batch hydration failed this scan.
const pair: MeteoraPair = {
  address: 'FAKE_POOL',
  name: 'FAKE-SOL',
  mint_x: 'FAKE_MINT',
  mint_y: 'So11111111111111111111111111111111111111112',
  liquidity: String(config.minTvlUsd + 1),
  trade_volume_24h: config.minVolume24hUsd + 1,
  fees_24h: 0,
  bin_step: config.minBinStep,
  current_price: 1,
  createdAtMs: Date.now() - (config.minPoolAgeHours + 1) * 3_600_000,
  volume1hUsd: config.minVolume24hUsd,
  fees1hUsd: 0,
  tokenX: { address: 'FAKE_MINT', priceUsd: 1, marketCapUsd: 0, holders: config.minTokenHolders + 1, freezeAuthorityDisabled: true },
  tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
  dexHydrationFailed: true,
};

const freshEntryReasons = poolRejectReasons(pair, config, { skipSizingChecks: false });
assert(
  freshEntryReasons.some((r) => r.includes('dexscreener batch hydration failed')),
  'fresh entry must reject a pool whose DexScreener batch hydration failed',
);

const reScreenReasons = poolRejectReasons(pair, config, { skipSizingChecks: true });
assert(
  !reScreenReasons.some((r) => r.includes('dexscreener batch hydration failed')),
  're-screening an already-held pool must NOT reject on a transient hydration failure',
);

console.log('OK: dexHydrationFailed gates fresh entries but not held-pool re-screens');
