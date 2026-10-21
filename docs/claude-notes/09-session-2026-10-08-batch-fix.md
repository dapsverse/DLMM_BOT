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

