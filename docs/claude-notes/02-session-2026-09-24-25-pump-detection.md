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

