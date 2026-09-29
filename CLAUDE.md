# meteora-dlmm-bot — session context (2026-09-29)

Single-pool auto-compounding Meteora DLMM LP bot for Solana memecoin pools.
**As of 2026-09-29: spot executor dropped, focus is DLMM-only (`range` vs
`momentum` mode) — see the "2026-09-29 decision" section below for why and
for the current running-instance list. Sections above/before it (instance
lists mentioning spot/trend-optAB-spot, etc.) are historical, superseded.**
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
  **Working tree is NOT clean** — the whole 2026-09-26 session (entry
  strategy modes + spot executor, see below) is uncommitted:
  modified `SCREEN_RULE.MD`, `src/config/env.ts`, `src/logic/costEstimate.ts`,
  `src/scripts/checkEntryPumpGuards.ts`, `src/scripts/paperTrade.ts`,
  `src/services/meteoraScanner.ts`; untracked `src/logic/spotExecutor.ts`,
  `src/scripts/checkRangeMode.ts`, `src/scripts/checkSpotExecutor.ts`,
  `src/scripts/checkTrendMode.ts`. No PR opened yet (no git remote
  configured). **Commit this before doing anything else that touches these
  files** — next session shouldn't have to reconstruct it from code again.
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

## Next steps

1. **Commit the 2026-09-26 work** (entry strategy modes + spot executor,
   currently uncommitted — see git status note up top) before it's at risk
   of being lost again. New branch not needed, `feature/trend-aware-entry`
   already matches; normal new-branch-+-PR rule still applies if/when this
   is ready to land on `main`.
2. **Let the 5 running instances keep going** — the comparison is now
   `ENTRY_STRATEGY_MODE` (momentum/trend/range) × volume-drop optA/optB/optAB,
   crossed with LP-vs-spot execution on the `range` instance specifically,
   all on identical capital. Watch for: does `trend` keep beating `momentum`
   past today's single sample; does `range`'s DLMM instance actually earn
   steadier fee income than a momentum-target DLMM would have; does the
   post-whipsaw-fix spot-vs-LP cost gap narrow; does the capital/TVL ratio
   change (point 6, prior session) surface more small-mcap entries without
   more bad outcomes; does the A+B-vs-false-positive tension (point 5,
   prior session) resolve one way with more samples.
3. Decide on the still-open spec gaps: `HARD_EXIT` profit-guard, absolute
   switch-margin floor (both from 2026-09-23), the volume-drop Option A/B
   magnitude (currently 1h, arbitrary), and now also whether `trend`/`range`
   should become the new defaults (or stay opt-in tracks) once more data
   exists.
4. Once behavior looks solid over a longer window across multiple episodes
   (not just one): re-check `.env.live` wallet balance, decide on a first
   real cycle. Same "no devnet dry-run, watch the first cycle closely"
   plan as every prior session — nothing about that has changed. Given
   this session found a real (paper-trade-only, but still) basis-tracking
   bug purely by watching a long-running instance, err toward MORE
   observation time before real money, not less.

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
