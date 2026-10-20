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

