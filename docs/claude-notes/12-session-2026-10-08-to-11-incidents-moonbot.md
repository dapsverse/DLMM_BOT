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

