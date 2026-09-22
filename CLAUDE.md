# meteora-dlmm-bot — session context (2026-09-22)

Single-pool auto-compounding Meteora DLMM LP bot for Solana memecoin pools.
5 SOL total budget (4.2 SOL working capital target, 0.8 SOL gas reserve in
the general design; a separate 1 SOL validation run is in progress, see
below). This file is the handoff — read it before doing anything else in a
fresh session.

## Where things stand right now

- **Git**: repo just initialized this session. `main` has **zero commits on
  purpose** (never commit directly to main — project rule). Real history
  lives on branches:
  - `chore/initial-import` — original baseline scaffold.
  - `feature/trend-aware-entry` — **current branch, all active work is
    here.** 8 commits on top of baseline (see `git log --oneline` for the
    full list — trend-shortlist entry logic, activity cascade, anti-idle
    rebalance, BidAsk shape, dynamic bin radius, two bookkeeping bugfixes).
  - Nothing has been merged into `main` yet. No PR opened yet (no git
    remote configured — this has all been local-only so far).
- **A live paper-trade simulation is running right now** in the background
  (started before context was cleared — check with `pgrep -fl
  paperTrade.ts`; if it died, nothing is lost, `logs/paper-trade-state.json`
  has the last snapshot). Started via:
  `PAPER_TRADE_HOURS=24 nohup npm run paper-trade > logs/paper-trade-stdout.log 2>&1 &`
  Check anytime with `npm run paper-trade:report` (auto-discovers every
  `paper-trade-state*.json` in `logs/`, prints each + a comparison if more
  than one).
- **Real-money setup is prepped but NOT started.** `.env.live` exists
  (gitignored, has a real Helius RPC key and a real wallet private key
  already filled in by the user) sized for a 1 SOL validation run
  (`INITIAL_LP_CAPITAL_SOL=0.7`, `MIN_GAS_RESERVE_SOL=0.3`). User was, as of
  last message, on their way to buy SOL on an exchange and send it to that
  wallet. **Nothing has been sent to the wallet yet as of this note** —
  confirm balance before running `npm start` against `.env.live`.

## Architecture (src/)

- `config/env.ts` — all tunables, validated with sane defaults, a few
  sanity-check throws (e.g. `MAX_CONCURRENT_POOLS` must be 1).
- `config/constants.ts` — non-tunable constants (API URLs, WSOL mint, retry
  counts, `TREND_SHORTLIST_SIZE`).
- `services/rpc.ts` — **wallet-free** Solana RPC reads (connection,
  `isMintAuthorityRevoked`, `getActiveBinId`, `getDynamicPriorityFeeMicroLamports`).
  Deliberately split from `solana.ts` because that module decodes the
  wallet's private key eagerly at import time — anything read-only
  (scanner, paper-trade) must import from `rpc.ts`, never `solana.ts`, or
  it'll require a real signing key just to run.
- `services/solana.ts` — wallet + signing-adjacent helpers, re-exports
  `rpc.ts`'s functions for convenience at real-bot call sites.
- `services/meteoraScanner.ts` — fetches Meteora's pool list
  (`dlmm.datapi.meteora.ag/pools` — the OLD `dlmm-api.meteora.ag/pair/all`
  is dead, migrated mid-session), the full memecoin screen, and the
  two-stage pool ranking (see below). Also exports `isPoolStillEligible`
  (single-pool re-screen, used by the anti-idle/rebalance-eligibility
  logic) and `getVolume1hUsd`.
- `services/meteoraDLMM.ts` — DLMM SDK wrapper (open/close position, claim
  fees). **Has two upstream packaging-bug workarounds documented inline**
  — read the comment block at the top of the file before touching
  anything DLMM-SDK-related:
  1. The published `.d.ts` is corrupted (raw IDL JSON leaks into the
     ambient declarations) — default export's TYPE resolves wrong. Fixed
     with a hand-typed local interface + one cast.
  2. The published ESM build (`dist/index.mjs`) crashes at import time
     under plain Node/tsx — it does `import { BN } from "@coral-xyz/anchor"`
     but that package's ESM entry doesn't actually export `BN`. Fixed by
     loading via `createRequire` (forces the CJS build) instead of a
     normal `import`. **This is a real bug that would have crashed the
     live bot on its very first run** — only caught because paper-trade's
     bin-range feature exercised this import path for the first time.
- `services/jupiterSwap.ts` — Jupiter v6 swap wrapper (quote + swap +
  balance-to-50:50 + emergency-dump-to-SOL).
- `logic/riskManager.ts` — pure decision function `evaluatePosition()` →
  `HOLD | REBALANCE | HARD_EXIT`. HARD_EXIT on stop-loss / >3
  rebalances-per-hour / volume-drop. REBALANCE on fee-threshold (unclaimed
  fees > gas×2.5) **or** the idle-forced rule (see below).
- `logic/rebalanceEngine.ts` — the real bot's position lifecycle:
  `openInitialPosition`, `compoundCycle` (rebalance, replaces the old
  `executeAutoCompound`), `executeHardExit`, `getBinRangeStatus`,
  `updateOutOfRangeTracking`. Prices everything in SOL terms (no external
  price feed needed for its own decisions).
- `logic/binRange.ts` — `computeBinRadius(binStep)`: derives the bin
  radius from `TARGET_RANGE_PCT` (default 15%) instead of a fixed bin
  count, clamped to `[MIN_BIN_RADIUS, MAX_BIN_RADIUS]`. Replaces the old
  fixed `BIN_RANGE_RADIUS=10`, which covered wildly different % price
  ranges depending on a pool's `bin_step` (confirmed with real scanned
  data: same radius was ~±10% on one pool, ~±1.6% on another).
- `logic/costEstimate.ts` — `estimateCycleGasCostSol(capitalSol)`: gas +
  swap-slippage/DEX-fee estimate for the rebalance threshold check. **Was
  a real bug earlier this session** — the original flat 0.0002 SOL
  estimate didn't include slippage at all, so the fee-threshold triggered
  on almost every tick (real bots would have over-traded/bled gas). Fixed
  to include a slippage+fee component proportional to capital.
- `scripts/paperTrade.ts` — the simulator. No wallet needed (imports only
  `meteoraScanner.js` + `riskManager.js` + the pure logic modules, never
  `solana.ts`/`meteoraDLMM.ts`/`jupiterSwap.ts`). Runs the same
  scan→screen→decide loop as the real bot; approximates fee accrual
  (pro-rata TVL share of `fees_24h`) and price PnL (constant-product IL
  formula on the meme/SOL price ratio). **Read the file's header comment
  block for the full list of modeling caveats** — it's directional, not a
  precise backtest, and it explicitly does not model bin-exit fee-capture
  effects. `PAPER_TRADE_LABEL=<name>` lets multiple sims run side by side
  without clobbering each other's state file.
- `scripts/scanOnce.ts` / `scripts/paperTradeReport.ts` — one-shot CLI
  tools (`npm run scan`, `npm run paper-trade:report`).
- `index.ts` — real bot's main loop. **Never actually run against real
  funds or even devnet yet** — only runtime-smoke-tested (`node --import
  tsx src/index.ts`), which confirms the whole module graph loads without
  crashing and fails only at the expected point (dummy `PRIVATE_KEY` too
  short to decode). The actual open-position/claim/close/swap transaction
  code paths have zero real-world execution history.

## Strategy design (current, on feature/trend-aware-entry)

Entry selection is **two-stage**, not a blended score (the blended version
let raw vol/TVL ratio dominate regardless of trend — fixed this session):
1. Filter cascade (binary pass/fail): TVL $50k–$1M, 24h volume ≥$200k,
   vol/TVL ratio ≥3x, `bin_step` ≥15, pool age ≥2h, memecoin-side market cap
   ≤$50M, holders ≥300, freeze+mint authority both disabled (mint-authority
   check is an on-chain RPC read — Meteora's API doesn't expose it),
   1h crash-guard (≥-20%), 6h floor (≥-5%, loosened from an initial 0%
   which starved the candidate list too hard), and an **activity cascade**
   (1h and 5m volume must each be ≥15% of the pool's own 24h average pace
   — catches a pool whose 24h number looks fine but has actually gone
   quiet/stale right now).
2. Among survivors: shortlist the top `TREND_SHORTLIST_SIZE` (3) by 6h
   price change, then pick the best vol/TVL ratio **within that shortlist
   only**. Trend gates which pools are in contention; ratio breaks ties.

Position: `StrategyType.BidAsk` (not Spot) — Meteora's own docs recommend
BidAsk for volatile pairs specifically (liquidity concentrated at range
edges, captures more fee on price jumps); Curve is explicitly not
recommended for volatile pairs. Range radius is `computeBinRadius()`
(above), not a fixed bin count.

Rebalance/exit: fee-threshold (unclaimed fees > gas-cost × 2.5) **or**
idle-forced (out-of-range >`MAX_IDLE_OUT_OF_RANGE_MINUTES` (10) while
*already in profit* — never force-crystallizes a loss). Either trigger
runs the same `compoundCycle`: close → claim → re-check whether the held
pool still passes the **full entry screen** (`isPoolStillEligible`,
reusing the same filter code, not a new heuristic) → if yes, rebalance
50:50 and reopen here at the new price; if no, convert everything to SOL
and return null (no blacklist — not a violation, just re-scan for a
different pool next tick).

**Explicitly rejected after checking practitioner/community sources**:
asymmetric/directionally-skewed ranges. Evidence was thin that this is
real, common, or effective practice for memecoin LPing — not worth the
complexity without a real signal it helps. Don't re-litigate this without
new evidence.

## Important mechanics/insights surfaced this session (don't re-derive)

- **DLMM out-of-range exit is asymmetric, not symmetric.** Price rising
  past your range converts your position toward 100% SOL (fees stop, but
  you're de-risked — the "bad" direction here is only opportunity cost).
  Price falling past your range converts toward 100% memecoin (bag-holding
  the depreciating asset — this is the genuinely dangerous direction).
  This is *why* trend-aware entry matters structurally, not just
  vibes-wise: entering an uptrending token biases which direction you're
  more likely to exit-range toward (the safe one).
- A `REBALANCE` decision does not mean "found a better token" — it means
  "close + claim + reopen," and until this session's `compoundCycle`
  refactor it always reopened in the *same* pool regardless of whether
  that pool was still any good. That's the gap the idle-forced-rebalance +
  re-eligibility-check feature closes.
- Fee accrual stops entirely once a position goes out-of-range (no swaps
  hit an idle bin range) — so a purely fee-threshold-based rebalance
  trigger can stall forever waiting on fees that no longer accrue. That's
  why the idle-forced rule exists.
- Paper-trade's price-PnL model prices the position in the meme/SOL
  *ratio*, not the memecoin's absolute USD price — a real "why did I lose
  money, the token looked stable" incident this session was actually SOL's
  own price moving against the ratio, not the memecoin dropping. Worth
  remembering when interpreting any future paper-trade loss.

## Known limitations / deliberately deferred (told to user, not silently skipped)

- No LP-concentration/whale-dominance check on a pool (nontrivial with the
  current API — no per-LP breakdown available).
- No deployer-wallet-history / sniper-clustering / social-sentiment
  screening — real gaps per research, but expensive to build; deferred
  until the current strategy is validated as profitable.
- Paper-trade fee model is a naive TVL-share pro-rata, not real bin-level
  fee capture — could meaningfully understate real fee capture (BidAsk +
  tight range in-range) or overstate it (doesn't model zero-fee
  out-of-range periods precisely by amount of time, only by the
  in-range/out-of-range boolean).
- Public anonymous RPC (`api.mainnet-beta.solana.com`) gets heavily
  rate-limited even for reads (429 storms observed repeatedly this
  session) — real run uses a free registered Helius key instead
  (`.env.live`).

## Next steps (what the user was mid-decision on)

1. Wait for the 1 SOL to land in the `.env.live` wallet.
2. Check wallet balance (`getWalletSolBalance`-style check, or just
   `solana balance <address>` — never need to see the private key for
   this).
3. Decide: run `npm start` directly against `.env.live` for a real first
   cycle (no devnet dry-run — Meteora has no ready-made devnet pools,
   confirmed via research; devnet would need self-deploying a test pool,
   not a quick shortcut), watch the first cycle closely.
4. Re-check the running paper-trade sim's cumulative result before
   committing, if it's still running / hasn't been superseded.

## Security notes (do not relax these)

- Never print/echo the private key or the Helius API key to any tool
  output — the user pasted the Helius key directly in chat once this
  session; it was written to file via a script whose stdout never
  contained the key, and never re-echoed afterward. Follow the same
  pattern for any future secret handling.
- `.env` and `.env.live` are both gitignored. `.env.live-1sol.example` (a
  template, now deleted by the user) was NOT gitignored by name — if a
  similar template file is ever recreated, keep its `PRIVATE_KEY=` blank
  and double check `git status` shows it untracked before any `git add`.
- `commit.gpgsign` is `true` in this machine's global git config; this
  sandbox has no TTY for the passphrase prompt. `commit.gpgsign false` was
  set **locally for this repo only** (not global) to unblock commits —
  already done, don't redo/ask again unless a fresh clone needs it too.
