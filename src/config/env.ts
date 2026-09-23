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
  // Was 1_000_000 — with ~$490 (4.2 SOL) working capital, a pool anywhere
  // near that TVL dilutes our pro-rata fee share to ~0.05%, near-zero $ fee
  // regardless of how active the pool actually is (confirmed live: ALLINU-SOL,
  // $476k TVL, $42k/1h volume — genuinely active pool, still only $0.40 fee
  // in 46min). 150k keeps share in the same ballpark as past good entries
  // (JEANPHIL $80k, QUEEF $56-134k) — ~0.3%+ instead of ~0.1%.
  MAX_TVL_USD: num('MAX_TVL_USD', 150_000),
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

  // Trend filter — good volume alone isn't enough. Was -5 (merely "not
  // crashing", let flat/slightly-bleeding tokens in); tightened to 0 to
  // require genuine positive 6h momentum — real trend-following practice
  // confirms positive momentum, not just "not down much", and this bot's
  // own out-of-range-exit-direction logic only pays off if entry is a real
  // uptrend, not a coin flip near flat.
  REQUIRE_UPTREND: bool('REQUIRE_UPTREND', true),
  MIN_PRICE_CHANGE_6H_PCT: num('MIN_PRICE_CHANGE_6H_PCT', 0),

  // Activity cascade — 1h and 5m volume must each be at least this fraction
  // of the pool's own 24h average pace, or it's flagged as "24h number
  // looks fine but nothing's actually trading right now" (stale/wash-traded).
  MIN_RECENT_ACTIVITY_RATIO: num('MIN_RECENT_ACTIVITY_RATIO', 0.15),

  // Absolute (not relative) floor: a pool with a weak 24h average can still
  // pass the ratio-based activity cascade above with 0 real trades in the
  // last 5 minutes, since 15% of an already-low baseline is a tiny number.
  // This asks directly "did >= N trades happen in the last 5 minutes" —
  // confirmed live via DexScreener's txns.m5 (buys+sells) that a pool can
  // pass every other filter while sitting at literally 0 trades right now.
  MIN_TX_COUNT_M5: num('MIN_TX_COUNT_M5', 20),

  // Position sizing — bin radius is DERIVED per-pool from bin_step to hit
  // this target price coverage (a fixed bin-count radius covers wildly
  // different % price ranges across pools with different bin_step — e.g.
  // radius=10 is ~±10% on bin_step=100 but only ~±1.6% on bin_step=15,
  // both seen in real pools this bot has scanned). See logic/binRange.ts.
  TARGET_RANGE_PCT: num('TARGET_RANGE_PCT', 15),
  MIN_BIN_RADIUS: num('MIN_BIN_RADIUS', 5),
  MAX_BIN_RADIUS: num('MAX_BIN_RADIUS', 50),

  // Risk management
  STOP_LOSS_PCT: num('STOP_LOSS_PCT', 25),
  MAX_REBALANCE_PER_HOUR: num('MAX_REBALANCE_PER_HOUR', 3),
  REBALANCE_COOLDOWN_MS: num('REBALANCE_COOLDOWN_MS', 5 * 60_000),
  FEE_GAS_MULTIPLIER: num('FEE_GAS_MULTIPLIER', 2.5),
  VOLUME_DROP_HARD_EXIT_PCT: num('VOLUME_DROP_HARD_EXIT_PCT', 60),
  BLACKLIST_DURATION_MS: num('BLACKLIST_DURATION_MS', 6 * 60 * 60_000),

  // Don't let capital sit idle out-of-range forever waiting on a fee
  // threshold that's stopped accruing — force a compound cycle after this
  // many minutes out-of-range, but only while already in profit (never
  // force-crystallize a loss). > REBALANCE_COOLDOWN_MS so it never fires
  // faster than the normal cooldown allows anyway.
  MAX_IDLE_OUT_OF_RANGE_MINUTES: num('MAX_IDLE_OUT_OF_RANGE_MINUTES', 10),

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
