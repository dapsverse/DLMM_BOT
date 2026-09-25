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
  // Was 50k -> 35k (2026-09-24) -> now just a "not literally dead" backstop
  // (2026-09-25). A fixed dollar floor doesn't know how big our capital
  // actually is: confirmed live that 6 of 7 sampled ~$300k-mcap pools sat
  // on $472-$22,632 TVL (below even 35k) despite being completely safe for
  // our ~$130 capital (0.3-3.3% capital/TVL ratio) — real slippage safety
  // now comes from MAX_CAPITAL_TVL_RATIO_PCT below, which scales with
  // capital automatically. This floor just catches pools with essentially
  // no liquidity at all, regardless of ratio math.
  MIN_TVL_USD: num('MIN_TVL_USD', 1_000),
  // Was 1_000_000 — with ~$490 (4.2 SOL) working capital, a pool anywhere
  // near that TVL dilutes our pro-rata fee share to ~0.05%, near-zero $ fee
  // regardless of how active the pool actually is (confirmed live: ALLINU-SOL,
  // $476k TVL, $42k/1h volume — genuinely active pool, still only $0.40 fee
  // in 46min). Then 150k, now raised to 300k (2026-09-23, user call) to widen
  // the candidate pool without going back anywhere near the ~$1M dilution zone.
  MAX_TVL_USD: num('MAX_TVL_USD', 300_000),
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

  // Entry-only overextension ceiling (2026-09-24) — mirror of the crash
  // guard (PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT, constants.ts) but for the
  // pump direction. The ranking already picks the strongest-accelerating
  // candidate; without a ceiling that risks entering right at/near a local
  // top for a memecoin that's about to mean-revert. Confirmed live:
  // post-entry 20min windows routinely showed -8% to -28% troughs.
  // Low-confidence starting guess, not yet validated — tune once entries
  // start logging their own priceChange1hPct at decision time (see
  // paperTrade.ts ENTER/SWITCH events).
  MAX_PRICE_CHANGE_1H_PUMP_PCT: num('MAX_PRICE_CHANGE_1H_PUMP_PCT', 60),

  // Floor on 1h buyRatio (buys/(buys+sells), DexScreener txns.h1) — below
  // this, activity is treated as sell-dominant/distribution, not a genuine
  // pump signal. Applies to both fresh entries and re-screens (health
  // check, not a sizing check). Was hardcoded 0.5 (2026-09-24 first pass);
  // confirmed live via src/scripts/diagnoseRejections.ts that 0.5 alone
  // rejected 65/123 (53%) of real candidates — moved to env so it can be
  // tuned/A-B'd instead of requiring a code change.
  ENTRY_MIN_BUY_RATIO_1H: num('ENTRY_MIN_BUY_RATIO_1H', 0.5),

  // Entry-only floor on volumeSpikeRatio (see meteoraScanner.ts) — below
  // this, a pool isn't accelerating at all (1.0x = running exactly at its
  // own recent 5h pace). rankCandidates() already sorts by this, but
  // sorting alone doesn't help when there's only ONE candidate — without a
  // floor a fully cooled-off pool can still be "the top pick" simply
  // because nothing else passed the base filters. Confirmed live
  // 2026-09-24: familiars-SOL entered at spike 0.182x with priceChange24hPct
  // +4400% (an already-played-out runner) because 5 straight scans found no
  // other candidate. Was hardcoded 1.0 (first pass); diagnoseRejections.ts
  // then showed that alone rejected 99/123 (80%) of real candidates — moved
  // to env, same reasoning as ENTRY_MIN_BUY_RATIO_1H above.
  ENTRY_MIN_SPIKE_RATIO: num('ENTRY_MIN_SPIKE_RATIO', 1.0),

  // Entry-only ceiling on (capital about to deposit) / (pool TVL), as a
  // percent — added 2026-09-25, see MIN_TVL_USD comment above and
  // ScannerConfig.maxCapitalTvlRatioPct doc comment for the full story.
  // Replaces a fixed-dollar TVL floor with something that scales with
  // capital: at ~$130 capital, 5% means pools down to ~$2,600 TVL are
  // admitted (letting in real small-mcap opportunities that a flat $35k/
  // $50k floor blocked entirely), while still rejecting a pool so thin our
  // own deposit would move its price a lot (e.g. MACCA-SOL: $472 TVL would
  // be a 27.5% ratio at $130 capital — correctly rejected). As capital
  // compounds, the required TVL rises proportionally — no manual re-tuning
  // needed. Low-confidence starting guess (5%), not yet validated live.
  MAX_CAPITAL_TVL_RATIO_PCT: num('MAX_CAPITAL_TVL_RATIO_PCT', 5),

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

  // Two independently toggleable fixes for the same root problem, added
  // 2026-09-24 — confirmed live (twice, in both pumpguards-p0p4 and
  // looser-entry, on the SAME WOW-SOL pool within 31s of each other) that
  // volume1hBaselineUsd is captured ONCE at entry and never refreshed for
  // the rest of the position's life (not even on compound, in the real
  // bot — only paper-trade refreshes it, and only on a full compound).
  // Entering during a volume spike (which the entry-spike-floor above now
  // actively selects for) pins the baseline at an inflated level; normal
  // spike decay over the following 1-3h then reads as a false-positive
  // "volume dropped 60%+" HARD_EXIT even when nothing is actually wrong.
  // Both default 0 (disabled) — this preserves the exact original
  // behavior unless explicitly turned on, so existing runs aren't
  // silently affected. Set either to a positive ms value to enable; set
  // both to combine them. Low-confidence starting guesses if enabled,
  // not yet validated — that's what the 3 comparison instances are for.
  //
  // Option A: refresh volume1hBaselineUsd every N ms while holding
  // (reuses the volume figure already being fetched every tick — no
  // extra API call). Root-cause fix: the "drop %" is measured against a
  // moving recent reference instead of a frozen entry-time snapshot.
  // Trade-off: too-frequent a refresh makes the check nearly blind to a
  // genuinely fast real volume collapse, since the baseline "chases" the
  // decline. 0 = never refresh (original behavior).
  VOLUME_BASELINE_REFRESH_MS: num('VOLUME_BASELINE_REFRESH_MS', 0),
  // Option B: suppress the volume-drop HARD_EXIT check for N ms after the
  // baseline was last set (fresh entry, switch, or an Option-A refresh).
  // Simpler than Option A, but only delays enforcement rather than fixing
  // the underlying stale-baseline math — a position can still get
  // exited for the same reason right after the grace window ends.
  // 0 = no grace, check is always active (original behavior).
  VOLUME_DROP_GRACE_MS: num('VOLUME_DROP_GRACE_MS', 0),

  BLACKLIST_DURATION_MS: num('BLACKLIST_DURATION_MS', 6 * 60 * 60_000),

  // Don't let capital sit idle out-of-range forever waiting on a fee
  // threshold that's stopped accruing — force a compound cycle after this
  // many minutes out-of-range, regardless of profit/loss (stop-loss/
  // HARD_EXIT already guards against forcing out a big loss). Tried 5min
  // (2026-09-23): confirmed live it thrashes — 12h sample went from 3
  // entries/1 rebalance (10min) to 10 entries/5 switches/4 rebalances/3
  // leave_pool (5min), and gas cost ($13.82) actually exceeded fee income
  // ($12.57) for the run. Reverted to 10min.
  MAX_IDLE_OUT_OF_RANGE_MINUTES: num('MAX_IDLE_OUT_OF_RANGE_MINUTES', 10),

  // Trailing take-profit: once unrealized profit peaks at/above
  // TAKE_PROFIT_ARM_PCT, a trailing floor is set at (peak -
  // TAKE_PROFIT_GIVEBACK_PCT) percentage points; if profit drops to/below
  // that floor, exit and lock in the remaining gain instead of riding it
  // all the way back down. No blacklist on this exit (see riskManager.ts) -
  // it's profit protection, not a risk violation, so the pool stays a
  // valid candidate if its run continues. 25pp giveback (not the 50pp
  // originally considered) matches the 15-30% range crypto-momentum
  // practice converges on for volatile assets; a flat 50pp giveback was
  // researched as too loose for Solana memecoin volatility specifically.
  TAKE_PROFIT_ARM_PCT: num('TAKE_PROFIT_ARM_PCT', 30),
  TAKE_PROFIT_GIVEBACK_PCT: num('TAKE_PROFIT_GIVEBACK_PCT', 25),

  // Opportunistic pool-switching: every OPPORTUNITY_SCAN_INTERVAL_MS while
  // holding a position, compare it against the best market candidate via
  // volumeSpikeRatio. Switch only if the candidate beats current by
  // SWITCH_SPIKE_RATIO_MARGIN (1.5x - deliberately not a marginal win, since
  // switching costs a full exit+re-entry cycle), UNLESS current unrealized
  // profit is already >= SWITCH_PROFIT_GUARD_PCT (don't abandon a proven
  // winner for an unproven candidate), and never more often than once per
  // SWITCH_COOLDOWN_MS (anti-whipsaw, stacked on top of the scan interval
  // itself).
  OPPORTUNITY_SCAN_INTERVAL_MS: num('OPPORTUNITY_SCAN_INTERVAL_MS', 5 * 60_000),
  SWITCH_SPIKE_RATIO_MARGIN: num('SWITCH_SPIKE_RATIO_MARGIN', 1.5),
  SWITCH_PROFIT_GUARD_PCT: num('SWITCH_PROFIT_GUARD_PCT', 30),
  SWITCH_COOLDOWN_MS: num('SWITCH_COOLDOWN_MS', 15 * 60_000),
  // Separate protection from SWITCH_PROFIT_GUARD_PCT: that guard is about
  // personal unrealized PnL (depends on entry timing), this is about the
  // pool's own price direction. Added 2026-09-23 after SI-SOL got switched
  // away at only +11% profit right as its volume spike cooled — its mcap
  // kept climbing for hours afterward (2M -> 6M+). 10% on the same 6h window
  // the uptrend entry filter uses (steadier than 1h for memecoin noise).
  SWITCH_TREND_PROTECT_PCT: num('SWITCH_TREND_PROTECT_PCT', 10),

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
