# Opportunistic Pool-Switching + Trailing Take-Profit — Design

Date: 2026-09-23
Status: Approved by user, pending implementation plan.

## Problem

The bot is single-pool, reactive: it only scans the full market for a new
pool when it has no open position (`MAX_CONCURRENT_POOLS=1`, scan on entry
or during a forced-rebalance re-screen). While holding a position — which
can be many hours — it never re-evaluates whether a much better opportunity
has appeared elsewhere. Concrete case: JEANPHIL-SOL ran from ~$80k TVL /
$2M mcap to $269k TVL / $7.5M mcap (per user's own DexScreener check, 6h
volume up to $4M) while the bot's capital was locked in an unrelated
position (baton → SI → Stamp → QUEEF). The bot had zero chance to notice or
act on it, regardless of how good its entry-screen logic is, because
`filterAndRankPools()` is never run against the full market while a
position is open — the per-tick `fetchTopPools()` call already fetches all
200 pools' data every tick, but throws it away except for the one
currently-held pool.

In memecoin trading not every token becomes a "runner" — sitting locked in
a mediocre position while a real runner passes by is a real, recurring
cost, not a one-off.

Separately: once a position IS a big winner, the bot has no mechanism to
protect gains — a stop-loss (`STOP_LOSS_PCT=25%` unrealized loss) exists,
but nothing stops a +50% winner from riding all the way back down to a
loss before either the stop-loss or a rebalance trigger fires.

## Goals

1. While holding a position, periodically compare it against the best
   currently-available market opportunity, and switch if the alternative
   is clearly, not marginally, better.
2. Protect an already-large unrealized gain from fully round-tripping back
   to a loss, via a trailing profit-lock exit — without permanently
   excluding that pool from being re-entered if its run continues.
3. Do both without materially increasing DexScreener API load (a 429-storm
   root cause was already identified and must be fixed as part of this
   work, not worked around).

## Non-goals

- No wallet-clustering / sniper-detection / deployer-history screening
  (still an explicitly deferred gap per project history — unrelated to
  this feature).
- No ATR/volatility-scaled trailing-stop (research surfaced this as
  theoretically better, but user explicitly chose a fixed-percentage
  trailing stop for simplicity; flagged as a future upgrade path, not
  built now).
- No multi-position support. `MAX_CONCURRENT_POOLS` stays 1 — switching
  means fully exiting one pool before entering another, never holding two
  at once.

## Design

### 1. Opportunity scan (every 5 minutes, while holding a position)

A new timer, independent of the existing position-health tick (15s real
bot / 60s paper-trade). Every `OPPORTUNITY_SCAN_INTERVAL_MS` (5 min):

1. `fetchTopPools()` — already-existing full market fetch.
2. Hydrate trend/volume/tx-count data for the currently-held pool AND all
   scan candidates via the DexScreener **batch** endpoint
   (`/tokens/v1/{chainId}/{tokenAddresses}`, ≤30 addresses/call) instead of
   today's one-call-per-pool pattern. This is the fix for this week's
   429-storms (root cause per research: request-count, not interval) and
   benefits the existing entry-screen hydration too, not just this new
   scan.
3. Run `filterAndRankPools()` to get the top-ranked candidate (existing
   two-stage trend-then-spike logic, unchanged).
4. Compute `volumeSpikeRatio()` (existing function) for both the
   currently-held pool and the top candidate, using data hydrated in the
   same batch call (apples-to-apples freshness).

### 2. Switch decision

Checked only at the 5-minute opportunity-scan cadence (not every tick).
Order of checks (first match wins):

1. Candidate is the same pool as the one currently held → no switch.
2. Currently-held position's unrealized profit ≥ `SWITCH_PROFIT_GUARD_PCT`
   (**30%**) → no switch, regardless of candidate quality. Protects an
   already-large winner from being abandoned for an unproven candidate.
3. Time since the last switch < `SWITCH_COOLDOWN_MS` (**15 min**) → no
   switch. Anti-whipsaw; independent of and stacked on top of the 5-minute
   scan cadence itself.
4. Candidate's `volumeSpikeRatio` ≥ current position's `volumeSpikeRatio`
   × `SWITCH_SPIKE_RATIO_MARGIN` (**1.5**) → **switch**.
5. Otherwise → no switch (hold).

### 3. Switch execution

Mechanically distinct from `compoundCycle` (which reopens in the *same*
pool). A switch:

1. Closes the current position fully (claim fees + reclaim rent) and
   converts everything to SOL — same primitive `compoundCycle` uses for
   its "pool no longer eligible" branch.
2. Opens a new position **directly in the specific candidate pool already
   identified and validated in step 1** — not a fresh from-scratch
   re-scan. The candidate was just validated against the full entry screen
   moments ago; re-scanning again would only risk it no longer being found
   due to normal market movement in the intervening seconds, for no
   benefit.
3. Logs the switch with both pools' identities and the spike-ratio
   comparison that triggered it (for later auditing, matching the
   `poolRejectReasons`-style transparency already established this
   session).
4. Updates `lastSwitchAtMs` to start the 15-minute cooldown.

No blacklist involved — switching away from a pool is not a violation, the
same policy already used for "pool no longer passes entry screen" exits.

### 4. Trailing take-profit (`TAKE_PROFIT` decision, independent of switching)

Applies to every held position regardless of whether an opportunity-scan
ever finds a better candidate — this is pure downside protection on an
existing winner, checked every ordinary tick (no new interval needed, it's
cheap: no external API call, uses the same mark-to-market `currentValueUsd`
already computed every tick).

- Track `peakProfitPct` per position: `max(peakProfitPct, currentProfitPct)`
  each tick, reset on entry/compound/switch (a fresh position starts a
  fresh peak).
- "Armed" once `peakProfitPct >= TAKE_PROFIT_ARM_PCT` (**30%** — same
  number as the switch profit-guard, not a coincidence: both exist to
  protect a position once it's a proven winner).
- Once armed, floor = `peakProfitPct - TAKE_PROFIT_GIVEBACK_PCT`
  (**25 percentage points**, e.g. peak +50% → floor +25%; if peak later
  rises to +80%, floor rises to +55%. Research found the user's original
  50%-giveback instinct sits well outside the 15–30% range practitioners
  and trend-following literature converge on for volatile assets — 25% is
  the compromise value, confirmed with the user).
- If `currentProfitPct <= floor` while armed → **TAKE_PROFIT**: close,
  claim, convert to SOL. **No blacklist** — this is a profit-protection
  exit, not a risk violation; the pool stays a fully valid candidate for
  the very next scan if its run continues.

Decision-tree priority per tick (`riskManager.evaluatePosition`, extended):
`HARD_EXIT` (stop-loss / anti-thrash / volume-drop, unchanged, highest
priority) → `TAKE_PROFIT` (new) → `REBALANCE` (fee-threshold /
idle-forced, unchanged) → `HOLD`. `SWITCH` is evaluated separately, only at
the 5-minute cadence, and only reachable from `HOLD`/`REBALANCE`-eligible
states (a `HARD_EXIT` or `TAKE_PROFIT` tick exits before the switch check
ever runs). `HARD_EXIT` and `TAKE_PROFIT` can never both apply in the same
tick (one requires a loss, the other a large unrealized gain) — no
ordering conflict there.

## Components touched

- `src/config/env.ts` — 6 new config values: `OPPORTUNITY_SCAN_INTERVAL_MS`
  (5 min), `SWITCH_SPIKE_RATIO_MARGIN` (1.5), `SWITCH_PROFIT_GUARD_PCT`
  (30), `SWITCH_COOLDOWN_MS` (15 min), `TAKE_PROFIT_ARM_PCT` (30),
  `TAKE_PROFIT_GIVEBACK_PCT` (25).
- `src/services/meteoraScanner.ts` — replace `hydrateTrendData`'s
  one-call-per-pool DexScreener loop with the batched
  `/tokens/v1/{chainId}/{tokenAddresses}` endpoint (≤30 addresses/call,
  sequential batches, no concurrency wrapper needed). New function to run
  a full-market opportunity scan and return the top candidate + its
  `volumeSpikeRatio`.
- `src/logic/riskManager.ts` — extend `RiskDecision` with `'TAKE_PROFIT'`;
  add `peakProfitPct` tracking input; add the armed/floor check.
- `src/logic/rebalanceEngine.ts` (real bot) — new `executeSwitch(ctx,
  candidatePool)` composing existing close/convert/open primitives; new
  `executeTakeProfit(ctx)` (close/convert, no blacklist — likely shares
  most of `executeHardExit`'s body minus the `addToBlacklist` call, worth
  extracting a shared helper rather than duplicating).
- `src/index.ts` (real bot) — wire the 5-minute opportunity-scan timer
  alongside the existing 15s health-check loop; wire `TAKE_PROFIT` into the
  existing decision switch.
- `src/scripts/paperTrade.ts` — mirror all of the above in the simulator
  (own `lastOpportunityScanAtMs` / `lastSwitchAtMs` / `peakProfitPct`
  module/position state, own logging for `SWITCH` and `TAKE_PROFIT` events
  matching the existing `ENTER`/`HOLD`/`REBALANCE`/`LEAVE_POOL`/`HARD_EXIT`
  event-log vocabulary).

## Error handling

- DexScreener batch call fails (network/429/malformed response): same
  "unknown, don't block" policy already used throughout the scanner — the
  opportunity-scan simply finds no qualifying candidate this cycle (falls
  through to HOLD), never crashes the tick loop. Matches existing
  `hydrateTrendData`'s try/catch-per-pool posture, adapted to a
  try/catch-per-batch.
- Batch endpoint returns fewer results than addresses requested (a pool
  DexScreener doesn't recognize): those pools simply keep their DexScreener
  fields `undefined`, same fallback semantics already in place everywhere
  else in the scanner.
- Switch execution fails partway (e.g. close succeeds, new open fails):
  out of scope for this design to fully solve — matches the existing
  `compoundCycle`/`executeHardExit` risk profile already accepted in this
  codebase (paper-trade has no real transactions to fail; the real bot's
  existing error handling around `openPosition`/`closePositionFull`
  applies unchanged, this doesn't introduce a new failure class).

## Testing / verification

- Paper-trade is the validation vehicle, as it has been all session — no
  new test framework introduced (project has none, consistent with
  established pattern this session: `tsx`-based smoke checks, not a
  committed test suite).
- Before wiring into the live 5-minute timer, verify with a standalone
  script call (same pattern used throughout this session) that:
  `volumeSpikeRatio` comparison behaves correctly (candidate ratio ≥ 1.5×
  current → switch; below → hold).
  Trailing floor math is correct at a few worked peak values.
  Batched DexScreener hydration returns the same shape of data
  (`priceChange1h/6h`, `volume.m5/h1/h6`, `txns.m5`) as the current
  per-pool calls, for a known multi-pool batch.
- Full paper-trade run afterward (multi-hour, as has been the practice all
  session) to observe real SWITCH/TAKE_PROFIT events end-to-end before any
  live-money consideration.

## Open risks / deferred

- No academic/backtested validation of the 30%/1.5x/15min/25% numbers
  specifically for DLMM LP — all sourced from general crypto-momentum
  practice (see research citations from this session) and the user's own
  judgment, not a proven-optimal configuration. Expect to retune after
  observing real paper-trade behavior, same as every other threshold this
  session.
- ATR/volatility-scaled trailing stop (vs. this design's fixed
  percentage) was flagged by research as generally superior for
  variable-volatility assets — explicitly deferred, not built now.
- The opportunity-scan's "top candidate" reuses the existing two-stage
  trend-then-spike ranking as-is; it does not (yet) also consider whether
  the CURRENTLY HELD pool would itself still rank #1 if re-scanned (a
  "B: moderate" comparison mode considered and rejected earlier in this
  design conversation in favor of the simpler 1.5×-margin rule).
