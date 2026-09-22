import 'dotenv/config';

/**
 * ponytail: flat env validation, no zod — few dozen scalar vars, a schema lib
 * buys nothing here. Add zod if the var count triples or nesting appears.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`[env] Missing required env var: ${name}`);
  }
  return v.trim();
}

function optionalStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`[env] ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim().toLowerCase() === 'true';
}

export const env = {
  // Solana RPC
  RPC_URL: required('RPC_URL'),
  RPC_WS_URL: optionalStr('RPC_WS_URL', ''),

  // Wallet — never log this value, anywhere.
  PRIVATE_KEY: required('PRIVATE_KEY'),

  // Capital allocation
  INITIAL_LP_CAPITAL_SOL: num('INITIAL_LP_CAPITAL_SOL', 4.2),
  MIN_GAS_RESERVE_SOL: num('MIN_GAS_RESERVE_SOL', 0.8),
  ENABLE_AUTO_COMPOUND: bool('ENABLE_AUTO_COMPOUND', true),
  MAX_CONCURRENT_POOLS: num('MAX_CONCURRENT_POOLS', 1),

  // Pool scanner filters
  MIN_TVL_USD: num('MIN_TVL_USD', 50_000),
  MAX_TVL_USD: num('MAX_TVL_USD', 1_000_000),
  MIN_24H_VOLUME_USD: num('MIN_24H_VOLUME_USD', 200_000),
  MIN_VOL_TVL_RATIO: num('MIN_VOL_TVL_RATIO', 3.0),
  POOL_SCAN_INTERVAL_MS: num('POOL_SCAN_INTERVAL_MS', 60_000),

  // Memecoin screen — keeps the scanner off blue-chip/major pairs and
  // off freshly-launched rug-risk pairs. Applied to whichever side of the
  // pool isn't WSOL.
  MAX_MEMECOIN_MARKET_CAP_USD: num('MAX_MEMECOIN_MARKET_CAP_USD', 50_000_000),
  MIN_TOKEN_HOLDERS: num('MIN_TOKEN_HOLDERS', 300),
  REQUIRE_FREEZE_AUTHORITY_DISABLED: bool('REQUIRE_FREEZE_AUTHORITY_DISABLED', true),
  REQUIRE_MINT_AUTHORITY_DISABLED: bool('REQUIRE_MINT_AUTHORITY_DISABLED', true),
  MIN_BIN_STEP: num('MIN_BIN_STEP', 15),
  MIN_POOL_AGE_HOURS: num('MIN_POOL_AGE_HOURS', 2),

  // Trend filter — good volume alone isn't enough; prefer tokens that are
  // net up over the last 6h instead of a high-volume token mid-downtrend.
  REQUIRE_UPTREND: bool('REQUIRE_UPTREND', true),
  MIN_PRICE_CHANGE_6H_PCT: num('MIN_PRICE_CHANGE_6H_PCT', 0),

  // Position sizing
  BIN_RANGE_RADIUS: num('BIN_RANGE_RADIUS', 10),

  // Risk management
  STOP_LOSS_PCT: num('STOP_LOSS_PCT', 25),
  MAX_REBALANCE_PER_HOUR: num('MAX_REBALANCE_PER_HOUR', 3),
  REBALANCE_COOLDOWN_MS: num('REBALANCE_COOLDOWN_MS', 5 * 60_000),
  FEE_GAS_MULTIPLIER: num('FEE_GAS_MULTIPLIER', 2.5),
  VOLUME_DROP_HARD_EXIT_PCT: num('VOLUME_DROP_HARD_EXIT_PCT', 60),
  BLACKLIST_DURATION_MS: num('BLACKLIST_DURATION_MS', 6 * 60 * 60_000),

  // Swap / gas
  SLIPPAGE_BPS: num('SLIPPAGE_BPS', 100),
  JUPITER_API_BASE_URL: optionalStr('JUPITER_API_BASE_URL', 'https://quote-api.jup.ag'),

  // Logging
  LOG_LEVEL: optionalStr('LOG_LEVEL', 'info'),
  LOG_DIR: optionalStr('LOG_DIR', './logs'),
} as const;

// Sanity checks that catch fat-finger config before real SOL moves.
if (env.MAX_CONCURRENT_POOLS !== 1) {
  throw new Error('[env] MAX_CONCURRENT_POOLS must be 1 — strategy is single-pool focus only');
}
if (env.MIN_GAS_RESERVE_SOL <= 0) {
  throw new Error('[env] MIN_GAS_RESERVE_SOL must be > 0');
}
if (env.INITIAL_LP_CAPITAL_SOL <= 0) {
  throw new Error('[env] INITIAL_LP_CAPITAL_SOL must be > 0');
}
if (env.STOP_LOSS_PCT <= 0 || env.STOP_LOSS_PCT > 100) {
  throw new Error('[env] STOP_LOSS_PCT must be in (0, 100]');
}
if (env.MAX_TVL_USD <= env.MIN_TVL_USD) {
  throw new Error('[env] MAX_TVL_USD must be > MIN_TVL_USD');
}
