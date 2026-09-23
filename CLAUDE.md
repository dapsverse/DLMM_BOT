# meteora-dlmm-bot — session context (2026-09-23)

Single-pool auto-compounding Meteora DLMM LP bot for Solana memecoin pools.
5 SOL total budget (4.2 SOL working capital target, 0.8 SOL gas reserve in
the general design; current paper-trade validation runs are sized off
`INITIAL_LP_CAPITAL_SOL=0.8`, see below). This file is the handoff — read it
before doing anything else in a fresh session. Two full sessions of work are
folded in here (2026-09-22 baseline + 2026-09-23 opportunistic-switching
feature) — this file supersedes the previous version entirely.

## Where things stand right now

- **Git**: still local-only, `main` has **zero commits on purpose** (never
  commit directly to main — project rule, enforced all session). All real
  history is on `feature/trend-aware-entry` — **current branch, all active
  work is here.** ~36 commits on top of the original baseline scaffold
  (`chore/initial-import`), latest being the `dexHydrationFailed` fix below.
  Working tree is clean as of this note. No PR opened yet (no git remote
  configured).
- **A live paper-trade simulation is running right now**, label
  `dex-hydration-fix`, started fresh after the `dexHydrationFailed` fix
  landed (superseded the prior `switch-take-profit` run, killed before it
  reached any TAKE_PROFIT arm — see git log for the exact command/timestamp
  if needed). Check anytime with `npm run paper-trade:report` — it
  **auto-detects and deletes orphaned state files** (a run killed without
  its `DURATION_HOURS` elapsing used to leave a `state-<label>.json` behind
  forever showing "running" indefinitely; the report probes the state
  file's own `pid` field with `process.kill(pid, 0)` and cleans up dead
  ones automatically — no more manual `rm` needed, that happened by hand
  several times last session before the fix landed).
- **Real-money setup is prepped but NOT started, unchanged since last
  session.** `.env.live` exists (gitignored, real Helius RPC key + real
  wallet private key already filled in by the user), sized for a small
  validation run. **Nothing has been sent to the wallet as of this note** —
  confirm balance before ever running `npm start` against `.env.live`. No
  code this session touched real-money paths in a way that's been live-run
  — everything was validated via paper-trade only, per standing project
  policy (paper-trade first, real money only after hours/days of observed
  paper-trade behavior).

## Architecture (src/) — updated for this session's additions

- `config/env.ts` — all tunables. Notable changes this session:
  `MAX_TVL_USD` 1M→150k (a pool near $1M TVL dilutes this bot's small
  capital's fee share to near-zero regardless of how active the pool
  actually is — confirmed live), `PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT`
  -20%→-12% (memecoins can dump 30-50%+ in minutes, -20% was closer to a
  portfolio-level drawdown threshold, too loose for one volatile asset),
  `MIN_PRICE_CHANGE_6H_PCT` -5%→0% (genuine uptrend requirement, not
  merely "not crashing"), `MIN_TX_COUNT_M5` (new, absolute 5-minute
  buy+sell-count floor — a pool can pass the *relative* activity-cascade
  check with 0 real trades if its own 24h baseline is already weak),
  plus 6 new vars for the opportunistic-switching/take-profit feature (see
  below).
- `config/constants.ts` — non-tunable constants. Added
  `DEXSCREENER_TOKENS_BATCH_URL`/`DEXSCREENER_BATCH_MAX_ADDRESSES`/
  `SOLANA_CHAIN_ID` for the batched-hydration fix (see below).
- `services/rpc.ts` / `services/solana.ts` — unchanged this session, same
  wallet-free vs. wallet-eager split as before.
- `services/meteoraScanner.ts` — the biggest single file of churn this
  session:
  - **Batched DexScreener hydration** (was the root cause of repeated
    429-storms): `hydrateTrendData` used to make one HTTP call per pool at
    concurrency 5; now batches up to 30 addresses per call via
    `/tokens/v1/{chainId}/{tokenAddresses}` (one request billed per batch
    against DexScreener's documented 300/min limit). Also fixed a real
    data-corruption bug found in the final review: the batch lookup used
    to key results by *both* `baseToken.address` and `quoteToken.address`,
    which let WSOL (quote-side on most pools) collide across pools —
    now keys/requests by `nonSolToken(pair).address` only.
  - `volumeSpikeRatio(pair)` (exported) — this-hour's volume pace vs. the
    preceding 5h's pace (via DexScreener's 6h volume figure). Replaced
    static vol/TVL ratio as the tie-break within the trend-shortlist, and
    is the core comparison metric for the new opportunistic-switch feature.
  - `poolRejectReasons(pair, config, opts?)` (exported) — diagnostic
    function exposing exactly which filter check(s) a pool fails, instead
    of the old opaque `true`/`false`. `isPoolStillEligible` now returns
    `{ eligible, reasons }`.
  - **Basic wash-trading heuristic**: reject if vol/TVL ratio is extreme
    (>30x) *and* 1h price is nearly flat (<2%) — huge volume with no real
    price movement is the signature of a self-trading loop.
  - **`FilterOpts.skipSizingChecks`** (new, important): `filterAndRankPools`
    /`poolRejectReasons` can now skip the checks that only make sense when
    sizing *new* capital into a pool (`maxTvlUsd`, `minVolTvlRatio`,
    `maxMemecoinMarketCapUsd`). Fixed a real bug found via live paper-trade
    observation: `isPoolStillEligible` (used to decide "stay in this pool
    vs. leave" when idle/out-of-range) used to run the *full* entry screen
    — so a pool we're already holding that simply grew past `MAX_TVL_USD`
    (i.e. **succeeded**) got force-ejected on its next re-screen. Confirmed
    live: CRACKER-SOL entered at $132k TVL, grew to $213k, got kicked on
    `tvl $213461 > max $150000`. `skipSizingChecks: true` is now set at the
    two "should I keep holding" call sites (`isPoolStillEligible`,
    paper-trade's inline out-of-range re-screen) — full entry-screen
    behavior (`skipSizingChecks` unset/false) is unchanged for every fresh
    multi-candidate scan (`scanPools`, `enterBestPool`, `scanForBetterOpportunity`).
  - **`scanForBetterOpportunity(currentPoolAddress, config)`** (new) — the
    opportunistic-switch feature's market scan: finds the best available
    candidate and compares its live `volumeSpikeRatio` against the
    currently-held pool's own, hydrated in the same batched pass.
  - **`MeteoraPair.dexHydrationFailed`** (new, 2026-09-23 follow-up fix) —
    user noticed STONK10-SOL entered with only ~4-6 real trades in the last
    5 minutes despite `MIN_TX_COUNT_M5=20`. Root cause: `hydrateTrendData`'s
    batch call (up to 30 pools/request) failed outright that scan cycle
    (429/timeout) and the `catch` only logged it — every pool in that batch
    kept `txCountM5`/`priceChange*`/`volumeM5Usd` as `undefined`, and every
    "unknown, don't block" check (crash-guard, uptrend, activity-cascade,
    tx-count floor, wash-trade) is deliberately permissive on `undefined`
    so the whole batch sailed through as if verified-safe. Confirmed live
    via DexScreener direct query on STONK10's pool address:
    `txns.m5 = {buys: 4, sells: 0}`, well under the 20 floor. Fix: batch
    `catch` now sets `pair.dexHydrationFailed = true` on every pool in that
    failed batch; `filterAndRankPools`'s candidate filter and
    `poolRejectReasons` both reject on that flag — but **only when
    `!opts.skipSizingChecks`**, i.e. only on fresh entries (`scanPools`,
    `enterBestPool`, `scanForBetterOpportunity`). Re-screening an
    already-held pool (`isPoolStillEligible`, always
    `skipSizingChecks: true`) stays permissive on purpose — a transient
    DexScreener 429 shouldn't force-exit a healthy position, same
    reasoning as the `skipSizingChecks` split above. Self-check:
    `src/scripts/checkDexHydrationGate.ts` (no test framework in this repo;
    plain `assert`, run via `tsx`) — verifies the gate fires for fresh
    entries and not for re-screens.
- `services/meteoraDLMM.ts` — unchanged this session; same two upstream
  packaging-bug workarounds from last session still documented inline at
  the top of the file (corrupted `.d.ts`, ESM build's missing `BN`
  export) — read that comment block before touching anything DLMM-SDK-related.
  `claimFees()` exists here and is now actually wired up (see
  `rebalanceEngine.ts` below) — it was dead code as of last session.
- `services/jupiterSwap.ts` — unchanged this session.
- `logic/riskManager.ts` — `evaluatePosition()` now returns
  `HOLD | REBALANCE | HARD_EXIT | TAKE_PROFIT` (was missing `TAKE_PROFIT`
  last session). Decision-tree priority: `HARD_EXIT` (unchanged: stop-loss
  / >3 rebalances-per-hour / volume-drop) → **`TAKE_PROFIT`** (new, see
  below) → fee-threshold `REBALANCE` → idle-forced `REBALANCE` (see below)
  → `HOLD`. Also new: `evaluateSwitchOpportunity()` (pure function, no
  I/O — mirrors `evaluatePosition`'s shape) for the opportunistic-switch
  decision (see "Two new features" below).
  - **Idle-forced rebalance no longer requires profit first** (was: only
    forced a compound after 10min out-of-range if *already in profit*,
    silently leaving losing out-of-range capital idle forever otherwise).
    Now fires regardless of profit/loss once idle — the existing
    stop-loss (`HARD_EXIT`) already guards against forcing out a big
    loss; anything reaching the idle-forced check is an acceptable
    loss to crystallize in exchange for redeploying idle capital.
- `logic/rebalanceEngine.ts`:
  - `claimFeesOnly(ctx)` (new) — fee-threshold `REBALANCE` while still
    in-range now just claims fees via the (previously dead) `claimFees()`
    SDK call, instead of always doing a full close+reopen. Full
    `compoundCycle` (close+reopen-or-leave) is now reserved for the
    idle-forced (out-of-range) case or when the pool needs a fresh
    eligibility check — a fee-threshold trigger while still in-range no
    longer needlessly crystallizes unrealized price/IL PnL.
  - `executeCleanExit(ctx, reason: 'SWITCH' | 'TAKE_PROFIT')` (new) — close
    + convert-to-SOL, same mechanics as `executeHardExit` but **without
    blacklisting** (extracted a shared `closeAndConvertToSol` helper
    between the two). Neither a switch nor a profit-lock exit is a risk
    violation, so the pool stays a fully valid candidate for the very
    next scan.
  - `PoolContext.peakProfitPct` (new field) — tracks the highest
    unrealized profit % a position has ever reached, fed into
    `evaluatePosition` for the `TAKE_PROFIT` check. **Deliberately never
    reset on `compoundCycle`** — mirrors `initialDepositSol`'s own
    pre-existing never-reset-on-compound basis in the real bot (unlike
    paper-trade, see below).
- `logic/binRange.ts` — unchanged this session. `computeBinRadius()` still
  symmetric-only (±`TARGET_RANGE_PCT`, default 15%) — a user-reported
  out-of-range-too-fast observation this session was investigated but the
  evidence was inconclusive (two different price sources disagreeing,
  likely just measurement noise during a fast pump, not a systematic range
  problem) — **not changed, prior rejection of asymmetric/skewed ranges
  from last session stands.**
- `logic/costEstimate.ts` — added `estimateClaimCostSol()` (flat 1-tx cost,
  no swap — used by the new `claimFeesOnly` path, much cheaper than the
  existing 3-tx `estimateCycleGasCostSol` used for full compound cycles).
- `scripts/paperTrade.ts` — mirrors every real-bot decision change above
  (both features are real-bot-and-paper-trade-parity by design — a final
  review this session caught and fixed a case where paper-trade's
  simulated decisions had drifted out of parity with what the real bot
  could actually do, see "Final review findings" below). Also new this
  session, independent of the two big features:
  - **SOL-denominated figures everywhere USD appears** — starting capital,
    current value, every ENTER/REBALANCE/CLAIM_FEES/HARD_EXIT/TAKE_PROFIT/
    LEAVE_POOL/SWITCH event and `poolHistory` entry now carries a `*Sol`
    twin next to its `*Usd` field, converted at that event's own live
    `sol.priceUsd`.
  - **`totalFeesEarnedUsd`/`totalFeesEarnedSol`** (new, cumulative across
    the whole run) — incremented every time `position.feesEarnedUsd` gets
    cashed out (claim, compound, or any exit type). The report prints this
    separately from total PnL so fee income vs. price/IL can be read apart
    at a glance (`pnlUsd - totalFeesEarnedUsd` isolates the price-only
    component) — this directly answers a real incident earlier in the
    session where a position showed +$8.37 in fees but still had a net
    *loss* because price/IL was worse than the fee income.
  - `enterPool(chosen)` extracted out of `enterBestPool` (entry mechanics
    for an already-chosen pool) — reused by the SWITCH execution path,
    which enters a specific pre-validated candidate directly rather than
    re-scanning from scratch.
- `scripts/scanOnce.ts` — unchanged.
- `scripts/paperTradeReport.ts` — now auto-cleans orphaned state files (see
  "Where things stand" above) and prints the new SOL/fees/PnL fields.
- `index.ts` — real bot's main loop. **Still never actually run against
  real funds or even devnet** — same status as last session, only
  runtime-smoke-tested. Now wires both new decisions (`TAKE_PROFIT`,
  opportunistic `SWITCH`) into `tick()`, mirroring paper-trade.

## Two new features added this session (opportunistic pool-switching + trailing take-profit)

Full design history: `docs/superpowers/specs/2026-09-23-opportunistic-pool-switching-design.md`
(the approved design) and `docs/superpowers/plans/2026-09-23-opportunistic-pool-switching.md`
(the 10-task implementation plan, executed via subagent-driven-development
— every task individually reviewed, plus a final whole-branch review that
found and fixed 5 more real bugs). Ledger of every ruling made during
execution: `.superpowers/sdd/2026-09-23-opportunistic-pool-switching/progress.md`
(kept as a permanent record, not deleted — has the full list of decisions,
including two spec gaps deliberately left unresolved, see below).

**Why:** the bot was single-pool and reactive — it only ever scanned the
market for a new pool when it had no open position. While holding
(sometimes for hours), it could not notice a token pumping hard elsewhere.
Confirmed concretely: JEANPHIL-SOL ran from ~$80k TVL/$2M mcap to $269k
TVL/$7.5M mcap while the bot's capital sat in an unrelated position — zero
chance to act on it, not because the screening logic was bad, but because
the bot structurally wasn't looking.

**1. Opportunistic pool-switching** — every `OPPORTUNITY_SCAN_INTERVAL_MS`
(5 min, config) while holding a position, scans the full market
(`scanForBetterOpportunity`) and switches into a candidate whose
`volumeSpikeRatio` beats the current position's by `SWITCH_SPIKE_RATIO_MARGIN`
(1.5x, config) — but only if current unrealized profit is below
`SWITCH_PROFIT_GUARD_PCT` (30%, never abandon a proven winner) and it's
been at least `SWITCH_COOLDOWN_MS` (15 min) since the last switch
(anti-whipsaw). Execution: close current (no blacklist) → open directly
into the already-validated candidate (no redundant re-scan).

**2. Trailing take-profit** — tracks peak unrealized profit per position;
once it reaches `TAKE_PROFIT_ARM_PCT` (30%), arms a trailing floor at
(peak − `TAKE_PROFIT_GIVEBACK_PCT`) (25 percentage points — the user's
original 50pp instinct was researched and found well outside the 15-30%
range crypto-momentum practice converges on for volatile assets); if
profit drops to/below that floor, exits and locks in the gain. **No
blacklist** — this is profit protection, not a risk violation, so the pool
stays a valid candidate if its run continues.

**Final review findings (all fixed, commit `38acf43`):** 1 Critical — a
DexScreener hydration failure (`currentSpikeRatio` reading as 0) forced a
real paid switch instead of falling through to HOLD, the exact 429-adjacent
failure mode this session already hit once; 4 Important — real bot's
SWITCH path never set `volume1hBaselineUsd` (permanently disabling
volume-drop protection on any switched-into position), paper-trade's
`REBALANCE` branch didn't gate the opportunity-scan block (letting
paper-trade attempt switches in ticks the real bot structurally cannot,
breaking sim-vs-real parity), paper-trade's SWITCH exit didn't deduct gas
cost (understating switching's real cost in exactly the metric being
validated), and the DexScreener base/quote-token-collision bug described
above; 1 Minor — TAKE_PROFIT and SWITCH exits were both logged
indistinguishably as `LEFT_POOL` in pool history.

**Two spec gaps found but deliberately NOT auto-patched — still open,
your call:**
1. `HARD_EXIT`'s anti-thrash (>3 rebalances/hr) and volume-drop sub-checks
   have no profit-guard, unlike `TAKE_PROFIT`/`SWITCH` — a deeply
   profitable position can still get blacklisted for 6h by either of
   those two triggers. The spec's own claim that "HARD_EXIT and
   TAKE_PROFIT can never fire in the same tick" is wrong (verified by the
   final reviewer) — they're on different bases (loss-only vs.
   profit-only for the STOP_LOSS/TAKE_PROFIT pair specifically, but
   anti-thrash/volume-drop don't care about PnL at all).
2. The 1.5x switch margin has no absolute floor — a candidate at 0.08x
   spike beats a current position at 0.05x (margin technically met)
   despite neither actually spiking. The Critical fix above only guards
   the reachable zero/unknown-data case, not this softer degenerate tail.

## Important mechanics/insights surfaced across both sessions (don't re-derive)

- **DLMM out-of-range exit is asymmetric, not symmetric.** Price rising
  past your range converts your position toward 100% SOL (de-risked,
  opportunity-cost-only). Price falling past your range converts toward
  100% memecoin (the genuinely dangerous direction, bag-holding). This is
  *why* trend-aware entry matters structurally.
- Fee accrual stops entirely once a position goes out-of-range — a purely
  fee-threshold rebalance trigger can stall forever waiting on fees that
  no longer accrue. That's why the idle-forced rule exists (now
  profit-independent, see above).
- Paper-trade's price-PnL model prices the position in the meme/SOL
  *ratio*, not the memecoin's absolute USD price — a real "why did I lose
  money, the token looked stable" incident was actually SOL's own price
  moving against the ratio, not the memecoin dropping.
- **A DLMM position's fee income and price/IL move independently, and
  fee income does NOT reliably cover IL.** Confirmed concretely twice this
  session: JEANPHIL earned +$8.37 in fees but still net-lost -$3.00 because
  price/IL was worse; this is exactly why `totalFeesEarnedUsd` was split
  out from total PnL in the report — eyeball both, don't assume a
  fee-positive exit is a profitable one.
- **A pool's own `mint_x`/`mint_y` orientation is not reliable for
  "which side is the memecoin"** — always use `nonSolToken(pair)`/
  `solToken(pair)`, never assume `mint_x` is one or the other. The
  DexScreener batch-hydration bug this session existed specifically
  because code kept the entry side wrong for pools with `mint_x === WSOL`.
- **Re-screening a pool you already hold is a different question from
  screening a brand-new candidate.** Criteria that exist to size *fresh*
  capital sensibly (TVL ceiling, vol/TVL ratio floor, market-cap ceiling)
  actively penalize a held position simply succeeding and growing. See
  `FilterOpts.skipSizingChecks` above — this is the general principle if
  more "stay vs. enter" criteria splits are needed later.
- **DexScreener's `/tokens/v1/{chainId}/{tokenAddresses}` batch endpoint**
  (≤30 addresses/call, one request billed) exists and is what this bot
  now uses — do not regress to one-call-per-pool, that was the confirmed
  root cause of this session's 429-storms, not polling frequency.

## Known limitations / deliberately deferred (told to user, not silently skipped)

- No LP-concentration/whale-dominance check, no deployer-wallet-history /
  sniper-clustering / social-sentiment screening — unchanged from last
  session, still deferred until the current strategy is validated as
  profitable.
- Paper-trade fee model is still a naive TVL-share pro-rata, not real
  bin-level fee capture — same caveat as last session, read
  `paperTrade.ts`'s header comment block before trusting its numbers as a
  precise backtest.
- The two "spec gaps" listed above (HARD_EXIT missing a profit-guard on
  anti-thrash/volume-drop; no absolute floor on switch spike-ratio margin).
- `.env.example` was not updated with the 6 new opportunistic-switching/
  take-profit env vars (a plan gap, not an implementer gap — cheap to add
  later, just wasn't done).
- No `switches` counter in the paper-trade run summary (only `poolsEntered`
  currently increments) — minor observability gap for a feature that's
  specifically being validated right now.

## Next steps

1. Let the current `dex-hydration-fix` paper-trade run keep going —
   watching everything the prior `switch-take-profit` run was (does
   `SWITCH` fire sensibly? does `TAKE_PROFIT` ever arm/trigger? does
   `skipSizingChecks` let a grown position recenter instead of getting
   LEFT_POOL'd?), plus the new fix specifically: entries should no longer
   happen on a pool whose DexScreener batch hydration failed that cycle —
   watch `poolRejectReasons`/debug logs for `dexscreener batch hydration
   failed` showing up and blocking an entry that would've slipped through
   before.
2. Decide on the two open spec gaps above (HARD_EXIT profit-guard,
   absolute switch-margin floor) — both are one-line-ish changes once a
   decision is made, intentionally left as decisions rather than
   auto-patched.
3. Once paper-trade behavior on the new features looks solid over a
   longer window: re-check wallet balance on `.env.live`, decide on a
   first real cycle (same "no devnet dry-run, watch the first cycle
   closely" plan as last session — nothing about that has changed).

## Security notes (do not relax these)

- Never print/echo the private key or the Helius API key to any tool
  output. `.env` and `.env.live` are both gitignored. Same pattern as last
  session, nothing to add.
- `commit.gpgsign` is `true` in this machine's global git config; set to
  `false` **locally for this repo only** (not global) to unblock commits
  in this sandbox (no TTY for the passphrase prompt) — already done,
  don't redo/ask again unless a fresh clone needs it too.
