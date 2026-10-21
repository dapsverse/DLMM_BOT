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

