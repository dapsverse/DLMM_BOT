## Important mechanics/insights surfaced this session (don't re-derive)

- **A fixed-dollar sizing floor (TVL, or anything else) doesn't know how
  big the bot's capital actually is** — prefer a ratio to capital where
  possible (see `MAX_CAPITAL_TVL_RATIO_PCT`). This generalizes: if more
  capital-relative sizing questions come up, this is the pattern.
- **`volume1hBaselineUsd` (and similar "snapshot at entry, compare against
  it forever" baselines) go stale** — anything measuring "% change since
  X" needs to either refresh X periodically or accept that the comparison
  degrades over the position's life. This bit the volume-drop check
  specifically but the pattern could recur elsewhere.
- **Paper-trade and the real bot can silently drift out of parity on
  *bases*, not just on decision branches** — the `initialDepositUsd` bug
  wasn't a missing feature, it was the same-named-concept computed two
  different ways in the two codepaths. When adding a new
  profit/loss-tracking field, explicitly check both call sites compute it
  identically, don't just check both call the same evaluator function.
- **A risk-management trigger being "technically correct" about its own
  signal doesn't mean the outcome is good** — the volume-drop false-positive
  that got "fixed" this session had, on the one clean episode observed,
  accidentally protected capital better than the fix did. Momentum/activity
  signals and price signals are not the same thing and won't always agree;
  don't assume closing a false-positive gap is a pure win without watching
  outcomes, not just triggers.
- **Launching multiple paper-trade instances staggered in time (to avoid
  RPC bursts) introduces a real entry-price confound** — two instances
  entering the "same" pool 10-20 seconds apart in a fast-moving memecoin
  can have meaningfully different entry prices, which then compounds
  through the whole position's value trajectory. Don't compare raw PnL%
  between staggered-launch instances without checking entry price parity
  first; compare *behavior* (what triggered, when) instead.
- All prior-session insights (asymmetric DLMM out-of-range exit, fee
  income ≠ covering IL, `nonSolToken`/`solToken` not `mint_x`/`mint_y`,
  DexScreener batch endpoint, `skipSizingChecks` split) still stand
  unchanged — see git history / `SCREEN_RULE.MD` if needed.

## Known limitations / deliberately deferred

- No LP-concentration/whale-dominance, deployer-wallet-history, sniper-
  clustering, or social-sentiment screening — still deferred until
  strategy is validated as profitable.
- Paper-trade fee model is still a naive TVL-share pro-rata, not real
  bin-level fee capture — read `paperTrade.ts`'s header comment block
  before trusting its numbers as a precise backtest.
- `HARD_EXIT`'s anti-thrash/volume-drop triggers still have no
  profit-guard (can blacklist a deeply profitable position) — open since
  2026-09-23, still not decided.
- `.env.example` still not updated with all the new env vars from this
  and the prior session.
- `MAX_CAPITAL_TVL_RATIO_PCT=5%` and the volume-drop Option A/B 1h
  magnitudes are all low-confidence starting guesses — that's what the 6
  running instances are for.
- The volume-drop A+B-vs-false-positive tension (point 5 above) is
  explicitly unresolved, not just untuned.
- `trend`/`range` `ENTRY_STRATEGY_MODE`s and the spot executor are both
  brand new this session and **unvalidated over time** — only anecdotal
  same-night confirmations so far (SI-SOL, PAID-SOL, baton-SOL), not a
  multi-episode track record.
- The LP-vs-spot cost comparison (spot executor's whole reason for
  existing) is still confounded by the pre-fix re-screen whipsaw bug —
  needs a clean run on the fixed code before it means anything.
- ~~**`range` mode's candidate ranking is missing the fee-rate dimension
  entirely**~~ — **FIXED 2026-10-08, see that session's section below**
  (`RANGE_MIN_BASE_FEE_PCT` floor + `rankRangeCandidates` now sorts by
  `feeTvlRatio24h`). Left the original note below for the discussion
  context/history. Found while looking at the real HIGGS-SOL
  position (`DQyGMAGx8nB6ykixotLNFC6eVVQjrMqz7AkRyinNkEm1`, entered
  2026-10-07 23:59): user noticed its `base_fee_pct` is only 0.3% ("dikit
  banget"). Confirmed live against Meteora's own `/pools` API
  (`dlmm.datapi.meteora.ag/pools/<address>`) that the response already
  includes `pool_config.base_fee_pct`/`max_fee_pct`/`protocol_fee_pct`,
  `dynamic_fee_pct`, AND a pre-computed `fee_tvl_ratio` per window (30m/1h/
  2h/4h/12h/24h) — all free on the SAME API call `fetchTopPools()` already
  makes, but `normalizePool()` (`meteoraScanner.ts`) only extracts `tvl`/
  `volume`/`fees_$`/`bin_step` and discards the rest. `rankRangeCandidates`
  currently ranks by raw vol/TVL turnover with NO fee-rate multiplier at
  all — two pools with identical turnover but 0.3% vs 1% base fee rank
  identically today, even though the 1% pool yields ~3x more fee $ for the
  same capital. **Agreed fix (combined, not yet implemented)**: (a) add a
  modest floor on `pool_config.base_fee_pct` (discussed ~0.2%, NOT the
  user's initial 0.5% suggestion — a hard 0.5% floor risks rejecting a
  high-turnover pool with a lower rate that still out-yields a low-turnover
  0.5%+ pool) as a backstop against the lowest stable-pair-style fee tiers;
  (b) replace `rankRangeCandidates`'s raw vol/TVL turnover with Meteora's
  own `fee_tvl_ratio` (pick a window — 4h or 24h, TBD) as the ranking
  score, since it already captures both volume AND fee rate in one number
  — a strictly better proxy for range mode's actual "maximize fee yield"
  thesis. **Caveat found along the way**: Meteora's own `apr`/`apy` fields
  in the same response are NOT reliable — confirmed live on this exact pool
  they showed `apy: 3,086,522,374%` (a naive over-compounding of a volatile
  24h fee/TVL ratio, meaningless for decision-making). Use `fee_tvl_ratio`'s
  raw per-window values directly, never `apr`/`apy`.
- **`buyRatio1h` is a transaction-COUNT ratio, not a dollar-volume ratio —
  blind to "many small buys vs a few large sells" distribution/whale-dump
  patterns. Found 2026-10-08, NOT yet fixed, noted only.** User looked at
  the live HIGGS-SOL position and asked why buying volume looked so much
  lower than selling across every timeframe. Checked the code:
  `meteoraScanner.ts` computes `pair.buyRatio1h = h1Txns.buys / (h1Txns.buys
  + h1Txns.sells)` — purely a count of buy vs sell transactions, with zero
  weighting by how big each one is. Confirmed live on HIGGS at the time:
  tx counts actually favored buys at every window (h1 145/148, h6 904/792,
  h24 4975/4546 buy/sell) — the existing check would call this healthy —
  while the ACTUAL price was falling hard the whole time (h1 -9.04%, h6
  -10.46%, h24 -36.89%, confirmed via DexScreener at the same moment). That
  combination (tx-count ratio looks fine, price falling anyway) is the
  classic signature of a few large sellers outweighing many small buyers in
  dollar terms — exactly the risk a COUNT-based ratio structurally cannot
  see. **Why it's not simply fixed**: DexScreener's public `/pairs` endpoint
  (our data source for this field) only exposes `txns.{buys,sells}` as
  counts and an undifferentiated total `volume` — no buy-volume vs
  sell-volume split is available from it. A real fix needs either a
  different data provider that exposes a per-side dollar-volume split, or
  parsing individual on-chain swap transactions ourselves to classify each
  by direction and size — more engineering than swapping a field name.
  Not yet scoped or designed, just flagged as a real, confirmed gap to
  revisit in a future batch.

