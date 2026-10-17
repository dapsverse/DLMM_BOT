# meteora-dlmm-bot — session context (2026-10-11)

**CURRENT STATE (2026-10-11, supersedes the older status paragraphs below):** real-money `range` mode bot is RUNNING
(wallet `<LIVE_WALLET_ADDRESS>`, `INITIAL_LP_CAPITAL_SOL=1`, kill-switch `MIN_EQUITY_STOP_SOL=1`, checked only while flat).
Branch `feature/trend-aware-entry`, no remote/PR yet. Net wallet PnL since funding (1.6522 SOL): about -0.31 SOL (-19%) as of 2026-10-10 23:44 UTC, recovering
(low ~1.17 SOL on 10-09, 1.3376 SOL on 10-11). Meteora's own PnL is +0.20 SOL; the ~0.51 SOL gap is swap friction (see 2026-10-10/11 section).
Standing user rules: restart the live bot without asking whenever it is FLAT (never with an open position: no resume-on-boot, kill does not close positions);
no cooldown after exits; profit guard and range-upper-bound behaviour are deliberately DEFERRED.

Single-pool auto-compounding Meteora DLMM LP bot for Solana memecoin pools.
**As of 2026-10-08: REAL MONEY IS LIVE, bot currently STOPPED (deliberately)
for a batch fix.** First real-capital cycle started 2026-10-07 (wallet
`<LIVE_WALLET_ADDRESS>`, `range` mode,
`INITIAL_LP_CAPITAL_SOL=1.3`). 6 real bugs found and fixed live against
actual mainnet transactions on 2026-10-07 (logger silently swallowing all
output, gas reserve not subtracted on first entry, DLMM SDK ComputeBudget
duplicate-instruction rejection, 1000x token-value undercounting from a
hardcoded 9-decimals assumption, a real balance-race causing a SOL-only
"phantom position", and a bin-radius SDK ceiling causing "InvalidRealloc").
A 7th bug (opportunistic SWITCH not gated to momentum-only in the real bot)
fired live and triggered an 8th (`currentPool` state desync after an
exit/reopen call throws post-close) that recurred twice before being fully
root-fixed. **2026-10-08: 3 more real bugs found via live log tracing
(Jupiter swap retrying a stale already-expired VersionedTransaction instead
of rebuilding fresh — likely the dominant cause of nearly every "block
height exceeded" failure all session; the bin-slippage retry bug reusing a
stale active-bin snapshot across retries; and the 8th bug's remaining gap),
PLUS a user-requested range-mode ranking upgrade (rank by Meteora's own
feeTvlRatio24h instead of raw vol/TVL turnover, + a base-fee-rate floor) and
a user-requested fee-handling change (keep the fee-sized token portion
unswapped on every close instead of auto-dumping it to SOL). All 8 are now
fixed and verified (tsc clean, 24 self-checks pass, build clean) — see the
"2026-10-08 session: batch fix" section (near the bottom, before "Next
steps") for full detail. **Bot is currently stopped, position-free,
pending a decision on `.env.live`'s capital/gas-reserve split before
relaunch** (balance has drifted down to ~1.4007 SOL — see that section for
the exact trade-off this creates against the user's fixed `1.3` capital
instruction).**
**As of 2026-09-29: spot executor dropped, focus is DLMM-only (`range` vs
`momentum` mode) — see the "2026-09-29 decision" section below for why and
for the current running-instance list. Sections above/before it (instance
lists mentioning spot/trend-optAB-spot, etc.) are historical, superseded.**
**As of 2026-09-30: 3 more real bugs found/fixed (DexScreener hydration
fallback, range mode TVL floor + profit-aware ceiling override, chase
guard against buying back a token above its own last exit price) — see the
"2026-09-30 session" section (near the bottom, before "Next steps") for
the full detail. This is the current commit (`65f8534`) and the current
go-live clock status (misses the Friday target, see that section).**
**Real-capital plan revised 2026-09-28: 1.3 SOL total (1.2 SOL working
capital / 0.1 SOL gas reserve)** — down from the original 5 SOL design
(4.2/0.8), user's call, start smaller for the first real cycle. Paper-trade
validation runs are sized to match exactly: `INITIAL_LP_CAPITAL_SOL=1.2` /
`MIN_GAS_RESERVE_SOL=0.1`. See "Go-live criteria (real capital)" below for
what "ready" actually means before this plan gets executed. This file is the
handoff — **read it before doing anything else in
a fresh session.** Four sessions of work are folded in here (2026-09-22
baseline, 2026-09-23 opportunistic-switching, 2026-09-24 → 2026-09-25
pump-detection/volume-drop/capital-sizing, 2026-09-26 entry-strategy-modes +
spot-executor A/B) — this file supersedes the previous version entirely.
**Note: the 2026-09-26 work below was reconstructed from code/logs after the
session's own context was lost to `/clear` before being saved — re-verify
against the actual diff (`git status`/`git diff`) if anything here looks
off, don't just trust this summary blindly.**

**For the full current entry-screen parameter reference (every filter,
value, unknown-data policy, and why), read `SCREEN_RULE.MD` — it's kept in
sync every session and is the source of truth for "what does the screen
actually do right now." This file is the narrative/handoff; that file is
the spec.**

## Where things stand right now

- **Git**: still local-only, `main` has **zero commits on purpose** (never
  commit directly to main). All work is on `feature/trend-aware-entry` —
  current branch, matches the entry-strategy-mode work below. 42 commits on
  top of the original baseline scaffold as of `77735d5`.
  **Update 2026-09-30: the 2026-09-26 uncommitted work described below WAS
  committed** (this paragraph is otherwise historical/stale, kept for
  narrative continuity — see git log for the real commit history). Working
  tree is clean as of commit `65f8534` (2026-09-30) — see the "2026-09-30
  session" section further down for what that commit contains. No PR
  opened yet (no git remote configured).
- **Five live paper-trade instances running right now** (restarted this
  session on the new entry-strategy-mode code), all on the SAME capital
  config (`INITIAL_LP_CAPITAL_SOL=1.15`, `MIN_GAS_RESERVE_SOL=0.1`). This
  REPLACES the prior 6-instance strict-vs-loose comparison — the strictness
  axis (strict/loose `ENTRY_MIN_SPIKE_RATIO`/`ENTRY_MIN_BUY_RATIO_1H`) was
  dropped in favor of the new `ENTRY_STRATEGY_MODE` axis (momentum/trend/range,
  see the 2026-09-26 section below) crossed with LP-vs-spot execution:
  - `strict-optA-spot` / `strict-optB-spot` / `strict-optAB-spot` —
    `ENTRY_STRATEGY_MODE=momentum` (default, name kept from the old
    strict/loose naming but now just means "default gates"), spot executor
    only (`ENABLE_LP_EXECUTOR=false`, `ENABLE_SPOT_EXECUTOR=true`). `optA`/
    `optB`/`optAB` suffix = same volume-drop-baseline fix axis as before
    (`VOLUME_BASELINE_REFRESH_MS`/`VOLUME_DROP_GRACE_MS`, still a
    low-confidence starting guess).
  - `trend-optAB-spot` — `ENTRY_STRATEGY_MODE=trend`, spot executor only,
    both volume-drop fixes on.
  - `range-optAB` — `ENTRY_STRATEGY_MODE=range`, **LP/DLMM executor**
    (default toggles: `ENABLE_LP_EXECUTOR=true`, `ENABLE_SPOT_EXECUTOR=false`)
    — the one instance testing the DLMM execution path, deliberately paired
    with `range` mode since that's the thesis LP is actually supposed to be
    good at (see below). Both volume-drop fixes on.
  - Check anytime with `npm run paper-trade:report` (auto-cleans orphaned
    state files). As of this write-up: `trend-optAB-spot` +32.81% (PAID-SOL,
    entered on trend mode's sustained-6h/24h floor — momentum instances
    rejected it outright on the spike floor, 0.281 < required; range
    instance rejected it on the volatility ceiling, 40%/60% >> 15% cap),
    `range-optAB` +2.73%, `strict-optA-spot` -2.95%, `strict-optB-spot`
    -10.81%, `strict-optAB-spot` -40.08% (HARD_EXIT stop-loss on pill-SOL,
    then re-entered COLLECT-SOL from a lower basis). Only ~17min old at that
    point — noise-dominated, not yet a real comparison.
  - The prior 6-instance strict-vs-loose run and the `cap1.15-reserve0.1`
    frozen baseline before it are both retired — superseded by this set.
- **RPC swapped from the public Solana endpoint to the Helius key from
  `.env.live`** (paper-trade only touches RPC for reads — mint-authority
  checks, active-bin lookups — never the wallet, so this is safe with no
  funds at risk). Was needed because 6 concurrent instances + the public
  endpoint's documented fragility (confirmed: 1 diagnostic script alone
  429-stormed it) would have been unreliable. Helius has handled 6-way
  concurrent load fine so far (occasional isolated 429s, always resolved
  by the existing retry/backoff, no sustained storms).
  ⚠️ **A Helius API key was accidentally exposed once this session** via an
  automatic file-diff tool notification (not a command Claude ran
  deliberately) — user was informed live and chose to continue without
  rotating it (their call, key is dev/pre-funding). If this repo/session
  history is ever shared outside this environment, that key should be
  treated as compromised and rotated.
- **Real-money setup is prepped but NOT started, unchanged.** `.env.live`
  exists (gitignored, real Helius RPC key + real wallet private key
  already filled in). **Nothing has been sent to the wallet.** Confirm
  balance before ever running `npm start` against `.env.live`. Everything
  this whole session was validated via paper-trade only.

## 2026-09-24 → 2026-09-25 session: pump-detection, a real production-risk
   bug fix, volume-drop-baseline staleness, capital-scaled TVL sizing

This was a long, iterative, heavily data-driven session — every change
below was made in response to a concrete live observation, not
speculatively. Full blow-by-blow (including exact numbers, timestamps, and
counter-examples where a fix's own downside showed up live) is in the
conversation history; this is the compressed version. **`SCREEN_RULE.MD`
has the authoritative current value of every parameter mentioned here.**

**1. Fixed a pool-selection bug that let clearly bad entries through**
(`dexHydrationFailed`, landed 2026-09-23 evening, folds forward into this
session's testing): a failed DexScreener batch call left trend/tx fields
`undefined` for a whole batch of pools, and the "unknown data, don't
block" policy let them through unscreened. Confirmed live: STONK10-SOL
entered with a real 5-minute tx count of 4 against a floor of 20.

**2. "Detect the pump earlier" rework (P0-P4)** — user observed entries
consistently landing near a local top then dropping sharply. Root cause:
the ranking sorted candidates by raw `priceChange6hPct` (biggest
cumulative mover) — for a mean-reverting memecoin that selects pools
near/past their peak, not pools about to move. Rewrote `rankCandidates()`
to sort by `volumeSpikeRatio` (acceleration) instead, added an
overextension ceiling (`MAX_PRICE_CHANGE_1H_PUMP_PCT`), an entry-only
absolute spike floor (`ENTRY_MIN_SPIKE_RATIO`), a buy-dominance floor
(`ENTRY_MIN_BUY_RATIO_1H`, catches a $-volume spike that's actually a
sell-off), and full decision-context logging on every ENTER/SWITCH event
(P0) so this kind of after-the-fact analysis never has to guess again.

**3. Idle-forced-rebalance debounce fix** — a position sitting right at
its range boundary flickered in/out on ordinary noise, and the old logic
reset the out-of-range timer on ANY single in-range tick, so
`MAX_IDLE_OUT_OF_RANGE_MINUTES` never got a clean streak. Now requires
`OUT_OF_RANGE_RESET_GRACE_MS` (2 min) of continuous in-range before
actually resetting. Shared logic module `logic/outOfRangeTracking.ts` —
deliberately NOT in `rebalanceEngine.ts` itself, because that module
transitively imports `services/solana.ts` (decodes `PRIVATE_KEY` at
import time), and paper-trade must stay wallet-free.

**4. Real production-risk bug found and fixed: paper-trade's stop-loss/
take-profit basis was resetting on every compound.** User noticed
instance A's cumulative profit swung 35%→20% without take-profit ever
arming. Investigation (verified against the real bot's actual code path
line-by-line before concluding anything, since a wrong call here risks
real money) found: `index.ts`/`rebalanceEngine.ts` always use
`ctx.initialDepositSol` — set once at first entry, **never** touched by
`compoundCycle` — as the basis for both `STOP_LOSS_PCT` and
`peakProfitPct`/`TAKE_PROFIT`. Paper-trade used `position.capitalUsd` for
the same job, which DOES reset every compound (correctly, for its own
price-ratio simulation math) — so paper-trade's stop-loss/take-profit were
silently measuring "since the last compound," not "since the original
deposit," **understating how protective both are in production.** Fixed
by adding a separate `VirtualPosition.initialDepositUsd` (mirrors
`ctx.initialDepositSol` exactly — set once, never reset on compound).
**Verified zero production risk**: grepped every write site of
`initialDepositSol`/`peakProfitPct` across the whole codebase before
touching anything; the real bot never had this bug, it was paper-trade-
only. This is exactly the kind of thing that would NOT have been caught
without running paper-trade long enough to see a real compound-heavy
episode — a lesson for how long to paper-trade before going live.

**5. Two toggleable fixes for a stale volume-drop baseline.** Comparing
two instances, both turned out to enter the SAME pool near-simultaneously
and both got `HARD_EXIT`'d ~31s apart for the identical reason ("1h volume
dropped ~63%"). Root cause: `volume1hBaselineUsd` is captured once at
entry and **never refreshed** for the position's whole life — worse in the
real bot than expected, since `compoundCycle` never touches it at all
(only fresh entry/switch does). Entering during a volume spike (which the
entry-spike-floor above now actively selects for) pins the baseline at an
inflated level; normal spike decay over the next 1-3h then reads as a
false-positive `HARD_EXIT`. Two independently toggleable env vars (both
default 0/off, so original behavior is unchanged unless explicitly
enabled):
  - `VOLUME_BASELINE_REFRESH_MS` — periodically refresh the baseline while
    holding. Root-cause fix; trade-off is a too-frequent refresh makes the
    check nearly blind to a genuinely fast real volume collapse.
  - `VOLUME_DROP_GRACE_MS` — suppress the check for N ms after the
    baseline was last set. Simpler, but only delays enforcement.
  - **Live A/B/AB result on one clean controlled episode** (3 instances
    entered the same pool within seconds, same entry price basis): Option
    A alone did nothing (refresh interval longer than the time-to-trip).
    Option B alone delayed the exit by ~11 minutes then it fired anyway.
    **A+B combined actually held** — B bridged the gap until A's first
    refresh fired, which then permanently fixed the reference point.
  - **But a very real counter-finding on the SAME episode**: the two
    instances that got the "false positive" exit accidentally locked in a
    profit near the position's actual local price peak, while the
    surviving A+B instance rode the position's later full round-trip back
    down into an unrealized loss (peak +10.4% → back to -1.5%). Volume-drop
    is an activity signal, not a price signal — it doesn't know about
    price tops. This episode's false-positive coincidentally acted as a
    decent price-reversal proxy; the "fixed" version had no equivalent
    signal available (TAKE_PROFIT never armed, peak was only ~10%, well
    under the 30% arm threshold) and just held through the reversal.
    **Verdict: genuinely unresolved, needs many more episodes to know if
    A+B nets out ahead on average** — this is exactly why the 6-instance
    comparison exists, not to declare a winner from 1 sample.

**6. `MAX_CAPITAL_TVL_RATIO_PCT` replaces the fixed-dollar `MIN_TVL_USD`
floor as the real slippage-safety gate.** User asked why the bot never
enters ~$300k-mcap tokens. Traced to `MIN_TVL_USD` — but the real issue is
that a fixed dollar floor doesn't know how big our capital actually is.
Confirmed live: 6 of 7 sampled ~$300k-mcap pools sat on $472-$22,632 TVL
(below even a lowered $35k floor) despite being completely safe for our
~$130 paper-trade capital (0.3-3.3% capital/TVL ratio) — the 7th
(MACCA-SOL, $472 TVL) was genuinely too thin (27.5% ratio) and correctly
still rejected by the new ratio-based check. `MIN_TVL_USD` dropped to a
$1,000 "not literally dead" backstop. The ratio scales automatically as
capital compounds — no manual re-tuning needed as the bot grows. Threaded
`currentCapitalSol` through the whole scan pipeline
(`scanPools`/`scanForBetterOpportunity`/`filterAndRankPools`) — entry
paths use idle capital, switch-evaluation paths use the position's live
current value (what would actually move), not the original deposit.
**Not yet validated live at 5% — low-confidence starting guess.**

**7. Paper-trade "Fees only" display gap (display-only, not a PnL bug)** —
the cumulative fees-earned figure only accumulated on realized events
(claim/compound/exit); a still-open position's currently-accruing
unclaimed fee wasn't folded into that ONE display line until realized,
even though the main PnL number was already correct (it independently
includes unclaimed fees via `lpPrincipalUsd + position.feesEarnedUsd`).
Fixed by adding the open position's live unclaimed fee on top for display,
without touching the underlying realized-only accumulator.

**Self-checks added this session** (no test framework in this repo — plain
`assert`, run via `tsx`): `checkDexHydrationGate.ts`, `checkSwitchGuards.ts`,
`checkEntryPumpGuards.ts`, `checkRankCandidates.ts`,
`checkOutOfRangeDebounce.ts`, `checkVolumeDropGuards.ts` (run twice — once
plain for disabled, once with `VOLUME_DROP_GRACE_MS` set for enabled — ESM
module caching means one process can't exercise both), `checkCapitalTvlRatio.ts`.
All pass as of `42dde55`. Also added `src/scripts/diagnoseRejections.ts` —
a permanent diagnostic (not a one-off) that tallies *why* pools are getting
rejected across the whole top-pools list, for whenever `NO_CANDIDATE` needs
a real answer instead of a guess. Deliberately skips the RPC-heavy
mint-authority check (running it against ~150+ pools instead of a small
pre-filtered subset 429-storms the RPC — confirmed running it once).

## 2026-09-26 session: entry strategy modes (trend/range) + spot executor A/B
   (uncommitted — see git status note above)

**Context this session started from**: prior sessions' `momentum` mode
(spike-ratio floor + acceleration ranking) was validated as directionally
right, but two new live observations motivated splitting it into three
parallel, independently-selectable tracks instead of one-size-fits-all.

**1. `trend` mode** — `ENTRY_STRATEGY_MODE=trend` skips the spike-ratio
floor entirely, requires `TREND_MIN_SUSTAINED_PCT` (default 20%) on BOTH 6h
AND 24h price change (fail-closed on unknown, unlike almost every other
filter in the screen), ranks survivors by TVL descending
(`rankTrendCandidates`) instead of acceleration. Motivation confirmed live
2026-09-25/26: SI-SOL's real pool ($685k TVL, +66%/6h, +46%/24h, mcap
6M→9M over 9h, spike ratio only 0.21x) was rejected by every running
`momentum` instance on the spike floor alone, the same night every
"new spike" `momentum` entry (goon-SOL, AQUA-SOL, OP-SOL, etc.) crashed
-12% to -50%. `momentum`'s spike floor structurally can't hold a steady,
already-successful winner — `trend` is the parallel track for that case.
Confirmed again today (2026-09-26) live: PAID-SOL (volumeSpikeRatio 0.281,
priceChange 1h/6h/24h = 40.4%/59.62%/84.41%) was rejected by all 3
`momentum` instances on the spike floor and by `range` on the volatility
ceiling, entered ONLY by `trend` — currently +32.81%, the best performer of
the 5 running instances.

**2. `range` mode** — the opposite thesis, and specifically scoped to the
**DLMM/LP execution path** (not spot — see point 3). Rejects any candidate
moving more than `RANGE_MAX_VOLATILITY_PCT` (default 15%) on EITHER 1h or
6h, ranks by vol/TVL turnover descending (`rankRangeCandidates`, a direct
fee-yield proxy). Uniquely, the volatility ceiling stays live on
re-screen — every other sizing check in the screen is skipped for a held
position (`skipSizingChecks`), but a range position that starts trending
broke its own thesis, so this one keeps checking. Motivation confirmed
live 2026-09-26: `momentum`-mode DLMM instances were consistently losing
**~half as much** as their spot siblings on a losing position (the 50/50
SOL/token LP basket + IL dampens both directions ~2x) — meaning DLMM run
against a directional/momentum target is structurally just a smaller,
cost-heavier version of holding the token outright. LPing's real edge (fee
income on range-bound/stable pairs, where IL costs near-nothing) was never
actually being tested — `range` isolates that thesis to the one instance
(`range-optAB`) actually running the LP executor this round.
Opportunistic switching (`evaluateSwitchOpportunity`) is skipped for both
`trend` and `range` positions — spike-ratio switching doesn't fit either
non-acceleration thesis.

**3. Spot (buy→hold→sell) executor added as an A/B against the LP wrapper
itself** (`src/logic/spotExecutor.ts`, 461 lines) — motivated by paper-trade
data showing every running LP instance's rebalance + entry/exit tx costs
exceeding its fee income. `ENABLE_LP_EXECUTOR`/`ENABLE_SPOT_EXECUTOR` env
toggles (default LP-only, unchanged behavior unless spot is explicitly
turned on) let both executors run off the SAME scanned candidate/tick per
process, for an apples-to-apples LP-vs-spot comparison with no entry-price
confound. When spot is on, its paper-trade label auto-suffixes `-spot`
(`paperTrade.ts:145`) so both sides' state/log files coexist and
`paperTradeReport.ts` picks up either with zero changes (a position with no
`bin` field just renders without a range line). Spot reuses the exact same
decision signals as DLMM (`rankCandidates`/`filterAndRankPools`,
`evaluatePosition`/`evaluateSwitchOpportunity`) — only the mechanics differ:
no bin range, no rebalance, no IL, no LP fee income;
`estimateSpotSwapCostSol()` (new, `costEstimate.ts`) prices one full-capital
swap leg instead of the half-capital LP-deposit-ratio math
`estimateCycleGasCostSol` does.
  - **Live finding, already causing a real problem and partially fixed
    this session**: spot has no "out of range" signal to force a periodic
    re-screen on DLMM's own timer, so it rides the shared
    `OPPORTUNITY_SCAN_INTERVAL_MS` cadence instead — and an early version
    that acted on a single failed 5-min-window snapshot whipsawed spot
    instances into 14-25 entries/9h vs. DLMM's 4-9/9h on the same night,
    costing enough in round-trip fees alone to drive spot to -40%..-70% vs
    DLMM's -31%..-43% on THE SAME bad night. Two fixes landed: (a) require
    2 consecutive failed re-screens (~10min sustained) before acting, same
    debounce philosophy as DLMM's idle-out-of-range timer; (b) a profit
    guard (`shouldForceLeaveOnFailedRescreen`) — unlike DLMM's `LEAVE_POOL`
    (only reachable after price already left the bin range, itself a
    concrete signal), spot's re-screen runs on a blind timer regardless of
    whether the position is winning, so a currently-profitable position
    now holds through a failed re-screen instead of being forced out.
    Confirmed live 2026-09-26 pre-fix: `trend-optAB-10sol-spot` sold
    baton-SOL at a real -2.3% loss on a transient "5m tx count 3 < min 20"
    dip, right before its DLMM sibling (which never even re-screened —
    price stayed in-range) rode the SAME pool to +3.89%.
  - **Caveat already flagged in `SCREEN_RULE.MD`**: the 14-25-vs-4-9
    entries/9h and -40%..-70%-vs-31%..-43% numbers above are an
    apples-to-oranges artifact of the pre-fix whipsaw bug, not yet a real
    LP-vs-spot signal — that comparison still needs a clean run on the
    fixed code (i.e. what the current 5 running instances are for).

**Self-checks added**: `checkSpotExecutor.ts`, `checkTrendMode.ts`,
`checkRangeMode.ts` — all pass as of this write-up (spot cost model + the
REBALANCE-unreachable invariant + stop-loss/take-profit + re-screen profit
guard; trend mode's spike-floor skip + fail-closed sustained-floor + TVL
ranking; range mode's volatility ceiling staying live on re-screen +
turnover ranking).

**Not yet validated**: whether `trend`/`range` actually beat `momentum`
over time (both marked unvalidated in `SCREEN_RULE.MD`), and the real
(post-whipsaw-fix) LP-vs-spot cost comparison — same "let it run, don't
declare a winner from one sample" methodology as every other unvalidated
knob in this file.

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

## Go-live criteria (real capital) — added 2026-09-28

User asked directly: "is `range-optAB` ready for real money yet?" Answer at
the time (43.6h in, +9.21%, 9 closed positions, 0 hard exits): **no** — the
signal is genuinely encouraging but the sample is far too small to promote
a strategy on, and two real bugs (idle-capital bootstrap bypassing the
capital/TVL gate, LEFT_POOL whipsaw) had JUST been fixed with zero
validation time on the fix itself. These are the concrete bars to clear
before moving `.env.live` capital into a real cycle, for WHICHEVER strategy
(`momentum`/`trend`/`range`, spot or DLMM) is being promoted — don't lower
these just because one strategy currently looks best:

1. **≥30 closed positions** for the specific strategy being promoted, not
   combined across strategies. 9 is not enough to distinguish skill from
   variance.
2. **≥3 calendar days of continuous unattended runtime** (revised
   2026-09-29 from 4 days, revised from an initial 5 — user's call,
   targeting a Friday start if 1-8 all check out; the clock restarts from
   the 2026-09-29 dexId=meteora fix + spot-drop restart, since criterion 3
   requires zero code changes in the counted window — 2026-09-29 ~00:19 UTC
   + 3 days lands exactly on 2026-10-02, Friday), ideally spanning more than
   one visibly different market condition (a clear uptrend stretch AND a
   choppy/down stretch) — a single lucky window isn't evidence the edge
   generalizes.
3. **A full run in that ≥3-day window with zero code changes needed** —
   i.e. the last stretch of data has to come from code that wasn't itself
   still being debugged. Two real bugs were found and fixed THIS session
   alone (2026-09-27/28); the run that counts toward criteria 1-2 has to
   start clean AFTER the last fix, not include time before it.
4. **Net positive cumulative PnL after all costs** (fees, gas, slippage —
   already what the paper-trade PnL number reports) over that window.
5. **Peak-to-trough drawdown ≤20%** at any point in the qualifying window
   (not just at the end) — a strategy that was ever down 50% before
   recovering to +9% is not the same risk profile as one that was
   monotonic. `trend-optAB-spot`'s pre-fix run (peak-to-trough -80%+) is
   the cautionary example already on file.
6. **`MAX_CAPITAL_TVL_RATIO_PCT` (5%) and `RANGE_MAX_VOLATILITY_PCT` (15%)
   deliberately revisited with data**, not left at their original
   starting-guess values by default — even if the conclusion is "5%/15%
   turned out fine," that has to be an explicit, evidenced call, not an
   oversight.
7. **An explicit decision on rug/whale-concentration/sniper-dump
   screening** — currently NOT implemented at all (see "Known
   limitations" above). Either build a basic version, or write down why
   it's being accepted as an open risk anyway. Silent deferral isn't a
   decision.
8. **One supervised manual dry cycle on the real bot** (`.env.live`, real
   wallet, the actual 1.2 SOL capital) — watched closely start to finish
   through at least one full entry→exit, per the standing "no devnet
   dry-run, watch the first cycle closely" plan every session has agreed
   to. Passing 1-7 on paper-trade doesn't skip this; the real bot has
   NEVER executed a single real transaction as of this writing.

None of these are met yet for any strategy as of 2026-09-28. Re-evaluate
against this exact list (don't re-negotiate the bar down) once the current
1.2-SOL-capital paper-trade runs (started this session, whipsaw fix +
bootstrap fix both live) have had time to accumulate.

## 2026-09-29 decision: spot executor dropped, focus narrowed to DLMM only

User asked why the scanner only ever looks at Meteora-listed tokens even
though a token can trade on Raydium/PumpSwap/pump.fun long before (or
without ever) getting a Meteora DLMM pool. Investigated whether to broaden
discovery beyond Meteora's own `/pools` API, specifically for the spot
executor (which doesn't need a Meteora pool at all — it can buy anything
via Jupiter). Findings (full research trail in conversation history, not
reproduced here):

- **DexScreener cannot replace Meteora's `/pools` as a discovery source.**
  Confirmed against current docs (docs.dexscreener.com/api/reference,
  2026-09-29) and live: it has no "list/browse pairs" endpoint at all —
  only token/pair-address lookup and free-text search. Tried the obvious
  workaround (`q=solana`) live — returned wrapped-SOL pairs on Base/
  Ethereum/BSC, not Solana pairs at all. Also tried its internal
  (undocumented) API directly — `io.dexscreener.com/dex/screener/...` — got
  an immediate Cloudflare 403, i.e. actively bot-blocked, not just
  unsupported. Not viable at any reliability level.
- **Real alternatives exist** (Raydium's own `/pools/info/list` API — free,
  official, sortable by volume/liquidity; pump.fun — unofficial only, or
  paid third-party wrappers like Solana Tracker/Codex for genuine
  pre-graduation bonding-curve discovery) but each adds either a new paid
  vendor dependency or an unsupported/breakable API — a real cost/risk
  trade-off, not a free win.
- **Reframe (user's own conclusion, and the actual reason to stop here):**
  Meteora-only discovery is not an arbitrary limitation for the DLMM
  execution path — DLMM *requires* a Meteora pool to exist, so discovery
  and execution are already coherent for `range`/`momentum` modes. It's
  ONLY a real limitation for spot, which doesn't need Meteora at all. Since
  broadening spot's universe isn't cheaply achievable, and spot had
  separately been the worst performer all session (see `trend-optAB-spot`'s
  -77%+ run above) — **decision: drop the spot executor entirely, focus
  exclusively on DLMM `range` vs `momentum`.** `ENABLE_SPOT_EXECUTOR` stays
  in the codebase (still a valid toggle, still tested by
  `checkSpotExecutor.ts`) but no running instance uses it going forward
  unless this decision is revisited.

**Related fix landed same session** (real bug, not just the above
architecture question): `hydrateTrendData`/`getVolume1hUsd` queried
DexScreener by token mint, and DexScreener returns pairs from ALL DEXs a
mint trades on — the old "first match wins" behavior could hydrate a thin
Meteora pool's trend/momentum/crash-guard/volume-drop signals from a
completely different (possibly much busier) DEX's activity for the same
token. Fixed by filtering to `dexId === 'meteora'` specifically (DexScreener
pair objects already carry this field, just wasn't being used). TVL/volume
screening itself was never affected — that comes straight from Meteora's
own `/pools` API, only the DexScreener-sourced enrichment fields had this
gap.

**Current running instances as of this decision**: `range-optAB` (DLMM,
`range` mode) and `momentum-optAB` (DLMM, `momentum` mode, default —
active `evaluateSwitchOpportunity` switching, the one mode that has it),
both restarted fresh on the dexId fix. `trend-optAB-spot` killed, all its
logs deleted (not archived — decision is to drop it, not revisit later
without a fresh reason to). ADVANCEBOT's `vs-dlmmbot` ladder instance is
unaffected by this decision (separate codebase/strategy) and keeps running.

**Update same day, few hours later**: the Helius RPC key hit its limit
(sustained, non-recovering 429s for ~4.78h, confirmed zero progress across
ALL instances including ADVANCEBOT — worse than every prior burst this
session, which always settled within minutes). User swapped in a fresh
Helius key (both DLMMBOT's and ADVANCEBOT's `.env` `RPC_URL` updated,
value deliberately never printed to any tool output per the standing
secrets-handling rule) and asked to restart again, PLUS add two more DLMM
instances at **90 SOL capital** (`range-optAB-90sol`, `momentum-optAB-90sol`
— same modes/config as the 1.2 SOL pair, just `INITIAL_LP_CAPITAL_SOL=90`)
to see how the same strategies behave at a materially different capital
scale (90 SOL pushes the `MAX_CAPITAL_TVL_RATIO_PCT` floor ~75x higher than
at 1.2 SOL, likely a very different reachable pool universe). All 4 DLMM
instances + ADVANCEBOT restarted fresh on the new key.

**Same session, ~1.5h later — the REAL root cause found and fixed**: even
on the fresh Helius key, all 4 DLMM instances stayed at 429 storm /
zero-entries for 1.35h+ (1000+ 429s each) while ADVANCEBOT (same key) was
fine — pointed at DLMMBOT-specific RPC load, not the key itself. Traced to
`hydrateMintAuthority`'s per-candidate-pool direct Solana RPC `getMint`
call (rpc.ts's `isMintAuthorityRevoked`) — 4x the instances now running
this in parallel per scan tick was the dominant Helius load. Replaced with
RugCheck.xyz's free, unauthenticated single-token report API
(`src/services/rugcheck.ts`, `isMintAuthorityRevokedViaRugCheck`) — same
fail-closed-on-failure contract, verified live against a revoked mint
(BONK) and non-revoked one (USDC) before shipping. Old RPC version deleted
entirely (zero callers after the swap). Moves this load to a completely
separate rate-limit bucket instead of Helius. **Confirmed fixed**: 0 429s
across all 4 instances within 15s of restarting on the fix (previously
1000+ within 1.35h on the same fresh key). All 4 DLMM instances restarted
again on this fix; ADVANCEBOT untouched (separate codebase, wasn't
affected by this specific bug). **Go-live window clock restarted one more
time from this point** (2026-09-29 ~06:49 UTC — 3 days still lands
2026-10-02, Friday). This should be the last restart before the window
counts for real — infra is now believed stable.
**Superseded same day — see "2026-09-30 session" below: 3 more real bugs
were found and fixed that same infra-stable window, restarting the clock
again to 2026-09-30 ~00:02 UTC, which now misses the Friday target
(lands 2026-10-03, Saturday instead).**

## 2026-09-30 session: DexScreener hydration fallback + range mode TVL/profit refinements + chase guard

Continuation of the same 4-instance run (`momentum-optAB`, `range-optAB`,
`momentum-optAB-90sol`, `range-optAB-90sol`) from the 2026-09-29 dexId fix.
Three real, distinct bugs/gaps found and fixed, all from watching live
paper-trade behavior — no speculative changes. Committed as `65f8534`.

**1. The 2026-09-29 dexId==='meteora' fix had a real regression.** After
3.68h of zero entries across all 4 instances (both `momentum` and `range`
screens independently returning "no candidate"), investigated whether
RugCheck's own rate limit was the new bottleneck (tested directly: 90 mints
at concurrency 4 resolved cleanly in 8.7s, 0 failures — ruled out). Traced
instead to `hydrateTrendData`: the `dexId === 'meteora'` filter (correct in
principle, fixes cross-DEX contamination) left **77/94 (82%) of real
candidates with zero DexScreener data at all** — confirmed live for
PAID-SOL/ANSEM-SOL/HOOKED-SOL/STOXES-SOL specifically, each a genuinely
live, high-volume Meteora pool per Meteora's own API, but DexScreener's
token-lookup endpoint only returns their `pumpswap`/`meteoradbc` pair, never
a `meteora`-tagged one. With no `volumeH6Usd` ever hydrated,
`volumeSpikeRatio` hard-defaults to 0 — guaranteed momentum-floor rejection
regardless of real market strength, and likely degraded trend/range's
DexScreener-sourced checks too. **Fix**: fall back to the highest-liquidity
pair (any DEX) when no meteora-tagged pair exists, instead of leaving the
field undefined forever (`highestLiquidityPair()`, `meteoraScanner.ts`).
Verified: candidate hydration coverage went from 17/94 to 94/94 in a live
re-test. Re-accepts a little of the original wrong-DEX-data risk, but only
for the 82% of pools that would otherwise get zero signal and guaranteed
rejection — net better. All 4 instances restarted on this fix.

**2. `range` mode refinements**, from watching `range-optAB` (1.2 SOL) vs
`range-optAB-90sol` (90 SOL) diverge to **-45.11% vs +24.06%** on the
*identical* strategy over the same ~11h window:
- **`RANGE_MIN_TVL_USD` (new, default 60,000, absolute not capital-relative)**
  — `range-optAB` entered `o-SOL` TWICE at $15,837 and $11,442 TVL
  (`MAX_CAPITAL_TVL_RATIO_PCT` scales with capital and let this through at
  1.2 SOL; at 90 SOL the same ratio would have blocked it). The second
  entry HARD_EXIT'd at -43% unrealized loss. TVL that thin is fragile
  regardless of how small our own position is — a genuinely different risk
  from price-impact, needed its own absolute floor. $60K chosen from the
  data itself: disasters clustered $11K-59K, healthy range entries
  (SI-SOL) sat $261K-574K.
- **`RANGE_CEILING_PROFIT_OVERRIDE_PCT` (new, default 0) +
  `rangeCeilingProfitOverride()` (`riskManager.ts`, shared by
  `paperTrade.ts` and `rebalanceEngine.ts` so both stay in parity)** —
  `range-optAB-90sol` left a SI-SOL position at ~28% peak profit (right
  before the idle-timer + volatility-ceiling combo fired) — SI-SOL then
  ran ~2x further. The existing sticky trailing-take-profit tiers
  (`TAKE_PROFIT_TIERS`, arm at 30%) never got a chance to engage because
  the idle-forced re-screen abandons the pool unconditionally, before
  profit could ever reach that arm threshold. Fix: when a held range
  position's re-screen fails ONLY on the volatility-ceiling reasons (not
  crash guard / dead activity / authority — those still abandon as
  before) AND current profit clears the threshold, don't abandon —
  recenter the bin and keep holding, letting the existing trailing-tier
  system govern the eventual exit. User explicitly rejected a time-based
  cooldown alternative for this same reasoning (see chase guard below) —
  profit-gating was judged the safer mechanism here specifically because
  the existing take-profit tiers already provide the downside protection
  once armed.

**3. Chase guard (`ScannerConfig.chaseGuardPools`, all modes)** — found
while explaining `momentum-optAB-90sol`'s worse-than-range behavior:
sold SI-SOL on a legitimate crash-guard exit at ~$23.8M mcap, whipsawed
through 2 losing rotations on other tokens (GP-SOL: dead activity, -8.2%;
PAID-SOL: another crash-guard, -8%) over ~7h, then re-bought the SAME
token fresh as a "new" accelerating candidate at ~$48.6M mcap — over 2x
higher than where it sold, zero memory of the prior loss. **A time-based
cooldown cannot fix this** (the 7h gap already exceeded both
`LEFT_POOL_COOLDOWN_MS` 20min and `BLACKLIST_DURATION_MS` 6h) and user
correctly rejected a fixed retention window as the fix on principle: a
memecoin can reverse bear→bull faster than any reasonable window, so a
blanket "no re-entry for N hours" would also block genuinely valid
reversals. **Fixed on price structure instead of time**: record the exit
price per mint (not pool address — the same token can list multiple
Meteora pools at different bin-steps, confirmed for this exact SI-SOL
case) on every exit; a mint stays guarded against re-entry above that
price until its OWN price has genuinely dipped back to/below it at least
once (checked every scan tick against data already fetched, no extra API
call) — then the guard clears **permanently**, not on a timer. A fast
reversal clears the guard fast; a token that never truly retraces stays
blocked indefinitely, however much calendar time passes. Wired into all 4
of `paperTrade.ts`'s exit paths (HARD_EXIT/TAKE_PROFIT/LEFT_POOL/SWITCHED)
and into `rebalanceEngine.ts`'s real-bot exit paths (`executeHardExit`,
`executeCleanExit`, `compoundCycle`'s abandon branch) via a new
`getCurrentPriceUsd()` lookup against Meteora's own `/pools` API (the real
bot otherwise prices everything in SOL-ratio terms with no USD feed of its
own, by design — see `rpc.ts`'s doc comment — so this is a deliberate,
narrow, one-off USD lookup just for this one purpose, not a broader
architecture change).

Two new self-checks (`checkRangeTvlFloorAndProfitOverride.ts`,
`checkChaseGuard.ts`), all 12 self-checks in the repo pass, TypeScript
clean. All 4 paper-trade instances restarted again on this combined fix
(restart timestamp 2026-09-30 ~00:02 UTC).

**Go-live clock restarted again, and it now misses the Friday target.**
Criterion 3 (below) requires the counted window to start AFTER the last
code change — today's 3 fixes are exactly that kind of change. New restart
timestamp 2026-09-30 ~00:02 UTC + 3 days lands **2026-10-03, Saturday**,
not the 2026-10-02 Friday target from the prior restart. Flagging this
explicitly rather than quietly re-deriving a new date that happens to still
say Friday — it doesn't, one more day slipped. If a fresh session or the
user wants a hard Friday start regardless, that would mean accepting a
window shorter than 3 days on the current code, a deliberate trade-off to
surface, not decide silently.

## 2026-10-07 session: real-money go-live — 6 bugs fixed live, 2 more found
   (1 partially fixed, 1 still open), bot left running deliberately to
   collect more real sample data

Real capital actually deployed for the first time this session. Wallet
`<LIVE_WALLET_ADDRESS>` (rotated twice earlier in the
real-money prep phase after two separate accidental key-exposure incidents
— both handled by migrating funds via a fee-exact on-chain transfer, no
funds at risk, see security notes). Config: `range` mode,
`INITIAL_LP_CAPITAL_SOL=1.3` (fixed per user's explicit instruction),
`MIN_GAS_RESERVE_SOL` re-tuned by hand to the wallet's actual balance each
restart (drifts every cycle from swap slippage/fees — **re-check the actual
balance before any future restart**, don't just reuse the last value in
`.env.live`).

**6 bugs found and fixed, each confirmed live against a real mainnet tx
before moving on:**

1. **Logger silently swallowed all output** (`src/utils/logger.ts`) — a
   custom winston `format()` returned a fresh plain object instead of
   mutating `info` in place, dropping winston's internal Symbol-keyed
   properties. Every `logger.error`/`info`/`warn` call since the file was
   written produced zero output, console or file — no crash, no hint
   anything was wrong. This was the FIRST thing found (nothing else could
   be debugged until this was fixed) and is almost certainly why earlier
   real-bot problems were invisible. Self-check: `checkLoggerRedaction.ts`.
2. **Gas reserve not subtracted on first-ever entry** (`openInitialPosition`,
   `rebalanceEngine.ts`) — tried to deposit the ENTIRE wallet SOL balance
   including the reserve, "insufficient lamports" on the real bot's very
   first live attempt. `compoundCycle` already did this correctly;
   `openInitialPosition` never had to until this session. Fixed via shared
   `reserveGasFromSolSide()`. Self-check: `checkGasReserve.ts`.
3. **DLMM SDK ComputeBudget duplicate-instruction rejection**
   (`meteoraDLMM.ts`) — `@meteora-ag/dlmm`'s
   `initializePositionAndAddLiquidityByStrategy` already embeds its own
   ComputeBudget instructions; `withPriorityFee` blindly added a second
   pair on top, Solana's runtime rejects the duplicate outright. Fixed via
   `stripComputeBudgetInstructions()`. Self-check:
   `checkComputeBudgetDedup.ts`.
4. **1000x token-value undercounting** (`otherTokenValueInSol`,
   `rebalanceEngine.ts`) — hardcoded `LAMPORTS_PER_SOL` (9 decimals) to
   convert the non-SOL side's raw amount; most memecoins (pump.fun
   Token-2022 mints included) use 6 decimals. A brand-new, healthy position
   read as "49.90% unrealized loss" within 15 seconds and got HARD_EXIT'd.
   Fixed via `getMintDecimals()` + `rawAmountToSol()`. Self-check:
   `checkDecimalsFix.ts`.
5. **Real balance-race producing a genuinely SOL-only "phantom position"**
   — a swap's `confirmTransaction` resolving at 'confirmed' commitment
   doesn't guarantee the VERY NEXT RPC call (load-balanced provider) lands
   on a backend that's caught up; reading the post-swap token balance
   immediately afterward returned stale/empty data, so `openPosition` was
   called with a real 0 for the non-SOL side — confirmed via the actual
   on-chain tx showing IDENTICAL pre/post token balances during
   "AddLiquidity". Fixed via `waitForTokenBalance()` (polls until the
   balance clears an expected-minimum threshold derived from the swap's own
   `outAmount`), shared between `openInitialPosition` and
   `balanceTokenRatio` (`compoundCycle`'s rebalance path has the identical
   vulnerability) via `services/solana.ts` to avoid a circular import.
6. **Bin radius exceeding the SDK's own per-tx limit ("InvalidRealloc")**
   — `env.MAX_BIN_RADIUS` (50) let `computeBinRadius` return a radius whose
   position (2×radius+1 bins) exceeded `@meteora-ag/dlmm`'s own
   `MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX` (26) — a hard per-tx ceiling enforced
   via account realloc size, confirmed by reading the SDK's own exported
   constant. Entry failed simulation with "Failed to reallocate account
   data" on `InitializePosition`. Fixed by clamping
   `computeBinRadius`'s max to `min(env.MAX_BIN_RADIUS, SDK-safe radius)`
   in code (not just `.env.live`, so a misconfigured env value can't
   reintroduce this). Also added a rollback: if `openPosition` fails AFTER
   the pre-swap already landed (this bug's exact failure mode), the
   swapped-into token balance used to sit stuck in the wallet with zero
   tracking — now `openInitialPosition` best-effort swaps it straight back
   to SOL before rethrowing. Self-check: `checkBinRadiusSdkCap.ts`.

**7th bug found live, by the user noticing it in the logs
("udah ada switch cok lo liat lognya deh"):** opportunistic SWITCH
(`evaluateSwitchOpportunity`) is a momentum-only concept (spike-ratio
chasing) — `paperTrade.ts` already gates it to
`env.ENTRY_STRATEGY_MODE === 'momentum'` (line ~669), but `index.ts` (the
real bot) never got the same gate. It ran unconditionally regardless of
mode, and on a `range`-mode position it actually fired
(`"candidate spike 4.09x >= current 0.96x * margin 1.5"`) — a momentum
signal switching a range position away from its own thesis (hold through
volatility, let the trailing take-profit tiers govern the exit). Fixed:
`index.ts`'s opportunity-scan block is now gated the same way paper-trade's
is.

**8th bug found from the SAME incident, more serious, ONLY PARTIALLY
FIXED:** the SWITCH above closed the old position on-chain successfully
(`closePositionFull`, irreversible), but the FOLLOW-UP step
(`emergencySwapAllToSol` on the leftover token) then failed (transient
Jupiter quote 5xx). `index.ts` has no try/catch around its
`executeHardExit`/`executeCleanExit`/`compoundCycle` calls, so the throw
left `currentPool` still pointing at the now-closed position. Every
subsequent tick's health check then read `currentValueSol` as 0 (no
position found) and misread it as a 100% loss, looping
HARD_EXIT/blacklist/retry on a pool with no position left for ~5 minutes,
until a retry's own swap attempt happened to succeed by luck and the state
resynced. **Patched the specific sub-step that failed this time**
(`closeAndConvertToSol` in `rebalanceEngine.ts` now swallows a
swap-back failure instead of throwing, since the position close itself —
the irreversible, state-defining step — had already succeeded). **This is
NOT the root-cause fix.** Confirmed the same bug class recurred ~6 hours
later via a DIFFERENT path: `compoundCycle` does `closePositionFull`
(irreversible) THEN, much later in the same function, `openPosition` to
reopen at the recentered bin — when the reopen failed 4x in a row
(`ExceededBinSlippageTolerance`, price moved past tolerance during
retries), the whole function threw, `index.ts`'s
`currentPool = await compoundCycle(...)` never executed, same phantom
"100% loss" misread fired. It self-healed in ONE HARD_EXIT cycle this time
(lucky — the leftover-swap succeeded on the first try) instead of looping
5 minutes, but the underlying race (any call that physically closes a
position on-chain, followed by ANY further step that can throw, with no
try/catch at the `index.ts` call site to reconcile `currentPool` regardless
of outcome) is still live and can recur through yet another path.
**Real fix still needed**: wrap all three `index.ts` call sites
(`executeHardExit`, `executeCleanExit`, `compoundCycle`) so that once the
on-chain close is confirmed to have happened, `currentPool` always gets
reconciled to `null` (or re-synced) no matter what fails afterward — not
patched sub-step by sub-step as each one gets discovered.

**Other anomalies observed this session, not yet acted on (data points,
not confirmed bugs):**

- **Entries seem to land near a post-pump rollover.** Both real entries
  examined in detail had a big 24h pump (56-75%) already behind them and a
  flat-to-negative 1h change AT entry time — i.e. `RANGE_MAX_VOLATILITY_PCT`
  (15%) checks magnitude of recent change, not direction or "is this a
  pump that's just started cooling" — a token can be in the very early
  stage of rolling over from a huge pump and still read as "low volatility,
  range-bound" by this check. Both observed entries drifted down afterward.
  Sample size is tiny (2-3 entries) — not yet confirmed as a structural
  flaw vs. noise, needs more entries to know.
- **Swap transactions expiring before confirmation**
  ("block height exceeded" / "Blockhash not found") recurred multiple times
  across the session (worst cluster: 3 consecutive failed entry attempts in
  ~3.5 minutes). Infra/RPC-latency issue (retries + 429 backoff eating into
  Solana's ~60-90s blockhash validity window), not a logic bug — no funds
  lost (the swap itself never lands when this happens), but costs time and
  occasionally a missed entry/exit.
- **High churn, zero TAKE_PROFIT.** 6 entries in ~11.5h (avg hold ~2h) —
  short for a "low-turnover, fee-yield" range thesis. Every exit seen so far
  was HARD_EXIT or a re-screen-driven abandon; the trailing take-profit
  tiers never fired once this session.
- **Net capital down over the observed window**: start of this run
  (10:32 UTC) 1.564941301 SOL → ~21:59 UTC check: 0.208070167 SOL liquid +
  ~1.239 SOL in the open position ≈ 1.447 SOL total, roughly **-7.5% over
  ~11.5h**. Real, not phantom — consistent with the rollover-entry pattern
  above plus repeated churn costs (slippage/fees across 6 entries + exits).

**Deliberate decision (user's call, 2026-10-07 ~22:0X UTC): stop finding
and fixing bugs for now, leave the bot running UN-PATCHED** on the known
state above (7th bug fixed, 8th bug only partially fixed) specifically to
accumulate more real sample data while it's behaving "normally" (no crash,
no stuck funds right now) — explicitly trading known-imperfect code for a
longer, uninterrupted real data window, rather than restarting again. This
CLAUDE.md update is that "write it down, don't touch the bot" checkpoint.
**Next session: re-read this section before changing anything** — the 8th
bug (state desync on a throw after an irreversible on-chain close) is
still live and can recur through any of the three `index.ts` exit/reopen
call sites, not just the two paths already observed.

## 2026-10-08 session: batch fix — 8th bug root-fixed, 2 more root-causes
   traced from live logs, 2 user-requested range-mode/fee changes

Continuation of the same real-money run. User asked to investigate a few
things live (why a specific out-of-range position wasn't acting, DARK-SOL's
in/out history, a fee-rate parameter question), which surfaced enough new
findings that the user then said: stop the bot cleanly at the next natural
breakpoint, implement everything found/discussed, then restart. All work
below is implemented and verified (not just designed) as of this write-up.

**Investigation trail (led to the fixes below):**
- Traced `DARK-SOL` (`5csr5JWTCUAUrGE8rverZ9sH9LmBekyk3cb7BkPsnoZG`) — bot
  entered/exited it 3 separate times over the session, net **+3.2%** on the
  3rd cycle despite the 8th bug firing mid-cycle. User asked "would it have
  ridden the pump (+112%/+128% by the time we checked) if the bug hadn't
  hit?" — answer: only partially. `post-close balances` showed the bin
  mechanics had ALREADY swept ~99% of principal into SOL by the time of the
  forced rebalance (DLMM auto-sells the non-SOL side into SOL progressively
  as price rises through bins — it doesn't "ride" a pump the way holding
  the raw token would). Separately, `RANGE_CEILING_PROFIT_OVERRIDE_PCT` is
  0 (disabled) in `.env.live`, so even a successful reopen would have been
  unconditionally abandoned the moment the move's magnitude breached
  `RANGE_MAX_VOLATILITY_PCT` — same mechanism as this pool's own Round 2
  exit. Net: the bug cost a modest amount of additional runway, not the
  full headline pump (that's structurally out of range mode's reach by
  design, same as every other mode-mismatch case already on file).
- User asked why an out-of-range position "wasn't doing anything" —
  confirmed this is `MAX_IDLE_OUT_OF_RANGE_MINUTES=10` working as designed
  (debounce against noise), not a bug. Watched it live past the 10-minute
  mark: `REBALANCE (idle-forced)` fired correctly, re-screen failed (crash
  guard + sell-dominant buy ratio), position genuinely left the pool and
  converted to SOL cleanly — no bug this time. User then said stop here
  (clean breakpoint, nothing orphaned) and implement the batch.
- User asked about a "fee parameter" they saw on a HIGGS-SOL position
  (`base_fee_pct: 0.3%`, confirmed live via Meteora's own
  `dlmm.datapi.meteora.ag/pools/<address>` endpoint) and proposed a 0.5%
  minimum floor. Investigation found the same `/pools` response (already
  being fetched by `fetchTopPools()`, zero extra cost) also includes
  `max_fee_pct`, `protocol_fee_pct`, `dynamic_fee_pct`, and a pre-computed
  `fee_tvl_ratio` per window (30m/1h/2h/4h/12h/24h) — none of it was being
  read. `rankRangeCandidates` was ranking by raw vol/TVL turnover with NO
  fee-rate dimension at all, so two pools with identical turnover but
  0.3% vs 1% base fee ranked identically despite a ~3x real yield
  difference. Agreed combined fix (below): a modest floor (0.2%, not the
  initially-discussed 0.5% — a hard 0.5% floor risks rejecting a
  high-turnover/lower-rate pool that still out-yields a low-turnover 0.5%+
  one) PLUS ranking by `feeTvlRatio24h` directly. **Caveat found along the
  way, do not forget**: Meteora's own `apr`/`apy` fields in the same
  response are NOT reliable — confirmed live on the HIGGS pool they showed
  `apy: 3,086,522,374%` (naive over-compounding of a volatile 24h ratio).
  Never use `apr`/`apy`; `feeTvlRatio24h`'s raw value is what's used.
- Separately, user proposed: on any close, keep the fee-sized portion of
  the non-SOL side as raw token (their own call when to sell it) instead of
  auto-swapping 100% of the leftover balance to SOL — only the SOL-side
  keeps recompounding through `currentCapitalSol`. Confirmed
  `position.positionData.feeX`/`feeY` (read BEFORE closing) are already the
  exact raw-unit fee amounts needed, same basis already correctly used
  elsewhere (`getPositionHealthSnapshot`) — no new unit-conversion risk.

**8 bugs/changes implemented this session (all verified: `tsc --noEmit`
clean, 24 self-checks pass — up from 23, build clean):**

1. **8th bug (state desync), root-fixed** — the 2026-10-07 patch only
   covered one specific sub-step (`closeAndConvertToSol`'s swap-back
   failure). It recurred hours later via `compoundCycle`'s reopen step
   (`ExceededBinSlippageTolerance`, 4 identical failures, same phantom
   "100% loss" misread — self-healed in 1 cycle instead of 5 minutes, but
   confirmed NOT actually fixed). Real fix: `index.ts` now wraps all 3
   call sites (`executeHardExit`, `executeCleanExit` for TAKE_PROFIT/
   SWITCH, `compoundCycle`) in try/catch; on ANY throw, a new
   `reconcilePoolStateAfterFailure()` re-checks ground truth via
   `getUserPositions` instead of guessing — clears `currentPool` (and
   recomputes capital from the real wallet balance) only if the position
   is confirmed gone, otherwise keeps tracking it normally.
2. **Jupiter swap stale-transaction retry bug** (`jupiterSwap.ts`,
   `executeSwap`) — built+signed a `VersionedTransaction` ONCE, then
   retried `sendTransaction` on that SAME object. A `VersionedTransaction`'s
   blockhash is baked into its compiled message and can't be patched in
   place (unlike the legacy `Transaction` bug already fixed in
   `meteoraDLMM.ts`'s `sendTx`) — every retry resent an increasingly stale
   blockhash, so once the first attempt didn't land in time, every
   subsequent retry was doomed before it started. Almost certainly the
   dominant cause of nearly every "block height exceeded"/"Blockhash not
   found" failure seen all session (entries, swap-backs, emergency swaps).
   Fixed: the entire `jupiter.swapPost` → sign → send → confirm sequence
   now lives inside ONE retry closure, so each attempt gets a fresh
   transaction with a fresh blockhash.
3. **Bin-slippage retry bug** (`meteoraDLMM.ts`'s `openPosition` +
   `rebalanceEngine.ts` callers) — `minBinId`/`maxBinId` were computed ONCE
   from a single `getActiveBin()` snapshot before any retry loop; `sendTx`'s
   retry only refreshed the blockhash, not the bin-range baked into the
   deposit instruction itself. During a fast price move (DARK-SOL), every
   retry resent the SAME now-stale range, failing identically 4/4 times
   with `ExceededBinSlippageTolerance` — a doomed loop, not a transient
   one. Fixed: `openPosition` now takes a `binRadius` (not a precomputed
   `minBinId`/`maxBinId`) and fetches the active bin FRESH inside its own
   retry closure (also generates a fresh position keypair per attempt).
   Both callers (`openInitialPosition`, `compoundCycle`) updated to read
   the actually-used `centerBinId` back from the result instead of a
   pre-fetched value.
4. **Range mode: base-fee-rate floor** — `RANGE_MIN_BASE_FEE_PCT` (new env
   var, default 0.2) rejects the lowest stable-pair-style fee tiers at
   entry (entry-only, same pattern as `RANGE_MIN_TVL_USD`). `MeteoraPair`
   gained `baseFeePct` (from `pool_config.base_fee_pct`).
5. **Range mode: ranking by fee yield, not raw turnover** —
   `rankRangeCandidates` now sorts by `feeTvlRatio24h` (new `MeteoraPair`
   field, from the API's own `fee_tvl_ratio['24h']`) instead of raw
   vol/TVL turnover, falling back to the old turnover calc only if that
   field is somehow missing. Never uses `apr`/`apy` (see caveat above).
6. **Fee-split-on-close** — new pure `splitFeeFromOtherBalance(feeOtherRaw,
   totalOtherRaw)` (`rebalanceEngine.ts`) keeps exactly the fee-sized
   portion of the non-SOL side as raw token, swaps only the rest
   (principal). Wired into `closeAndConvertToSol` (shared by
   `executeHardExit`/`executeCleanExit`) and `compoundCycle`'s
   abandon-and-convert branch. Deliberately NOT applied to the normal
   "still eligible, reopen" path — that one keeps 100% (principal+fee) in
   LP to keep compounding, per the user's own framing ("yang bentuknya SOL
   tetep direcompound"). Self-check: `checkFeeTokenSplit.ts`.

**Manual interventions this session** (both clean, no funds lost beyond
normal network fees): closed the DARK-SOL-round-3-successor position
manually before the batch-fix work started (user: "stop dulu botnya,
implement dulu bug2nya"), and again after confirming the 10-minute
idle-forced-rebalance behaved correctly — both times via
`closePositionFull` + `emergencySwapAllToSol` run directly against the
compiled `dist/` (not through the live bot process), since `index.ts` still
has no resume-on-boot and a bare `kill`/SIGTERM does not close an open
position. Wallet balance after the second close: **1.400764281 SOL**.

**Open decision before relaunch**: user's standing instruction is
`INITIAL_LP_CAPITAL_SOL` fixed at `1.3`, only the gas reserve adjusts to
the wallet's actual balance. At the current balance (1.400764281), that
only leaves **~0.0908 SOL** for `MIN_GAS_RESERVE_SOL` before even a safety
margin — noticeably thinner than every prior reserve this run (0.25-0.32).
Flag this explicitly before picking a value rather than silently setting a
thin reserve: options are (a) accept the thin reserve as-is, (b) reduce
capital below 1.3 this one cycle to restore a healthier reserve, or (c) top
up the wallet. **Resolved later same session: user picked (a)**, accept it
as-is — see continuation below.

## 2026-10-08 session (continued): gas/slippage quantified (negligible),
   DARK-vs-HIGGS explained (range mode working as designed), a real $
   buy/sell blind spot found + a new signal shipped for it, and — found
   WHILE validating that new signal — a severe pre-existing stuck-funds bug
   on every position close, now fixed

Direct continuation of the same real-money run (same wallet, same `range`
mode). User picked option (a) above (accept the thin ~0.09 SOL reserve),
bot relaunched on it, then asked a series of analysis questions that led to
real findings.

**1. Quantified gas + slippage — neither explains the -11% all-time
loss.** Pulled every on-chain tx since the 10:32 UTC restart directly (not
estimated): **total gas paid since then: 0.000808854 SOL (~$0.09)** across
36 landed transactions — most of the night's "failed retry" drama never
actually landed on-chain at all (Solana doesn't charge for a
simulation-rejected or never-confirmed send), so it cost zero, just time.
Separately computed **slippage** by comparing each swap's Jupiter-quoted
`outAmount` (already logged) against the REAL on-chain balance delta
received: **0.000811146 SOL (~$0.09) total across 16 swaps**, average
0.008%/swap. Combined, gas+slippage is under $0.20 for the whole run —
execution quality is excellent. The real loss is 100% coming from token
price action itself (the entry-near-rollover pattern already on file), not
transaction costs.

**2. Explained why the bot picked HIGGS-SOL over DARK-SOL re-pumping.**
Traced the exact scan (`02:17:16`, only 1/200 pools passed — not a
head-to-head ranking, DARK simply wasn't a candidate that tick). DARK's
6-hour HARD_EXIT blacklist (from the earlier phantom-loss bug) had JUST
expired 25 minutes before the scan, but that SAME `executeHardExit` also
armed the chase guard on DARK's mint (`recordExitForChaseGuard` — DARK's
price never dipped back to the exit level since, so it's likely still
guarded). Independently confirmed LIVE: DARK's 6h change was +123% at
check time — 8x past `RANGE_MAX_VOLATILITY_PCT` (15%) — range mode would
reject it outright on the ceiling alone regardless of the chase guard.
Two independent mechanisms both correctly declining a move this violent;
working exactly as designed, not a bug. (Catching a move like this is
`trend` mode's job, not `range`'s.)

**3. Found a real blind spot in `buyRatio1h`, user's own observation.**
User noticed HIGGS-SOL's tx-count buy ratio looked healthy (buys actually
outnumbered sells at every window: h1 145/148, h6 904/792, h24 4975/4546)
while its price fell hard the whole time (-9%/-10%/-37%). Confirmed in
code: `meteoraScanner.ts`'s `buyRatio1h = h1Txns.buys / (h1Txns.buys +
h1Txns.sells)` is a pure transaction-COUNT ratio — structurally blind to
"many small buys vs a few large sells" (classic whale-dump signature).
DexScreener/Meteora's public REST APIs expose only tx counts and an
undifferentiated total volume, no $ split by side — the only real fix is
reading on-chain reserve-account balance deltas directly.

**Shipped `src/services/flowAnalysis.ts` (`getDollarVolumeBuyRatio` /
`classifyDollarFlow`)** — reads a pool's own SOL-side reserve account's
recent balance history directly via RPC, classifies each transaction as
buy (SOL reserve increased) or sell (decreased), and computes a genuine
$-weighted ratio. Deliberately scoped LAZY per user's explicit choice (not
applied to the full ~200-pool scan, which would re-trigger this session's
RPC 429-storms): only checked for (a) the single top candidate right
before actually entering, and (b) the currently-held position on a
periodic timer (`OPPORTUNITY_SCAN_INTERVAL_MS`, runs for ANY
`ENTRY_STRATEGY_MODE` — unlike the momentum-only switch check, whale-dump
detection is a general risk signal). New `MIN_DOLLAR_BUY_RATIO` (env.ts,
default 0.4). `PoolContext` gained `reserveSolAccount` (threaded through
`openInitialPosition`). Self-check: `checkDollarFlow.ts`.

**4. The new signal's FIRST live trigger exposed something much worse.**
At `04:28:52`, it fired on the held BATON-SOL position: `buyRatioUsd: 0,
sellVolumeUsd: $3.08, txSampled: 1` — a single $3 sample, clearly too thin
to act on (root cause: most real swap activity routes through Address
Lookup Tables, which `getAccountKeys()` wasn't resolving — the reserve
account was invisible in `staticAccountKeys` for almost every transaction,
undercounting severely). The bot exited BATON on this near-zero-data
signal. **While investigating this false positive, a FAR more serious,
PRE-EXISTING bug was found**: the health check right before exit showed
BATON's position worth **1.2968 SOL**; wallet balance right after "TAKE_PROFIT
complete" was only **0.74285859 SOL** — roughly 0.66 SOL unaccounted for.
Pulled the actual close transaction from chain: the position's non-SOL
side returned **8,712.014436 tokens** to the wallet on close, but
`closeAndConvertToSol`'s very next line read the balance via plain
`getTokenBalance()` with NO staleness guard — got back the STALE pre-close
value (**7 raw units**, not 8712 whole tokens) — the exact same
read-after-write RPC race `waitForTokenBalance` already fixed for the
entry/rebalance-swap paths, just never applied to this specific read site
(present since this function was first written, NOT something introduced
by tonight's fee-split feature — the fee-split code just happened to make
the tiny stale "7" value visible in a log line for the first time, which
is how this was noticed). Net effect: 8712 tokens of BATON's mint (~$77,
~0.66 SOL) sat completely unswapped and untracked by `currentCapitalSol` —
**directly causing the very next entry (CRAWL) to open with only half
capital** (user's own observation: "cuma setengah"), exactly matching
`nextCapital` being computed from the already-short wallet balance.

**Fixed, all three, same incident:**
1. `closeAndConvertToSol` and `compoundCycle` (`rebalanceEngine.ts`) both
   now compute an `expectedOtherAmount` (principal+fee, read from
   `position.positionData` BEFORE closing) and use `waitForTokenBalance`
   (95% threshold) instead of a bare `getTokenBalance()` call immediately
   after `closePositionFull`. `compoundCycle`'s `balX`/`balY` read (used by
   BOTH the abandon path and, critically, the normal reopen path's
   `balanceTokenRatio` rebalancing) got the same fix — this bug could have
   silently corrupted the reopen path's 50:50 rebalancing too, not just the
   abandon-and-convert path, though that wasn't directly observed yet.
2. `flowAnalysis.ts` now resolves account indices via
   `getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })`
   (static + lookup-writable + lookup-readonly, in the order that matches
   preBalances/postBalances indexing) instead of `staticAccountKeys` alone.
3. New `MIN_DOLLAR_FLOW_SAMPLE_SIZE` (5) — `classifyDollarFlow` returns
   null (unknown, don't act) below this many classified transactions,
   regardless of how lopsided they look. Self-check updated to cover both
   the pre-fix incident shape (1 sample, still returns null) and the
   boundary (exactly 5 is enough).

**Recovered the stuck funds**: swapped the 8712.014436 BATON tokens back
to SOL directly (independent of the bot process, same pattern as prior
incidents) — **+0.667542749 SOL recovered**, confirmed 0 token balance
remaining afterward (double-checked after a short delay, since the FIRST
balance read in the recovery script itself also returned stale — a live,
in-the-moment reproduction of the exact race this fix addresses).

All fixes verified: `tsc --noEmit` clean, self-checks pass (still 25 —
`checkDollarFlow.ts` updated in place, not added new), `npm run build`
clean. Manually closed the live position (CRAWL,
`52By9szJr4qEnRCgaddfunEFw7o1CqFdfs7ve12oE3je`) before restarting (per the
same no-resume-on-boot discipline as every prior restart this run).

**Still open / not yet re-validated**: whether the `balanceTokenRatio`
corruption risk in `compoundCycle`'s normal reopen path (point 1 above)
ever actually fired silently on a PRIOR close tonight before this fix —
not retroactively checked, flagged here so a future session doesn't assume
every past "nextCapital" figure in this file's logs was necessarily
accurate.

**Live validation after restart (04:48 UTC onward)**: all fixes confirmed
working in the very next scan cycle — `waitForTokenBalance` caught a stale
read during a fresh entry swap and correctly retried (`"balance read below
expected, retrying"`); the dollar-flow pre-entry check skipped 2 real
sell-dominant candidates with healthy sample sizes (9 and 6, not 1); and a
SECOND BATON-SOL dollar-flow exit fired ~1h later with `txSampled:55,
buyRatioUsd:0.002` — a high-confidence, legitimate whale-dump read this
time — and the capital carried over cleanly to the next entry (no more
stuck funds, `nextCapital` even came out slightly ABOVE the pre-close
capital).

**Immediately after, found the dollar-flow window design itself was too
sensitive** — user noticed and asked directly. The original design sampled
"last 60 transactions, whatever time span that happens to cover" — on
BATON-SOL specifically (confirmed live) 60 tx spans only ~8 minutes, so a
brief few-minute flurry could trigger an exit before the picture
stabilizes. Also flagged a related concern: the original per-signature
`getTransaction` loop (up to 60 sequential RPC calls) felt like unnecessary
load. **Both fixed together**: switched to a genuine TIME window (default
1h, matching every other "1h" signal in this codebase) instead of a raw
transaction count, with a `maxTx` hard cap (300) to bound worst-case batch
size on an extremely active pool — `getSignaturesForAddress`'s own
`blockTime` is read for free to determine which signatures fall in the
window BEFORE fetching any transaction detail. Separately, replaced the
sequential `getTransaction` loop with `connection.getTransactions`
(PLURAL) — one batched JSON-RPC request for every sampled signature
instead of N round-trips — a free efficiency win found while answering the
user's RPC-load question, unrelated to the windowing change but landed in
the same pass. No silent truncation: logs a warning if `maxTx` is hit
before the window is fully covered (result is a partial hour, not the
complete picture). Verified: `tsc --noEmit` clean, self-checks pass (still
25 — `classifyDollarFlow`'s own unit tests were unaffected, the window/
batching logic lives in the RPC-calling wrapper which was never unit-tested
to begin with, same as its first version), `npm run build` clean. Not yet
re-validated live on this exact revision as of this write-up — next
restart should confirm the 1h-window behavior live.

**Live validation**: confirmed the TWEETCRAFT-SOL exit at `06:02:54` (right
before this restart) was on the OLD count-based logic (`txSampled:7`,
exited on what turned out to be a short burst while the user says the 1h
picture was still healthy) — a textbook case of exactly the bug the
window-size fix addresses, caught right at the boundary of the old code's
last live use.

## 2026-10-08 session (continued further): researched sibling DLMM bots on
   GitHub, decided NOT to switch, ported 2 ideas instead (equity-scaled gas
   reserve, bin-array rent cost estimate)

User asked to survey GitHub for similar Meteora DLMM bots. Found
`CryptoGnome/dlmmbot` (+ fork `asterfi/dlmmbot`) as the closest match —
same thesis (scan/vet/one-sided-SOL-entry/rule-based-exit/paper-first) but
a much more mature, productized sibling: web dashboard, CLI, Railway/PM2
deploy automation, Kelly-criterion sizing with multi-sleeve portfolios,
backtesting/sim engine, full vitest test suite, TOML config with
hot-reload + operator "profiles" (aggressive/balanced/conservative), and a
commercial model (1% fee skimmed on live wins, PolyForm Shield license).
Read several of its actual source files (`scanner/gates.ts`, `risk/
limits.ts`, `ranges/planner.ts`, `vetting/rugcheck.ts`) for a real
comparison, not just the README.

**Decision: do NOT switch to it.** Reasoning (user asked for an honest
opinion, this was the answer): (1) their live executor automatically skims
profit, meaning adopting it means trusting unaudited third-party code with
real wallet custody — a direct regression against this session's own
private-key-safety discipline; (2) "production ready" (dashboard, tests,
TOML config) is tooling polish, not evidence of actual live profitability
— no visibility into their real track record, and the repo has only 3
stars; (3) this project's own codebase is now something we have full,
hard-won operational understanding of (every bug found/fixed tonight is
documented) — switching means starting that understanding from zero on
~2400 lines of someone else's `loop.ts`; (4) some of our own mechanisms are
arguably more rigorous already (the dollar-flow check reads real on-chain
reserve deltas directly, vs. their candle-color-based "red volume" proxy;
the chase guard is price-structure-based, not time-based).

**Ported 2 ideas instead** (into our own, fully-understood codebase):

1. **Equity-scaled gas reserve** — directly solves the exact pain from
   tonight's multiple restarts (manually re-tuning `MIN_GAS_RESERVE_SOL` by
   hand after nearly every restart: 0.8 → 0.35 → ... → 0.06, chasing the
   wallet's actual balance each time). New `computeGasReserveSol(equitySol)`
   (`rebalanceEngine.ts`) = `max(MIN_GAS_RESERVE_SOL as a FLOOR,
   equitySol * MIN_GAS_RESERVE_PCT/100)` (new env var, default 5%). Scoped
   deliberately narrow per explicit user instruction: ONLY the reserve
   scales with equity — `INITIAL_LP_CAPITAL_SOL` stays a fixed 1.3, same
   standing rule as before, not touched. Wired into all 4 places that used
   to read `env.MIN_GAS_RESERVE_SOL` directly as an absolute (both
   `reserveGasFromSolSide` call sites, `closeAndConvertToSol`'s
   `nextCapital`, `compoundCycle`'s pre-swap spendable estimate, and all 3
   `index.ts` call sites including the boot sufficiency check). Self-check
   `checkGasReserve.ts` rewritten to cover floor-wins-small/pct-wins-large/
   monotonic-scaling behavior, not just the original subtract-from-correct-
   side cases.
2. **Bin-array rent cost estimate** — this project never modeled DLMM
   bin-array rent at all before. New `estimateBinRentSol(radius)`
   (`costEstimate.ts`, `BIN_ARRAY_RENT_SOL=0.075`, `BINS_PER_ARRAY=70`) —
   deliberately an approximate, never-under-estimating ceiling (plain
   `ceil` + 1 safety array for alignment straddling), not the sibling
   project's alignment-exact version, since this is purely informational
   (logged at both `openInitialPosition` and `compoundCycle`'s reopen, not
   a hard budget gate yet). Self-check: `checkBinRent.ts`.

Both verified: `tsc --noEmit` clean, self-checks pass (27 now, +2 new:
`checkBinRent.ts`, `checkGasReserve.ts` extended), `npm run build` clean.

**First restart attempt immediately failed boot** — real validation, not a
bug: at the actual wallet balance (1.366484111), the OLD default
`MIN_GAS_RESERVE_PCT=5%` computed a reserve (0.0683) that, added to the
fixed 1.3 capital, exceeded the balance by ~0.002 SOL. This is the feature
working correctly (it computed a MORE accurate reserve than the stale
manual 0.06 that used to be there) — it just revealed that 5% (borrowed
directly from the sibling bot's default, tuned for presumably a much
larger scale) doesn't fit this project's current ~1.3-1.4 SOL scale
comfortably against a fixed 1.3 capital. Lowered to `MIN_GAS_RESERVE_PCT=3`
+ `MIN_GAS_RESERVE_SOL=0.03` (both in `.env.live`) — fits with ~0.025 SOL
of headroom at the current balance. Second restart booted clean.

**Not done, explicitly deferred**: Kelly-criterion sizing, multi-sleeve
portfolios, backtesting/sim engine, dashboard UI, TOML hot-reload config —
noted as real ideas worth considering in a FUTURE session, not pulled in
tonight (scope was explicitly limited to the 2 items above).

## 2026-10-08/09 session: entry reliability, fail-closed entry, loss analysis, exit tuning

Real-money run continued (wallet HvXAEv…, `range` mode, capital 1 SOL, kill-switch 1 SOL).

- **0.1 SOL "vanished" root cause**: position rent (~0.0434, up to 0.0582 SOL, refundable) is paid ON TOP of the deposit; entry failed on rent shortfall after the swap, rolled back, repeated round trips (~1.15%/leg Jupiter spread). Fix: `POSITION_RENT_BUFFER_SOL=0.07` in the reserve + pre-flight BEFORE any swap in `openInitialPosition`. The first pre-flight double-counted the gas reserve (nextCapital is already wallet-minus-reserve) and deadlocked every entry for ~5h; now effective capital = `min(requested, wallet - reserve - rent)`, throw only if < 90% of requested.
- **Fail-closed entry (user rule: any failed check = don't enter)**: `missingEntryData()` (meteoraScanner.ts) skips candidates with unhydrated fields; dollar-flow null/insufficient sample skips entry. Held-position re-screen stays permissive.
- **Kill-switch**: `MIN_EQUITY_STOP_SOL` (checked only while flat) exits the process when wallet < threshold (.env.live = 1).
- **flowAnalysis**: `getTransactions` chunked (25) + retried (Helius 429 was blocking every entry). Every reading is now logged (`[flowAnalysis] reading`: ratio, volumes, txSampled, sigsInWindow, coveredMin, partial). `maxTx` cap (300) hit constantly: the "1h" window usually covers only ~8 min.
- **Dollar-flow EXIT loosened** (SI-SOL / TWEETCRAFT exited on thin/partial reads, price later +14% / +60%): exit needs >=25 samples, >=$2000 volume, ratio < 0.25, 2 consecutive qualified breaches (`DOLLAR_FLOW_EXIT_*`). Entry threshold unchanged (0.4).
- **Trailing take-profit** got a first tier: arm 12% / floor 6% (constants.ts; checkTakeProfitTiers updated).
- **Correction**: `RANGE_CEILING_PROFIT_OVERRIDE_PCT=0` is NOT disabled; it means "any positive profit qualifies" and applies only when re-screen fails SOLELY on the volatility ceiling (an extra sell-dominant reason still abandons).
- **Backtest (21 real entries, Meteora 5m/1h OHLCV)**: no entry-timing feature (higher-low, 1h change, distance to 6h/24h low, 15m change) separated good from bad entries; median 60m forward return -0.5%, mean 2h drawdown -7.5%. Do NOT add timing filters on this evidence. Meteora OHLCV: timeframes 5m..24h (no 1m), `start_time`/`end_time` required for ranges, 5m max ~97 candles per request.
- **Loss accounting**: ~1.6522 SOL funded -> ~1.17 SOL now; Meteora PnL excludes swap friction. Idea not built: one-sided SOL entry below price (no entry swap).
- **Still open**: unguarded `waitForTokenBalance` throw before the rollback block in `openInitialPosition`; dollar-flow exits are logged as TAKE_PROFIT (cosmetic); `MAX_IDLE_OUT_OF_RANGE_MINUTES` now 5 in `.env.live`.

## 2026-10-10/11 session: stuck-token incidents, swap reliability, drawdown filter, friction accounting, moonbot research

**Incidents and fixes (all committed, all live except where noted):**
- `7bb6550` BATON incident 2026-10-09 11:08: reopen after rebalance failed with DLMM 0x1774 (`ExceededBinSlippageTolerance`) because the SDK builds the deposit
  ix from the CACHED `lbPair.activeId`; `getActiveBin()` is fresh but doesn't update that cache. Fix: `pool.refetchStates()` before reopen (`openPosition`).
  Also `compoundCycle` now swaps the stuck token back to SOL if the reopen fails, and the kill-switch (`tryEnterPool`) liquidates any leftover token
  (`lastOtherMint`) before exiting. The ~0.6 SOL stuck token had put SOL-only equity under the kill-switch and the bot was dead ~27h.
- `ad0e9b5` `confirmTransaction` resolves WITHOUT throwing when a tx lands but fails on-chain (e.g. Jupiter 6001): now checks `confirmation.value.err`.
- `5372597` re-quote on EVERY swap retry (stale quotes fail with 6001 on fast memecoins); `JUPITER_MAX_SLIPPAGE_BPS` (300) is separate from `SLIPPAGE_BPS` (100)
  because the latter feeds `estimateCycleGasCostSol` in `evaluatePosition`.
- `9804757` Jupiter swaps request `priorityLevelWithMaxLamports` level `high` capped by `JUPITER_MAX_PRIORITY_FEE_LAMPORTS` (1,000,000). Motivation: 4 consecutive
  "block height exceeded" on a swap-back (hypothesis: default fee too low in congestion; not proven).
- `fe80bba` `emergencySwapAllToSol` uses `JUPITER_EXIT_SLIPPAGE_BPS` (800): a QI swap-back failed twice with `0x1771` (PumpSwap slippage) at 300 bps.
- `7311133` every exit logs `[rebalanceEngine] exit price {pool, mint, exitPriceUsd}` (USD from Meteora pool data; null if pool is outside the top-200 window).
- `af03e47` entry gate: reject pools more than `MAX_DRAWDOWN_FROM_HIGH_PCT` below their 14d high (`DRAWDOWN_WINDOW_DAYS`=14, 4h candles via
  `getDrawdownFromHighPct`/`drawdownFromHighPct` in `candleContext.ts`, fail-closed on missing data). Started at 60 (untuned guess after e/acc entered at -92%
  and a -86% drawdown looked bad); changed to **90** on 2026-10-11 after `moonbot/ddstudy.mjs` showed risk jumps at -30% (not 60) and only the <-90% bucket
  shows volume dying (17.9% "dead" vs 4-9%). Set in `.env.live` (`MAX_DRAWDOWN_FROM_HIGH_PCT=90`).
- `.env.live` also now has `MAX_IDLE_OUT_OF_RANGE_MINUTES=30` (was 5) from `moonbot/rangesim.mjs`; takes effect at the NEXT restart.
- `TOKEN_SHARE_PCT` (default 50 = old 50:50; `.env.live` was set to 35 then put back to **50** on 2026-10-11 by user decision: stay 50:50 until there is live data; evidence for skew is thin (rebound after a down-break not supported for high-yield pools)): share of position value held in the non-SOL token on entry and
  rebalance (`openInitialPosition` swaps that share of capital; `balanceTokenRatio` uses pure `planRatioSwap`, self-check `checkRatioPlan.ts`). From `moonbot/skewsim.mjs`:
  less token lost less (-17.5% at 35 vs -18.5% at 50 vs -21.8% at 100 per 24h, yield>=2% pools, 31 tokens, untuned). Unbalanced SDK deposits (skewed, SOL-only,
  token-only) were verified with `simulateTransaction` against a real pool (no tx sent). Also `DOLLAR_FLOW_MAX_TX` 150 (was 300) to cut Helius 429 bursts.
- **Boot recovery / state persistence (adb4a74, 2026-10-11):** `src/services/stateStore.ts` (atomic `state/live-state.json`, gitignored, validated, wallet-bound),
  `src/logic/bootRecovery.ts` (`recoverOnBoot`: on-chain positions via `getAllLbPairPositionsByUser` are the source of truth; 0 -> flat, 1 -> resume from state or rebuild
  from chain via `rebuildContextFromChain`, >1 -> refuse to trade), `index.ts` persists every loop and brackets irreversible ops with an `inFlight` flag (`guarded`);
  a boot after an interrupted op swaps the stranded token leg to SOL. The liquid-SOL sufficiency check now runs only in the flat case. `state/` and `.bad` quarantine files
  are never committed. Read-only check: `npx tsx src/scripts/dryBootRecovery.ts`; self-check `checkStateStore.ts`. Rebuilt-from-chain contexts approximate the deposit basis (current
  value + fees) and reset peak profit. **Found while building it:** `openInitialPosition` swaps `capitalSol/2` but then deposits the WHOLE wallet SOL minus reserve, while
  `ctx.initialDepositSol = capitalSol` (INITIAL_LP_CAPITAL_SOL after a restart) — so after a restart with a bigger wallet the first position's basis, profit % and stop-loss are
  understated vs the real deposit (2QxYG3: basis 1.0 vs ~1.236 real). Not fixed yet (decision pending); the 2QxYG3 state was seeded by hand with basis 1.2359.
- Dollar-flow exits are still logged as TAKE_PROFIT (cosmetic). Unguarded `waitForTokenBalance` throw before the rollback block in `openInitialPosition` still open.

**Observed behaviour worth remembering:**
- QI-SOL exited on dollar-flow (2 consecutive qualified breaches 0.244/0.191) while +5% in profit; this is the deferred profit-guard question.
- e/acc exited at ~MC $2.0M (on-chain swap price ~1.874e-5 SOL x 983.4M supply) after price left the range upward: +11.8% on the position.
- An idle-forced rebalance after an UPWARD break recenters (re-buys the token at a higher price) when re-screen still passes; chase guard only arms on real exits.
- Scans pass 0/200 most of the time in quiet hours (low tx count, vol/TVL, TVL floor, decayed fee yield); then the drawdown gate is the binding filter.

**Friction accounting (all 159 wallet txs, `scratchpad/acct`):** funding 1.6522 -> 1.3376 SOL. Gas for all txs 0.0036 SOL; failed txs 0.000018 SOL; slippage vs
quote 0.0008 SOL. Meteora portfolio PnL +0.1986 SOL (fees +0.661, price/IL -0.463) vs wallet -0.3146: the -0.513 SOL gap is the Jupiter quote's built-in cost
(pool fee + price impact, about 1% per leg on 51.4 SOL swap volume). Per-token wallet nets: HOTBOT +0.150, e/acc +0.108, QI +0.032, DARK -0.171, HIGGS -0.096,
SI -0.093, Agency -0.085. The earlier audit's ~0.17 SOL "bug-era failed round trips" is unchanged. Positions held <90 min are mostly net negative; >90 min median +0.9%.

**Separate research bot, `moonbot/` (read-only research scripts, data dirs gitignored; NOT part of the live bot):** `fetch*.mjs` pull Meteora datapi OHLCV,
`backtest.mjs` (moon-signal chase), `launch.mjs` (new-pool launch buys), `grid.mjs`/`grid2.mjs` (DLMM limit-order maker grid), `ddstudy.mjs` (drawdown buckets),
`rangesim.mjs` (5m range-bot simulator). Findings: moon-signal chase loses (-10..-20% after friction vs -2..-6% random); buying launches loses once the
liquidity filter uses only pre-entry volume (the +10..+38% means were look-ahead/survivorship); limit-order maker grid (bids -20/-40%, asks +50%) is +4.5..+7.3%
per order window with CI barely above 0, one regime, rent/queue not modelled; fee LP at launch could not be tested (no TVL history). Range-bot sim (fee proxy calibrated
on two live positions, no stops): longer idle before rebalance and wider range both help; one-sided SOL entry is not better; limit-ask exit fills ~96% within 60m
but gain is small. Meteora docs: limit orders max 50 bins per account, maker earns 50% of the swap fee on fills; SDK 1.9.14 `placeLimitOrder` exists.
Not done: a tiny live limit-order test (needs user approval), bin-step preference (`MIN_BIN_STEP` 75 would favour wider ranges, undecided).

**2026-10-11 10:33 UTC experiment (live):** `MIN_BIN_STEP=80` + `MAX_IDLE_OUT_OF_RANGE_MINUTES=60` in `.env.live` (set to 120 at 10:33, changed to 60 shortly after) (wider effective range, fewer rebalances) on top of the entry-only 6h ceiling (`RANGE_ENTRY_MAX_6H_CHANGE_PCT=5`). Basis: `moonbot/rangesim.mjs` (wider/longer-idle loses less, none positive). Evaluate jointly after 1-2 weeks or >=10 entries; if <1 entry/day loosen ceiling to 8%, then step to 50. Positions wider than 25 bins/tx are NOT supported (SDK per-tx cap; extended position + chunkable add is non-atomic, not built).

## Next steps

1. **Let the 4 running instances keep going** on the combined dexId-fallback
   + range TVL/profit-override + chase-guard fixes — this is now the
   cleanest run of the session (fewest known bugs). Watch for: does
   `range-optAB`'s TVL floor keep it out of another o-SOL-style disaster;
   does the range-ceiling profit override actually let a future winner run
   further without giving back the gain on a reversal that never comes back
   (the symmetric risk the user flagged); does momentum's chase guard
   actually stop a repeat of the SI-SOL buy-high pattern; does `range`
   keep beating `momentum` at both capital scales now that the TVL floor
   is capital-scale-independent.
2. **Chase guard is paper-trade + real-bot code-complete but the real bot
   has never executed a single real transaction** — first real use will be
   whatever pool it first tries to exit, so there's no live-fire validation
   of the `getCurrentPriceUsd()` lookup path yet, only the self-check.
3. Decide on the still-open spec gaps: `HARD_EXIT` profit-guard, absolute
   switch-margin floor (both from 2026-09-23), the volume-drop Option A/B
   magnitude (currently 1h, arbitrary), and now also whether `trend`/`range`
   should become the new defaults (or stay opt-in tracks) once more data
   exists.
4. Once behavior looks solid over a longer window across multiple episodes
   (not just one): re-check `.env.live` wallet balance, decide on a first
   real cycle. Same "no devnet dry-run, watch the first cycle closely"
   plan as every prior session — nothing about that has changed.

## Security notes (do not relax these)

- Never print/echo the private key or the Helius API key to any tool
  output. `.env` and `.env.live` are both gitignored.
- One Helius API key WAS exposed once this session via an automatic
  tool-diff notification (see "Where things stand" above) — not rotated
  per user's call, flagged here so it isn't forgotten.
- `commit.gpgsign` is `true` in this machine's global git config; set to
  `false` **locally for this repo only** to unblock commits in this
  sandbox (no TTY for the passphrase prompt) — already done, don't
  redo/ask again unless a fresh clone needs it too.

## 2026-10-15 session: meridian mode + Claude AI agent (live, 0.3 SOL cap)

- `ENTRY_STRATEGY_MODE=meridian`: yunus-0x/meridian screening window (`MERIDIAN_*` env, `src/logic/meridianFilter.ts`) + SOL-only 69-bin bid-ask ladder in ONE tx (`buildLadderTx`/`openLadderEntry`, extended position, no entry swap; `src/logic/ladderRange.ts` geometry; `ctx.ladderBins`). Sim: 69-bin bid-ask ~breakeven in a falling market (`moonbot/solonlysim.mjs`), no edge for swing tokens.
- Exits for ladders: price above the ladder `LADDER_OOR_EXIT_MIN` (30) -> clean exit, no recenter; below -> existing down-break ask flow; SL 25%, volume drop, trailing TP unchanged. `DOLLAR_FLOW_ENABLED=false` removes the entry $-flow gate and FLOW_EXIT. `MAX_CAPITAL_SOL` caps capital at boot, refresh, post-exit and compound.
- AI agent (`AI_AGENT=true`, `src/services/aiAgent.ts`, `src/logic/aiPrompts.ts`/`aiDecision.ts`): `claude -p` screener (picks one eligible candidate or skips, conviction>=7, bins 35-69) + manager (hold/close every 5 min, never blocks the tick). Code validates every answer; failures = skip/hold. Decision log `logs/ai-decisions.jsonl`; outcome memory `state/ai-outcomes.jsonl` (win rate + per-pool priors in prompts).
- Verified live: ladder open + close (single tx each), upside-break exit, AI screener skips with conviction. NOT yet seen live: AI deploy path, AI_EXIT, down-break on a ladder.
- PENDING: meridian-style auto threshold evolution (see memory `meridian-mode-ai-agent-2026-10-15`); wait for 20-30 closed positions.
- Gotcha: scripts that import `dist/services/solana.js` must load `.env.live` (`set -a; . ./.env.live; set +a`), else they silently load the old `.env` wallet (GRxK1D, empty).
- Helius free plan: ~75k credits/day burned before dollar-flow was disabled; 429s come from the per-second limit.
- **Update (2026-10-15, later): both AI agents are ReAct and live.** `AI_REACT=true` (screener) and `AI_REACT_MANAGER=true` use the Claude Agent SDK (`src/services/aiReact.ts`): read-only tools (`get_candidates`, `get_pool_detail`, `get_token_info`, `get_position`, WebSearch) + `submit_decision`; the bot, not the agent, executes after validation. Subprocess env strips secrets (`agentEnv`). Cadence follows meridian: screener once per 30 min after a skip (`AI_SCREEN_MIN_INTERVAL_MIN`), manager event-driven (`src/logic/aiTriggers.ts`) + 30 min health check. One-shot JSON agents remain as the fallback when the flags are off.
- Repo: remote `origin` = github.com/dapsverse/DLMM_BOT (public). History was rewritten before the first push (wallet address replaced by `<LIVE_WALLET_ADDRESS>`, author email = GitHub noreply); a local bundle backup of the original history is kept outside the repo. Never commit `.env*`, `state/`, `logs/`.
- Observed so far (first ~4h with the AI): 20+ screener decisions, all skip with conviction 2-5 (falling-knife / parabolic candidates); no AI-driven entry yet. The AI deploy path and manager close path are NOT yet proven live.

## 2026-10-16 session: follow meridian exactly (AI decides, our own rules off)

- **Prompts**: the "low risk, high return" mindset block and our own-sim lessons are removed from all four prompts (one-shot + ReAct, screener + manager). `LESSONS` is now one line with meridian's own filters. The "worst case: knife / rug" sentence is removed from `STRATEGY` (2026-10-16); the ladder mechanics text stays.
- **No conviction gate**: `AI_MIN_CONVICTION` default 0 (meridian has none). Conviction is logged only; the agent picks "skip" when nothing qualifies.
- **Meridian mode bypasses our own heuristics** (`ENTRY_STRATEGY_MODE=meridian`, `filterAndRankPools` + `index.ts`): TVL floor, capital/TVL ratio, 24h volume, vol/TVL, min bin step, pool age, chase guard, mcap ceiling, holders floor, DexScreener hydration/fail-closed, 1h crash guard, 1h/24h pump ceilings, recent-activity and m5 tx count, wash-trade and buy-ratio checks, 14d drawdown gate, transfer-fee gate, mint-authority gate. Only the meridian window (`meridianPoolReject`) and the FREE freeze-authority check (field is already in the Meteora pool response) still gate. The AI sees `transferFeePct`, `freezeAuthorityDisabled`, `mintAuthorityRevoked`, `drawdownFrom14dHighPct` as candidate fields and decides.
- **`PROTECTED_POOLS`** (env, comma-separated pool addresses): the bot never enters, closes, lists, recovers on boot or scans those pools (`isProtectedPool`/`assertNotProtected` in `meteoraDLMM.ts`, plus a 10-year blacklist at boot). Needed because boot recovery (`getAllLbPairPositionsByUser`) would otherwise resume/close the user's MANUAL DARK-SOL sell-ladder in the same wallet. Set in `.env.live`.
- **Observed**: 57 AI decisions, all skip (conviction 2-4): fresh parabolic pumps that dump (1-SOL, BUBBLE), and tokens 70-92% below their 14d high with weak fee/TVL and sell pressure (OMNI, Altai, QI, CRAWL, SAINDRA). Removing the knife sentence did not change the verdict; the reasons come from the candidate data. The AI deploy path, manager close path and down-break on a ladder are STILL not proven live; no closed position yet, so outcome memory is empty.
- **Still pending**: meridian-style auto threshold evolution (after 20-30 closed positions); rotate the Helius key and move funds (key + private key appeared in tool output again this session); `/revoke` the leaked Telegram bot token.
- **Prompts = meridian's prompt.js verbatim** (screener + lean manager); only tool plumbing adapted (deploy/close -> `submit_decision`, fixed deploy size and 35-69 bins). All of our own strategy/lessons/guidance text is gone. The remaining behavioural gap vs meridian was its smart-wallet signal ("no narrative + no smart wallets -> skip").
- **Smart wallets** (`src/services/smartWallets.ts`, ReAct tool `check_smart_wallets_on_pool`): same format as meridian's `smart-wallets.json` (repo root, gitignored; see `smart-wallets.example.json`). A tracked LP wallet holding a position in the pool is a STRONG signal, none is neutral. Reads via `DLMM.getAllLbPairPositionsByUser` (cached 5 min). The list is EMPTY until the user adds wallets (meridian fills it from a hosted top-LPer API we do not have).
- **Meridian close rules** (2026-10-16, `src/logic/meridianExit.ts`, `MERIDIAN_RULES=true`, ladder positions in meridian mode only): replace our own exit heuristics (volume-drop HARD_EXIT, tiered TP, idle rebalance, upside-break timer) with meridian's `getDeterministicCloseRule` + `updatePnlAndCheckExits` defaults, applied in order and confirmed over 2 consecutive 15 s ticks: take profit PnL >= 5%; trailing TP (arms at peak 3%, closes 1.5% below peak); active bin > ladder + 10 bins ("pumped far above"); out of range >= 30 min (either side; below the ladder uses the existing down-break ask exit); low yield (pool fee/TVL 24h < 7% after 60 min open). Stop loss stays OUR `STOP_LOSS_PCT=25` (meridian default is -50; user rule). All knobs `MERIDIAN_*` in env.ts. AI manager unchanged (hold/close on top). Self-check `checkMeridianExit.ts`. Takes effect at the next flat restart (position FTR-SOL was open when built). Not proven live yet.
- **Meridian stop-loss/close handling** (2026-10-16): in meridian ladder mode the SL (our `STOP_LOSS_PCT=25`, meridian default is -50) is confirmed over 2 ticks like meridian's, closes via `executeCleanExit(..., 'STOP_LOSS')` with NO 6h blacklist and NO chase guard, and meridian closes SELL THE WHOLE token side (our fee-sized token portion is no longer kept). Pool cooldowns copied from meridian pool-memory (`src/logic/meridianCooldown.ts`, in-memory history, pool AND base mint blacklisted; close history lost on restart but the blacklist itself is persisted): low-yield close 4h, 3 consecutive OOR closes 12h, 3 consecutive fee-earning deploys 12h. Jupiter exit slippage stays ours (8%); meridian uses Jupiter Swap V2 defaults. Self-check `checkMeridianCooldown.ts`. Active at next flat restart.
- **PnL includes unclaimed fees in meridian mode** (2026-10-16): `getPositionHealthSnapshot.currentValueSol` EXCLUDES unclaimed fees (matches Meteora `balancesSol`); meridian's pnl_pct (Meteora PnL) includes them. `tick()` now uses value + fees as the PnL basis for SL, TP, trailing and peak when meridian rules are on (otherwise TP 5% could never be reached on a SOL-only ladder, since price gains don't exist there). Telegram `/status` and `/posisi` now read Meteora `portfolio/open` (value, fees in SOL and $, PnL incl. fees, fee/TVL 24h, range); token dust under 0.005 SOL is hidden from `/status`.
- Observed: position resumed after restart has no `openedAtMs` (not persisted), so the low-yield rule (needs age >= 60 min) is skipped for it; pool fee/TVL 24h is ~3.3% < meridian's 7% floor, so the NEXT fresh position in such a pool would be closed by low yield after 60 min.
- **Two AI strategies** (2026-10-16, meridian mode): `submit_decision` now carries `strategy`: `sol_ladder` (default, SOL-only bid-ask below price) or `token_spot` (swap 100% of capital into the token via Jupiter, then ONE tx extended position with a SPOT distribution ABOVE the price, token-only; `openTokenSpotEntry`, rollback swaps the token back if the deposit fails; `ctx.tokenSpot`, persisted in state). The 50:50 classic strategy stays off. `buildLadderTx`/`openLadderPosition` take a `StrategyType` and a "deposited side is X" flag. For token_spot `bins_below` = bins ABOVE the price, geometry via `ladderBounds(center, bins, !xIsSol)`; `getBinRangeStatus` returns `tokenBelowRange` = "position is all token" for both strategies. Meridian close rules apply to both (price above range = token sold out to SOL; OOR >= 30 min either side; SL 25% incl. fees). The strategy-choice text in the screener prompt is ours, derived from meridian's strategy-library descriptions (meridian's own autonomous prompt has a fixed strategy; the choice table lives in its Claude-Code `screener.md`). Self-check `checkTokenSpot.ts`. NOT proven live: first token_spot entry still to be watched (entry friction ~1%/leg Jupiter; price falling = no fees + loss; boot recovery rebuilt from chain assumes SOL ladder, only state-based resume knows token_spot). Active at the next restart.
- **token_spot is OUR strategy now** (2026-10-16, user: "saatnya bikin strategy kita sendiri", meridian only provides the scanning base): (1) spot starts `TOKEN_SPOT_START_OFFSET_BINS=1` bin above the price (`buildLadderTx(..., offsetBins)`, `centerBinId` = the range's anchor edge) so the ~1% entry friction is covered once price trades into the range; (2) OOR wait is `MERIDIAN_TOKEN_SPOT_OOR_WAIT_MIN=15` (also the "price must reach the range" timeout, since the position starts out of range) and an OOR/SL close sells the token immediately (no down-break ask); (3) the AI may pick token_spot only as a LOCAL-BOTTOM BOUNCE trade: new ReAct tool `get_price_action` (5m candles last 3h: distance from low/high, minutes since low, 15m/30m/1h change, RSI14, green candles, higher-low flag, volume trend; `src/logic/priceAction.ts`, nothing decided in code), and `submit_decision` with token_spot is turned into a skip unless conviction >= `TOKEN_SPOT_MIN_CONVICTION=8`; width may be `TOKEN_SPOT_MIN_BINS=20`-69. Interpretation notes: "1 bin above" = range START offset, width is still AI-chosen; "15 menit" = OOR wait. The one-shot (non-ReAct) fallback has no price-action tool. Active at next restart; user said DO NOT restart until told.
- **token_spot OOR wait split** (2026-10-16): 15 min (`MERIDIAN_TOKEN_SPOT_OOR_WAIT_MIN`) until price first reaches the range, then 30 min (`MERIDIAN_TOKEN_SPOT_OOR_AFTER_REACH_MIN`) once it has been in range (`ctx.tokenSpotReached`, persisted; out of range ABOVE counts as reached). Basis `moonbot/spotbounce.mjs` (146 pools, 5m, rule-based bottom proxy): +1 bin reached within 15m 61% / 30m 71% / 60m 79% (median 5 min); of those that reached, ~43% spent >=15 min back below the range before +5% (37% for >=30 min); 23% of signals hit -10% within 1h. It cannot say whether token_spot is profitable. Active at the next restart (user: do not restart until told).
- **Close CU fix** (2026-10-17): `closePositionFull` failed 388x on a 69-bin ladder with big fees (`ClaimFee2 ... exceeded CUs meter`; the close tx needs ~445k CU, default limit ~373k). Simulation failures never reach the chain, so no gas was spent. Now uses `LADDER_COMPUTE_UNIT_LIMIT` (900k); verified with `simulateTransaction` (err null, 444,485 units), nothing sent. Bot stopped by the user with position 7UERUj… (1-SOL) left open for manual handling. Open question: trailing TP has no profit floor (fires at PnL < 0 once peak >= 3% and drop >= 1.5); user to decide whether to add one.
- **Peak reset after a failed trailing close** (2026-10-17, user): if a confirmed `trailing TP` close throws, `ctx.peakProfitPct` is reset to the current PnL (logged `peak reset to current PnL`), so the trailing re-arms from there (needs peak >= 3% again) instead of closing at a loss on a stale peak. Meridian itself has no such reset and no profit floor in its trailing (state.js `updatePnlAndCheckExits`); this is our addition. Not applied to SL/TP/OOR signals. Active at next restart.
- **Candidate list truncation fixed** (2026-10-17): every ReAct tool result was cut at 6000 chars, so `get_candidates` showed the AI only the first ~8-9 of up to 26 pools (broken JSON; the AI wrote "candidate list truncated" in its reasons). Now `get_candidates` returns a columnar `{fields, rows}` form (`compactCandidates`, numbers at 4 significant digits: 25 pools = 6.8k chars vs 18.4k as objects) with a 60k cap; other tools keep 6000. Active at next restart.
