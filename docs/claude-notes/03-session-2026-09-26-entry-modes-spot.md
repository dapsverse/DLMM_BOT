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

