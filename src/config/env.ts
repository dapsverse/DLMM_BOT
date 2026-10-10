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
  // MIN_GAS_RESERVE_SOL is now an ABSOLUTE FLOOR, not the full reserve — see
  // computeGasReserveSol (rebalanceEngine.ts). Idea borrowed 2026-10-08 from
  // comparing against CryptoGnome/dlmmbot's reserveSol(): a flat reserve
  // value goes stale as the wallet's actual balance drifts (this project
  // manually re-tuned MIN_GAS_RESERVE_SOL by hand after nearly every restart
  // the night real money went live — 0.8 -> 0.35 -> ... -> 0.06, chasing the
  // balance by hand each time). The real reserve is now
  // max(MIN_GAS_RESERVE_SOL floor, equity * MIN_GAS_RESERVE_PCT/100) —
  // scales automatically, the floor only matters at very small balances.
  // INITIAL_LP_CAPITAL_SOL deliberately stays a FIXED absolute value, not
  // equity-scaled — user's explicit call 2026-10-08 ("capital tetep 1.3"):
  // only the reserve needed to stop being hand-tuned.
  MIN_GAS_RESERVE_SOL: num('MIN_GAS_RESERVE_SOL', 0.05),
  MIN_GAS_RESERVE_PCT: num('MIN_GAS_RESERVE_PCT', 5),
  /** Equity kill-switch (2026-10-08, user's call): when FLAT (no open position) and wallet SOL < this, the bot logs and exits instead of entering again. 0 = off. Only checked while flat — a held position is governed by its own stop-loss/hard-exit, and the check fires right after it closes. */
  MIN_EQUITY_STOP_SOL: num('MIN_EQUITY_STOP_SOL', 0),
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
  // MAX_TVL_USD ceiling removed entirely 2026-09-26 (was 300_000). Its only
  // rationale was LP pro-rata fee dilution in a big pool — moot now that
  // paper-trade data showed fee income is already negligible/net-negative
  // (rebalance+entry/exit costs exceed it) across every running instance
  // regardless of pool size, and it doesn't apply to the spot executor at
  // all (no LP fee to dilute). Confirmed live: SI-SOL's real Meteora pool
  // ($685k TVL, sustained 6h/24h uptrend, 6M->9M mcap over 9h) was rejected
  // SOLELY by this ceiling while every entered pool that night (all under
  // 300k TVL, all "new spike" candidates) crashed -12% to -50%. Slippage
  // safety on the LOW end is still fully covered by MAX_CAPITAL_TVL_RATIO_PCT
  // below (scales with capital) — there's no equivalent risk on the high
  // end a bigger pool introduces; a deeper pool is safer, not riskier.
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

  // Second entry track (added 2026-09-26) — the momentum-chase ranking
  // above (volumeSpikeRatio/ENTRY_MIN_SPIKE_RATIO) structurally excludes a
  // token that already did its whole move and is now just steadily holding
  // (low CURRENT spike ratio despite a real, large, sustained trend).
  // Confirmed live: SI-SOL's Meteora pool ($685k TVL, +66% 6h / +46% 24h,
  // 6M->9M mcap over 9h) got rejected on spike ratio alone (0.21x) on every
  // running instance, same night every entered "new spike" candidate
  // crashed -12% to -50%. 'trend' mode (paperTrade.ts instances only, via
  // ENTRY_STRATEGY_MODE=trend) skips the spike-ratio requirement entirely
  // and instead requires BOTH 6h and 24h change to clear
  // TREND_MIN_SUSTAINED_PCT (unknown data fails closed here — sustained
  // trend is the entire point of this mode, unlike the rest of the screen's
  // permissive-unknown policy). Ranks survivors by TVL (liquidity)
  // descending instead of by acceleration — biggest/most-established first.
  // All other safety gates (crash guard, overextension ceilings, buy-ratio,
  // activity/tx-count, wash-trade, mint/freeze authority) still apply
  // identically to both modes. Untested — this is what the trend-mode
  // paper-trade instances exist to validate against the momentum-chase
  // ones already running.
  ENTRY_STRATEGY_MODE: (() => {
    const v = optionalStr('ENTRY_STRATEGY_MODE', 'momentum');
    if (v !== 'momentum' && v !== 'trend' && v !== 'range') throw new Error(`[env] ENTRY_STRATEGY_MODE must be "momentum", "trend", or "range", got "${v}"`);
    return v as 'momentum' | 'trend' | 'range';
  })(),
  TREND_MIN_SUSTAINED_PCT: num('TREND_MIN_SUSTAINED_PCT', 20),

  // Third entry track (added 2026-09-26) — specifically for the DLMM/LP
  // execution path, not spot. IL costs nothing when price barely moves and
  // fee income compounds with no directional cost — the OPPOSITE case from
  // 'momentum'/'trend' (both target directional movers, confirmed live this
  // session to be the worst-case scenario for LPing: every DLMM instance's
  // rebalance+entry/exit costs exceeded its fee income on a momentum-chase
  // target). 'range' mode rejects anything moving more than
  // RANGE_MAX_VOLATILITY_PCT on EITHER 1h or 6h (opposite of 'trend' mode's
  // floor) and ranks by vol/TVL ratio (turnover, a direct fee-yield proxy)
  // instead of by spike or TVL. Unlike every other entry-only sizing check
  // in this file, this ceiling is NOT skipped on re-screen — if a held
  // 'range' position starts trending, the entire range-bound thesis just
  // broke, that's a reason to reconsider even while holding, not something
  // to ride out like a momentum position pumping. Untested — this is what
  // the range-mode paper-trade instance (DLMM-only, spot execution
  // deliberately not paired with this mode) exists to validate.
  RANGE_MAX_VOLATILITY_PCT: num('RANGE_MAX_VOLATILITY_PCT', 15),

  // Absolute (not capital-relative) TVL floor for 'range' mode entries only.
  // MAX_CAPITAL_TVL_RATIO_PCT already protects against OUR OWN trade moving
  // a thin pool's price too much (impact/slippage) — it scales with capital,
  // so at small capital (e.g. 1.2 SOL) it lets entries into pools as thin as
  // $11K-16K TVL through. Confirmed live 2026-09-29/30: 'range-optAB' (1.2
  // SOL) entered o-SOL TWICE at $15,837 and $11,442 TVL — genuinely fragile
  // regardless of how small our own capital is (any single large trader can
  // move a pool that thin), and the second entry HARD_EXIT'd at -43%
  // unrealized loss. 'range' mode's whole thesis needs genuinely deep
  // liquidity to be a real "calm, fee-earning" pool, not just "calm relative
  // to our tiny position" — that's a different risk than price impact, needs
  // its own gate. Set from the same incident's data: disasters clustered at
  // $11K-59K TVL, healthy range entries (SI-SOL) sat at $261K-574K — $60K
  // floor clears the observed disaster zone without cutting into the healthy
  // range. Entry-only (see FilterOpts.skipSizingChecks) — a held position
  // whose pool TVL grew past this succeeded, it didn't go bad.
  RANGE_MIN_TVL_USD: num('RANGE_MIN_TVL_USD', 60_000),

  // Discussed 2026-10-07/08 after watching a real HIGGS-SOL position
  // (base_fee_pct 0.3%) earn very little fee relative to its TVL. Meteora's
  // own /pools response already includes pool_config.base_fee_pct AND a
  // pre-computed fee_tvl_ratio per window — both unused until now. This is
  // a backstop floor against the lowest stable-pair-style fee tiers (e.g.
  // 0.01-0.04%, seen on SOL-USDC/SOL-USDC pools in the same response) that
  // are structurally wrong for range mode's memecoin-pair fee-yield thesis,
  // even though they'd otherwise pass every other range-mode filter.
  // Deliberately modest (0.2%, not the initially-discussed 0.5%) — a hard
  // 0.5% floor risks rejecting a high-turnover pool with a lower rate that
  // still out-yields a low-turnover 0.5%+ pool; the real yield-quality
  // question is answered by rankRangeCandidates sorting on feeTvlRatio24h
  // instead of raw turnover (see its doc comment), not by this floor alone.
  // Entry-only (see FilterOpts.skipSizingChecks), same reasoning as
  // RANGE_MIN_TVL_USD above.
  RANGE_MIN_BASE_FEE_PCT: num('RANGE_MIN_BASE_FEE_PCT', 0.2),
  // Entry-only floor on recent fee yield (fee_tvl_ratio 4h x6, in % per 24h
  // equivalent). 2026-10-09: EMBER-SOL ranked on a front-loaded 24h 2.6% but
  // its 4h x6 was 0.37% (volume had decayed ~6x), so fees accrued ~0.11%/h.
  // 0.5 is an untuned starting guess (rejects EMBER-like decay) - revisit
  // with the entry logs (feeYield field).
  RANGE_MIN_RECENT_FEE_TVL_PCT: num('RANGE_MIN_RECENT_FEE_TVL_PCT', 0.5),

  // Profit-aware override for 'range' mode's re-screen (see
  // RANGE_MAX_VOLATILITY_PCT doc comment above): a held range position that
  // gets idle-forced to re-screen (out-of-range too long) and fails ONLY on
  // the volatility ceiling (i.e. the pool started trending, not a real
  // crash/activity/authority problem) normally gets abandoned even mid-pump.
  // Confirmed live 2026-09-29: 'range-optAB-90sol' left a SI-SOL position at
  // ~28% unrealized profit (peak, right before the idle-timer+ceiling combo
  // fired) — SI-SOL then kept climbing to ~2x further after the bot left.
  // The existing sticky trailing-take-profit tiers (TAKE_PROFIT_TIERS,
  // riskManager.ts) already handle "let a winner ride, only lock in on a
  // real pullback from peak" — but they never got a chance to arm here
  // because this idle-forced re-screen abandons the pool unconditionally,
  // before profit ever reaches the first tier's 30% arm threshold. Fix:
  // when the re-screen fails ONLY on the range-ceiling reasons (not crash
  // guard / dead activity / authority — those still abandon as before) AND
  // current profit is above this threshold, don't abandon — recenter the
  // bin and keep holding in the SAME pool instead (identical to the normal
  // "still eligible" reopen path), letting the existing trailing-tier
  // system govern the eventual exit on subsequent ticks. Default 0 (any
  // positive profit qualifies) per the "selama masih positif" call.
  RANGE_CEILING_PROFIT_OVERRIDE_PCT: num('RANGE_CEILING_PROFIT_OVERRIDE_PCT', 0),

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

  // Entry-only overextension ceiling on 24h price change (2026-09-25) — the
  // 1h ceiling above only catches a fresh blow-off; it's blind to a pool
  // that already did its whole move over the last day and has since
  // decelerated to a 1h/6h change small enough to slip under that ceiling.
  // ENTRY_MIN_SPIKE_RATIO/entryMinBuyRatio1h don't help either — they're
  // relative-momentum signals, not cumulative ones. Confirmed live
  // 2026-09-25: GO-SOL entered at spike 0.305x (just above the loose 0.3x
  // floor) with priceChange1hPct only 10.51% (nowhere near the 60% 1h
  // ceiling) but priceChange24hPct +4637% — a near-identical pattern to the
  // familiars-SOL incident that justified ENTRY_MIN_SPIKE_RATIO
  // (+4400% 24h) — crashed -19% within the hour, -39% 6h trend. Low-
  // confidence starting guess, not yet validated live.
  MAX_PRICE_CHANGE_24H_PUMP_PCT: num('MAX_PRICE_CHANGE_24H_PUMP_PCT', 300),

  // Floor on 1h buyRatio (buys/(buys+sells), DexScreener txns.h1) — below
  // this, activity is treated as sell-dominant/distribution, not a genuine
  // pump signal. Applies to both fresh entries and re-screens (health
  // check, not a sizing check). Was hardcoded 0.5 (2026-09-24 first pass);
  // confirmed live via src/scripts/diagnoseRejections.ts that 0.5 alone
  // rejected 65/123 (53%) of real candidates — moved to env so it can be
  // tuned/A-B'd instead of requiring a code change.
  ENTRY_MIN_BUY_RATIO_1H: num('ENTRY_MIN_BUY_RATIO_1H', 0.5),

  // Floor on a DOLLAR-volume-weighted buy ratio (flowAnalysis.ts's
  // getDollarVolumeBuyRatio), NOT the same thing as ENTRY_MIN_BUY_RATIO_1H
  // above (that one's a tx-COUNT ratio from DexScreener). Found live
  // 2026-10-08 on HIGGS-SOL: tx counts favored buys at every window
  // (h1 145/148, h6 904/792, h24 4975/4546) while price fell hard the
  // whole time (-9%/-10%/-37%) — classic signature of a few large sellers
  // outweighing many small buyers in $ terms, invisible to a count-based
  // ratio. DexScreener/Meteora's REST APIs don't expose a $ volume split by
  // side at all, so this reads real on-chain reserve-account balance
  // deltas instead (real RPC cost — deliberately scoped to ONLY the
  // pre-entry top candidate and the currently-held position's periodic
  // check, never the full ~200-pool scan, to stay affordable after this
  // session's repeated 429-storm incidents). Default 0.4 (not 0.5, unlike
  // the tx-count version) — deliberately more lenient since $ volume is
  // naturally lumpier (one legitimate whale trade can swing it hard even
  // on an otherwise healthy pool); this is a brand-new, unvalidated signal,
  // same "low-confidence starting guess" caveat as other knobs here.
  MIN_DOLLAR_BUY_RATIO: num('MIN_DOLLAR_BUY_RATIO', 0.4),

  // EXIT-side thresholds for the held-position dollar-flow check (looser than
  // entry on purpose). Live 2026-10-08: SI-SOL (partial window) and
  // TWEETCRAFT-SOL (7 tx, ~$435 total) were both exited on thin reads and
  // the price later recovered above the exit (+14% / +60%); the one correct
  // exit (BATON) had 55 samples. So: stricter ratio, a real sample/volume
  // floor, and N consecutive qualified breaches before acting.
  DOLLAR_FLOW_EXIT_MIN_RATIO: num('DOLLAR_FLOW_EXIT_MIN_RATIO', 0.25),
  DOLLAR_FLOW_EXIT_MIN_SAMPLES: num('DOLLAR_FLOW_EXIT_MIN_SAMPLES', 25),
  DOLLAR_FLOW_EXIT_MIN_VOLUME_USD: num('DOLLAR_FLOW_EXIT_MIN_VOLUME_USD', 2000),
  DOLLAR_FLOW_EXIT_CONFIRMATIONS: num('DOLLAR_FLOW_EXIT_CONFIRMATIONS', 2),

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
  // FEE_GAS_MULTIPLIER removed 2026-09-26 along with the standalone
  // fee-threshold REBALANCE trigger it gated — see riskManager.ts's
  // doc comment at that removal site for why.
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

  // Short cooldown applied on LEFT_POOL/LEAVE_POOL exits (pool no longer
  // passes the re-screen, NOT a HARD_EXIT violation) — added 2026-09-27/28
  // after a 43h live run showed trend-optAB-spot round-tripping the SAME
  // pool dozens of times back to back (parafactual-SOL, COLLECT-SOL,
  // AQUA-SOL...), dragging capital from $137 to $28 purely on entry/exit
  // cost + small crash-guard losses, even though TAKE_PROFIT fired
  // correctly every time it got the chance. Root cause: a LEFT_POOL exit
  // never blacklisted at all, so a pool that just failed its own
  // re-screen (often a noisy metric like buyRatio1h oscillating right at
  // its 50% threshold) was still the top-ranked candidate and got
  // re-entered the very next tick — "reconsider it later if it recovers"
  // (the original design intent) was never actually throttled. Much
  // shorter than BLACKLIST_DURATION_MS since this isn't a risk violation,
  // just breaking the immediate thrash loop.
  LEFT_POOL_COOLDOWN_MS: num('LEFT_POOL_COOLDOWN_MS', 20 * 60_000),

  // Don't let capital sit idle out-of-range forever waiting on a fee
  // threshold that's stopped accruing — force a compound cycle after this
  // many minutes out-of-range, regardless of profit/loss (stop-loss/
  // HARD_EXIT already guards against forcing out a big loss). Tried 5min
  // (2026-09-23): confirmed live it thrashes — 12h sample went from 3
  // entries/1 rebalance (10min) to 10 entries/5 switches/4 rebalances/3
  // leave_pool (5min), and gas cost ($13.82) actually exceeded fee income
  // ($12.57) for the run. Reverted to 10min.
  MAX_IDLE_OUT_OF_RANGE_MINUTES: num('MAX_IDLE_OUT_OF_RANGE_MINUTES', 10),

  // Trailing take-profit: tiered/sticky schedule, not a flat giveback — see
  // TAKE_PROFIT_TIERS (constants.ts) for the table and riskManager.ts's
  // trailingTakeProfitFloorPct() for the logic. Replaced the old flat
  // TAKE_PROFIT_ARM_PCT/TAKE_PROFIT_GIVEBACK_PCT (30% arm, 25pp giveback
  // always) 2026-09-26: confirmed live a flat 25pp giveback exits WAY too
  // early on a real memecoin runner (PAID-SOL peaked +57.71%, exited at
  // +32.28%, kept running to +136%+ afterward) — a fixed percentage-point
  // giveback is too tight relative to peak when peak is still in the
  // 30-100% range, this asset class's normal volatility band.

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

  // Paper-trade executor toggles (paperTrade.ts only — no effect on the
  // real bot). Both default to today's behavior (LP-only). Turn both on to
  // run LP and spot side-by-side off the SAME scanned candidate/tick, for
  // an apples-to-apples comparison of the LP wrapper itself vs. just
  // buying/selling the token directly (added 2026-09-25 after paper-trade
  // data showed every running LP instance's rebalance+entry/exit costs
  // exceeding its fee income — see spotExecutor.ts).
  ENABLE_LP_EXECUTOR: bool('ENABLE_LP_EXECUTOR', true),
  ENABLE_SPOT_EXECUTOR: bool('ENABLE_SPOT_EXECUTOR', false),

  // Swap / gas
  SLIPPAGE_BPS: num('SLIPPAGE_BPS', 100),
  // Max slippage tolerance sent to Jupiter on real swaps. Separate from SLIPPAGE_BPS (which feeds the
  // pre-trade cost estimate): memecoins moving >1% between quote and landing failed with 6001 (2 of 4 swaps
  // on 2026-10-10), while measured real slippage averaged ~0.008%, so a looser cap costs little.
  // Entry gate: reject a pool whose price is more than this % below its high of the last DRAWDOWN_WINDOW_DAYS
  // (e/acc-SOL entered 2026-10-10 at -92% from a 14d high). 0 disables. Untuned: observed BATON -25%, QI -37%, e/acc -92%.
  MAX_DRAWDOWN_FROM_HIGH_PCT: num('MAX_DRAWDOWN_FROM_HIGH_PCT', 60),
  DRAWDOWN_WINDOW_DAYS: num('DRAWDOWN_WINDOW_DAYS', 14),
  JUPITER_MAX_SLIPPAGE_BPS: num('JUPITER_MAX_SLIPPAGE_BPS', 300),
  // Cap on Jupiter's priority fee (lamports); swaps requested at level 'high'. 4x 'block height exceeded' seen 2026-10-10 with default fee.
  JUPITER_EXIT_SLIPPAGE_BPS: num('JUPITER_EXIT_SLIPPAGE_BPS', 800),
  JUPITER_MAX_PRIORITY_FEE_LAMPORTS: num('JUPITER_MAX_PRIORITY_FEE_LAMPORTS', 1_000_000),
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
if (env.MIN_GAS_RESERVE_PCT <= 0 || env.MIN_GAS_RESERVE_PCT >= 100) {
  throw new Error('[env] MIN_GAS_RESERVE_PCT must be between 0 and 100 (exclusive)');
}
if (env.INITIAL_LP_CAPITAL_SOL <= 0) {
  throw new Error('[env] INITIAL_LP_CAPITAL_SOL must be > 0');
}
if (env.STOP_LOSS_PCT <= 0 || env.STOP_LOSS_PCT > 100) {
  throw new Error('[env] STOP_LOSS_PCT must be in (0, 100]');
}
