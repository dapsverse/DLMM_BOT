# Pool screening rules — current state (2026-09-23)

Source of truth: `src/services/meteoraScanner.ts` (`filterAndRankPools`,
`poolRejectReasons`), params from `src/config/env.ts` (tunable via `.env`)
and `src/config/constants.ts` (hardcoded, not env-tunable). Values below
are what's **actually in effect right now** — `.env` overrides only where
noted, otherwise the code default applies.

Two modes, same function (`FilterOpts.skipSizingChecks`):
- **Fresh entry** (`skipSizingChecks: false`) — `scanPools`,
  `enterBestPool`, `scanForBetterOpportunity` (opportunistic-switch
  candidate scan). Full screen, every rule below applies.
- **Re-screen a pool already held** (`skipSizingChecks: true`) —
  `isPoolStillEligible`, paper-trade's out-of-range re-check. Answers
  "stay or leave", not "should new capital go here" — sizing-only rules
  are skipped so a position that simply grew doesn't get force-ejected
  for succeeding. Marked **[entry-only]** below.

---

## Stage 1 — pre-hydration filters (cheap, no network call)

Applied to every pool from Meteora's own API, in this order. All of these
run in **both** modes unless marked [entry-only].

| Rule | Param | Value | Notes |
|---|---|---|---|
| Not blacklisted | `BLACKLIST_DURATION_MS` | 6h (21,600,000ms) | Set on `HARD_EXIT` only (stop-loss/anti-thrash/volume-drop). `SWITCH`/`TAKE_PROFIT` exits do NOT blacklist. |
| TVL/volume sane | — | tvl/vol24h finite, tvl > 0 | Guards against bad API data. |
| TVL absolute backstop | `MIN_TVL_USD` | $1,000 (`.env`, was $50k → $35k → now just a "not literally dead" floor, 2026-09-25) | Real slippage-safety protection moved to `MAX_CAPITAL_TVL_RATIO_PCT` below — see Stage 3 table. |
| ~~TVL ceiling~~ | ~~`MAX_TVL_USD`~~ | **removed 2026-09-26** | Was $300k, rationale was LP fee-dilution in a big pool — moot now that fee income is already negligible/net-negative everywhere, and it never applied to the spot executor's rationale at all (no LP fee to dilute). Confirmed live: rejected SI-SOL's real $685k-TVL pool (sustained 6h/24h uptrend, 6M→9M mcap over 9h) solely on this ceiling, same night every <300k-TVL "new spike" pick crashed -12% to -50%. Slippage safety on the low end still fully covered by `MAX_CAPITAL_TVL_RATIO_PCT` — no equivalent risk exists on the high end (a deeper pool is safer, not riskier). |
| Capital/TVL ratio ceiling **[entry-only]** | `MAX_CAPITAL_TVL_RATIO_PCT` | 5% (env, default) — reject if (capital about to deposit) / (pool TVL) × 100 exceeds this | Unknown (no `currentCapitalSol` passed by caller) → pass. Added 2026-09-25, replaces `MIN_TVL_USD` as the real slippage-safety gate — a fixed dollar floor doesn't scale with how big our capital actually is. Confirmed live: 6 of 7 sampled ~$300k-mcap pools sat on $472-$22,632 TVL (below even a $35k floor) but were completely safe for ~$130 capital (0.3-3.3% ratio); the 7th (MACCA-SOL, $472 TVL) was genuinely too thin (27.5%) and correctly still rejected. Scales automatically as capital compounds — no manual re-tuning needed. Low-confidence starting guess (5%), not yet validated live. Self-check: `src/scripts/checkCapitalTvlRatio.ts`. |
| 24h volume floor | `MIN_24H_VOLUME_USD` | $200,000 | |
| Vol/TVL ratio floor **[entry-only]** | `MIN_VOL_TVL_RATIO` | 3.0x | |
| Bin step floor | `MIN_BIN_STEP` | 15 | Wider bins = wider effective price range per bin. |
| Pool age floor | `MIN_POOL_AGE_HOURS` | 2h | Rug-risk / freshly-launched guard. |
| Has a non-SOL side | — | one of `mint_x`/`mint_y` must be WSOL | Pool rejected if neither side is SOL. |
| Memecoin market cap ceiling **[entry-only]** | `MAX_MEMECOIN_MARKET_CAP_USD` | $50,000,000 | Keeps scanner off blue-chip pairs. |
| Token holder floor | `MIN_TOKEN_HOLDERS` | 300 | |
| Freeze authority disabled | `REQUIRE_FREEZE_AUTHORITY_DISABLED` | true (required) | Rug guard. |

Survivors of stage 1 get hydrated (stage 2), then stage 3 runs.

---

## Stage 2 — hydration (not a filter, but feeds stages 3+)

- **DexScreener batch fetch**: up to `DEXSCREENER_BATCH_MAX_ADDRESSES`
  (30) non-SOL token addresses per HTTP call. Populates
  `priceChange1h/6h/24h`, `volumeM5Usd`, `volumeH6Usd`, `txCountM5`.
- **If the batch call itself fails** (429/timeout/etc — one failure kills
  the whole batch, not just one pool): every pool in that batch is marked
  `dexHydrationFailed = true` instead of silently keeping the fields
  `undefined`. (Fixed 2026-09-23 — see stage 3's first rule; before this
  fix, a failed batch let its pools sail through every "unknown data,
  don't block" check below as if verified-safe. Root-caused via STONK10-SOL
  entering with a real 5-minute tx count of 4 against a floor of 20.)
- **Mint authority check**: separate per-pool RPC read (not DexScreener),
  populates `mintAuthorityRevoked`.

---

## Stage 3 — post-hydration filters

| Rule | Param | Value | Unknown-data policy |
|---|---|---|---|
| DexScreener hydration succeeded **[entry-only]** | — (`dexHydrationFailed` flag) | reject if batch fetch failed | N/A — this rule exists specifically to NOT be lenient on missing data. Skipped on re-screen (a transient 429 shouldn't force-exit a held position). |
| 1h crash guard | `PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT` (constants.ts, not env) | reject if 1h price < -12% | Unknown → pass (don't block on a failed lookup). |
| 1h overextension ceiling **[entry-only, P1]** | `MAX_PRICE_CHANGE_1H_PUMP_PCT` | reject if 1h price > 60% | Unknown → pass. Added 2026-09-24: mirror of the crash guard for the pump direction — ranking below picks the most-accelerating pool, so without a ceiling that risks entering right at/near a local top. Entry-only: a HELD position pumping hard is the outcome this bot wants, not a reason to exit. **Low-confidence default (60%), not yet validated live.** |
| 24h overextension ceiling **[entry-only, P1]** | `MAX_PRICE_CHANGE_24H_PUMP_PCT` | reject if 24h price > 300% | Unknown → pass. Added 2026-09-25: the 1h ceiling above is blind to a pool whose whole move already happened over the last day and has since decelerated under it. Confirmed live: GO-SOL entered at spike 0.305x (just above loose floor), 1h only +10.51% (well under the 60% ceiling), but 24h +4637% — crashed -19% within the hour. Same failure pattern as the familiars-SOL incident (+4400% 24h) that justified the entry spike floor below, except that pool's spike ratio (0.182x) already caught it — GO-SOL's didn't. Entry-only, same reasoning as the 1h ceiling. **Low-confidence default (300%), not yet validated live.** |
| 6h uptrend floor | `REQUIRE_UPTREND` + `MIN_PRICE_CHANGE_6H_PCT` | true / 0% | Only enforced if `REQUIRE_UPTREND`. Unknown → pass. Was -5% (merely "not crashing"); tightened to require genuine positive momentum. |
| 1h activity vs. own 24h pace | `MIN_RECENT_ACTIVITY_RATIO` | 0.15 (15%) | Meteora's own volume field, always present — no unknown case. |
| 5m activity vs. own 24h pace | same `MIN_RECENT_ACTIVITY_RATIO` | 15% of `vol24h/288` | Unknown (`volumeM5Usd` undefined) → pass. |
| 5m tx count absolute floor | `MIN_TX_COUNT_M5` | 20 trades (buys+sells) | Unknown → pass. Exists because a weak-24h-baseline pool can pass the ratio check above with 0 real trades. |
| Wash-trade heuristic | `WASH_TRADE_VOL_TVL_RATIO_THRESHOLD` / `WASH_TRADE_FLAT_PRICE_BAND_PCT` (constants.ts) | reject if vol/TVL > 30x AND \|1h price change\| < 2% | Unknown 1h price → pass. Heuristic, not a guarantee — organic high-ratio/flat-price pools exist too. |
| Mint authority revoked | `REQUIRE_MINT_AUTHORITY_DISABLED` | true (required) | **Fail-closed** — unlike every other unknown-tolerant rule above, unknown/failed RPC lookup here REJECTS the pool. |
| 1h buy-ratio floor **[P2]** | `ENTRY_MIN_BUY_RATIO_1H` (env, default 0.5) | reject if 1h buyRatio ≤ threshold | Unknown → pass. Added 2026-09-24: a $ volume number is the same whether it's genuine buying or a sell-off — require buys to dominate before trusting the activity as a real signal. **Applies in BOTH modes** (health check, not a sizing check — buys flipping sell-dominant while holding is itself a reason to reconsider). Was a hardcoded constant; moved to env after `diagnoseRejections.ts` showed the 0.5 default alone rejected 53% of real candidates — see "Loosened" note below. |
| Entry spike floor **[entry-only, 'momentum' mode only]** | `ENTRY_MIN_SPIKE_RATIO` (env, default 1.0x) | reject if `volumeSpikeRatio` < threshold | No unknown-permissive case — `volumeSpikeRatio` itself already returns 0 for missing data, so this floor naturally catches "unknown" too. Added 2026-09-24 after `rankCandidates`'s acceleration-based ranking (P3) still let a cooled-off pool in when it was the ONLY candidate that passed the base filters — ranking can't help when there's nothing to rank against. Confirmed live: familiars-SOL entered at spike 0.182x with `priceChange24hPct` +4400% (an already-played-out runner), because 5 straight scans found no other candidate. Better to stay in `NO_CANDIDATE` (cash) than force capital into the only weak option. Was a hardcoded constant; moved to env — see "Loosened" note below. |
| Sustained-trend floor **[entry-only, 'trend' mode only]** | `TREND_MIN_SUSTAINED_PCT` (env, default 20%) | reject unless BOTH 6h AND 24h price change ≥ threshold | **Fail-closed** on unknown 6h/24h — unlike almost everything else in this table, verifying the sustained trend IS the point of this mode. Added 2026-09-26 as a SECOND, parallel entry track (`ENTRY_STRATEGY_MODE=trend`, paper-trade only so far) alongside momentum-chase, not a replacement — see "Entry strategy modes" section below. |

---

## Entry strategy modes (`ENTRY_STRATEGY_MODE`, added 2026-09-26)

Three independent entry tracks, selected per paper-trade instance (`momentum` default, `trend`/`range` opt-in). All filters above this section (TVL floor, volume/ratio floors, age, mcap, holders, freeze/mint authority, crash guard, overextension ceilings 1h/24h, activity cascade, tx count, wash-trade, buy-ratio) apply **identically to all three** — only the acceleration/sustain/volatility question and the ranking differ:

- **`momentum`** (existing, unchanged) — `ENTRY_MIN_SPIKE_RATIO` floor + `rankCandidates` (sort by `volumeSpikeRatio`, see P0-P4 below). Chases whatever's accelerating RIGHT NOW. Pairs with the spot executor (validated as the right fit — IL costs nothing to a strategy with no LP position).
- **`trend`** — skips the spike floor entirely, requires `TREND_MIN_SUSTAINED_PCT` on BOTH 6h and 24h, ranks by TVL descending (`rankTrendCandidates` — biggest/most-established first, not fastest-accelerating).
- **`range`** (added 2026-09-26) — the opposite thesis, and specifically for the **DLMM/LP execution path** (not spot — a flat/sideways price gives spot ~0% while LP earns steady fee income, that asymmetry is the entire point). Rejects anything moving more than `RANGE_MAX_VOLATILITY_PCT` on EITHER 1h or 6h, ranks by vol/TVL turnover descending (`rankRangeCandidates` — a direct fee-yield proxy). **The one check in this whole screen that stays active on re-screen** (`skipSizingChecks: true` does NOT skip it) — a held range position that starts trending broke its own thesis, so it's re-evaluated live, not just at entry.

Opportunistic switching (`evaluateSwitchOpportunity`) is skipped for BOTH `trend` and `range` positions — momentum-style spike-ratio switching doesn't fit either non-acceleration thesis.

**Why `trend`**: confirmed live 2026-09-25/26 that `momentum`'s spike floor structurally excludes an already-successful, steadily-holding winner. SI-SOL's real Meteora pool ($685k TVL, +66% 6h / +46% 24h, mcap 6M→9M over 9h, spike ratio only 0.21x) was rejected by every running `momentum` instance on spike ratio alone, the same night every entered "new spike" candidate (goon-SOL, AQUA-SOL, OP-SOL, etc.) crashed -12% to -50%.

**Why `range`**: confirmed live 2026-09-26 that `momentum`-strategy DLMM instances consistently lose ~half as much as their spot siblings on a losing position (IL + the 50/50 SOL/token basket dampens both directions ~2x) — meaning DLMM run on a momentum/directional target is structurally worse than just holding the token directly, paying rebalance costs for a smaller, dampened bet. LPing's actual edge (per DeFi practice broadly) is fee income on range-bound/stable/correlated pairs where IL costs near-nothing — `range` mode targets exactly that, isolated to the DLMM execution path.

Whether `trend`/`range` actually net better outcomes than `momentum` over time is **unvalidated** for both — that's exactly what running all tracks side by side in paper-trade is for, same methodology as the LP-vs-spot comparison itself.

---

## Ranking (after all filters pass) — rewritten 2026-09-24 (P3 + P4)

Not a filter — decides which surviving candidate(s) win. **Old version**
sorted by raw `priceChange6hPct` descending (biggest cumulative mover),
tie-broken by `volumeSpikeRatio`. Confirmed live this picks pools near/past
their local top for a mean-reverting memecoin — post-entry 20min windows
routinely showed **-8% to -28% troughs** right after entry. New order
chases acceleration instead of magnitude, three stages (`rankCandidates()`,
exported + independently testable, see `src/scripts/checkRankCandidates.ts`):

1. **Shortlist by `volumeSpikeRatio` descending** — this hour's pace vs.
   the preceding 5h's (a RATE signal). A pool up only +5% over 6h but
   running 3x its own recent pace right now is plausibly earlier-stage than
   one up +40% over 6h whose pace already cooled back toward 1x. Take top
   `TREND_SHORTLIST_SIZE` (3, constants.ts).
2. **Tie-break by `buyRatio1h` descending [P2 reused as ranking, not just a
   filter]** — among similarly-accelerating candidates, prefer genuine
   buy-dominance over ambiguous $ volume. Missing data sorts last.
3. **Tie-break by `priceChange24hPct` ascending [P4]** — prefer a flatter
   24h background (the move is new) over an already-known multi-hour/day
   runner (most of its gain happened before the last 6h). Missing data
   sorts last.

`requireUptrend`/`MIN_PRICE_CHANGE_6H_PCT` (Stage 3 above) still gates
*qualification* ("must be positive over 6h") — only the *ranking* metric
changed, from magnitude to acceleration.

Top of the shortlist = what `scanPools`/`enterBestPool` enters, or what
`scanForBetterOpportunity` compares against the currently-held pool.

**[P0] Decision-context logging**: `ENTER`/`SWITCH` events (paper-trade
JSONL) and `index.ts`'s equivalent `logger.info` calls now carry
`priceChange1hPct`/`6hPct`/`24hPct`, `volumeSpikeRatio`, `buyRatio1h` at
decision time — added specifically so a future "was this entry chasing an
already-extended pump?" question can be answered from logged data instead
of guessing (which is what this whole P0-P4 tuning round had to do).

---

## Adjacent decision rules (not entry screening, but gate what happens to a position once held)

These don't decide "is this pool eligible" — they decide "what does the
bot do with a position already open." Listed for completeness since
they interact with the screen (e.g. `SWITCH`/`TAKE_PROFIT` exits skip
the blacklist, so the pool stays eligible for the very next scan).

| Rule | Param | Value |
|---|---|---|
| Stop-loss | `STOP_LOSS_PCT` | 25% |
| Anti-thrash | `MAX_REBALANCE_PER_HOUR` | 3/hour |
| Rebalance cooldown | `REBALANCE_COOLDOWN_MS` | 5 min |
| Volume-drop hard exit | `VOLUME_DROP_HARD_EXIT_PCT` | 60% drop vs. baseline (baseline = `volume1hUsd` at entry/switch — **never refreshed** by default, not even on compound in the real bot; paper-trade refreshes on full compound only) |
| Volume-drop Option A: periodic baseline refresh | `VOLUME_BASELINE_REFRESH_MS` | 0 = off (default). Refreshes the baseline above every N ms while holding, reusing the volume figure already fetched each tick — no extra API call |
| Volume-drop Option B: grace period | `VOLUME_DROP_GRACE_MS` | 0 = off (default). Suppresses the volume-drop check for N ms after the baseline was last set (entry/switch/Option-A refresh) |
| Idle-forced rebalance | `MAX_IDLE_OUT_OF_RANGE_MINUTES` | 10 min **continuous** out-of-range (debounced, see below), regardless of profit/loss (tried 5min, reverted — see below) |
| ~~Fee-threshold rebalance~~ | ~~`FEE_GAS_MULTIPLIER`~~ | **Removed 2026-09-26.** Used to fire a standalone "claim fees without closing" tx whenever unclaimed fees cleared `gas * 2.5`, while still in-range. Traced through both callers (`rebalanceEngine.ts`'s `claimFeesOnly`, `index.ts`) and confirmed it bought nothing: claiming mid-position never reinvests (real compounding only happens at close+reopen, which re-reads the FULL wallet balance anyway — any earlier claim just gets swept in later), and every position-changing event (SWITCH/idle-forced REBALANCE/HARD_EXIT/TAKE_PROFIT) already folds accrued fees into its exit value for free. Net effect of the old trigger: pure extra gas for zero compounding benefit. REBALANCE now only ever fires idle-forced (out-of-range). User-observed, same session as the take-profit tier change. |
| Take-profit trailing floor | `TAKE_PROFIT_TIERS` (constants.ts, not env — see doc comment there) | **Sticky per tier, not a flat giveback**, added 2026-09-26: below 30% peak, not armed. Peak 30-100% → floor locks at 25% (stays there across the whole band, doesn't recompute toward the next tier). Peak 100-125% → floor 50%. Peak 125-150% → floor 100%. Peak ≥150% → floor rolls at `peak - 25pp` (the last tier's own giveback delta), same behavior as the old flat model but only above 150%. Replaced a flat `TAKE_PROFIT_ARM_PCT=30` / `TAKE_PROFIT_GIVEBACK_PCT=25` (both removed) after PAID-SOL peaked +57.71% and got exited at +32.28% — the flat 25pp giveback locked way too early relative to peak in the 30-100% band, and the token kept running to +136%+ afterward. Applies to BOTH DLMM and spot (shared `evaluatePosition`/`trailingTakeProfitFloorPct`), and to the real bot too, not just paper-trade — unvalidated over multiple live episodes so far, same as the flat version was when it shipped. |
| Opportunistic switch scan interval | `OPPORTUNITY_SCAN_INTERVAL_MS` | 5 min |
| Switch requires candidate to beat current by | `SWITCH_SPIKE_RATIO_MARGIN` | 1.5x spike ratio |
| Switch candidate absolute floor (new, riskManager.ts) | `SWITCH_CANDIDATE_MIN_ABSOLUTE_SPIKE_RATIO` | 1.0x — candidate must be genuinely spiking (> its own recent pace), not just relatively-less-dead than current |
| Switch blocked above | `SWITCH_PROFIT_GUARD_PCT` | 30% current unrealized profit |
| Switch blocked if current pool still trending (new, riskManager.ts) | `SWITCH_TREND_PROTECT_PCT` | 10% — current pool's own 6h price trend, independent of personal profit% |
| Switch candidate must be buy-dominant (new, riskManager.ts) | `SWITCH_CANDIDATE_MIN_BUY_RATIO` | 0.5 — candidate's 1h buys/(buys+sells) must be > 50%, else the "spike" is treated as possible dump/distribution, not a real signal |
| Switch cooldown | `SWITCH_COOLDOWN_MS` | 15 min |

**Resolved this session (both confirmed by a live 12h paper-trade sample, `idle5-tvl300k`):**
- `MAX_IDLE_OUT_OF_RANGE_MINUTES` 5min → thrashed: 12h sample racked up 10 entries/5 switches/4 rebalances/3 leave_pool (vs. 3 entries/1 rebalance in a prior 4.6h sample at 10min), and gas cost ($13.82) exceeded fee income ($12.57) for the whole run. Reverted to 10min.
- `SWITCH_SPIKE_RATIO_MARGIN` absolute-floor gap → fired for real: `21:02:27` SWITCH from SI-SOL back into SI-SOL itself, `candidate spike 0.26x >= current 0.17x * margin 1.5 (required 0.26x)` — neither side was actually spiking (both well under 1.0x), margin math alone let it through. Fixed with the 1.0x absolute floor above.

**Added this session, unverified yet (2 params, both new gates on `evaluateSwitchOpportunity`):**
- `SWITCH_TREND_PROTECT_PCT` — user observed SI-SOL switched away at only +11% unrealized profit (well under the 30% `SWITCH_PROFIT_GUARD_PCT`) right as its volume spike cooled; its mcap kept climbing 2M->6M+ for hours after the bot left. The profit guard only protects based on *personal* PnL (depends on entry timing); this protects based on the *pool's own* price trend directly, so a still-trending winner isn't sacrificed to a hotter-by-volume candidate just because personal profit hasn't caught up yet.
- `SWITCH_CANDIDATE_MIN_BUY_RATIO` — a $ volume spike is the same number whether it's genuine buying pressure or a sell-off; user's idea to require buys to dominate (>50% of 1h tx count) before trusting a spike as switch-worthy.
- **Not yet decided which margin (`SWITCH_TREND_PROTECT_PCT`=10%, low-confidence default) is right** — running two live paper-trade instances side by side to compare: `cap1.15-reserve0.1` (pure old baseline, untouched all session, started 2026-09-23 09:14) vs `pumpguards-p0p4` (everything current: switch guards + P0-P4 + entry spike floor + idle debounce). Same capital config (1.15 SOL / 0.1 reserve) on both, only the code differs.

**Entry-time + safety-net fixes (2026-09-24), traced to a single live incident (familiars-SOL — entered stale, dropped hard, idle-forced never fired):**
- **`ENTRY_MIN_SPIKE_RATIO`** (see Stage 3 table above) — closes the gap where P3's acceleration-ranking can't help when there's only one candidate.
- **Idle-forced debounce** (`logic/outOfRangeTracking.ts`, shared by `rebalanceEngine.ts`'s `PoolContext` and `paperTrade.ts`'s `VirtualPosition`) — the position was oscillating right at its range boundary, and the old `updateOutOfRangeTracking` reset `outOfRangeSinceMs` to `null` on ANY single in-range tick, so it never accumulated a clean `MAX_IDLE_OUT_OF_RANGE_MINUTES` streak despite being effectively out-of-range most of the time. Now requires `OUT_OF_RANGE_RESET_GRACE_MS` (2 min) of *continuous* in-range before actually clearing the timer — a momentary flicker no longer resets progress. Self-check: `src/scripts/checkOutOfRangeDebounce.ts`.
- Not a gap: `STOP_LOSS_PCT` (25%) is independent of bin-range state (checked every tick off PnL directly), so it was never actually stuck — familiars-SOL got to -23.84% before recovering, close to but under the -25% floor.

**Loosened + diagnostic tool (2026-09-24, same day, few hours later):** after the entry-spike-floor + buy-ratio fixes landed, `pumpguards-p0p4` sat at `NO_CANDIDATE` for 17 straight ticks (~21min). Built `src/scripts/diagnoseRejections.ts` (tallies `poolRejectReasons()` across the full top-200-pool list, skips the RPC-heavy mint-authority check to avoid 429-storming — see its own doc comment) to find out why, instead of guessing:
- At the original defaults, `ENTRY_MIN_SPIKE_RATIO=1.0` alone rejected 99/123 (80%) of real candidates and `ENTRY_MIN_BUY_RATIO_1H=0.5` alone rejected 65/123 (53%) — moved both from hardcoded constants to env vars (`ScannerConfig.entryMinSpikeRatio`/`entryMinBuyRatio1h`) so they can be tuned without a code change.
- **But neutralizing all three of today's new entry checks entirely (spike=0, buy-ratio=0, overextension=99999) STILL left 0/123 pools passing.** The real bottleneck at that moment was the *pre-existing* screen (5m tx count 77, 6h uptrend 71, market cap 43, vol/tvl 43, activity cascade 65, tvl 72) — filters that predate this session entirely. Conclusion: today's additions aren't what emptied the candidate pool that day — the market was genuinely quiet against the bot's *whole* screen, old and new combined. `NO_CANDIDATE` in that state is correct behavior, not a bug.
- Loosened anyway for forward-looking A/B (not because it fixes the immediate quiet spell): `ENTRY_MIN_SPIKE_RATIO` 1.0 → 0.3, `ENTRY_MIN_BUY_RATIO_1H` 0.5 → 0.4. Third live paper-trade instance, `looser-entry`, running these looser values (same 1.15 SOL / 0.1 reserve capital config, all other code identical to `pumpguards-p0p4`) for comparison against both `cap1.15-reserve0.1` (old baseline) and `pumpguards-p0p4` (strict new defaults).

**Stale volume-drop baseline (2026-09-24, evening) — two toggleable fixes:** comparing `pumpguards-p0p4` vs `looser-entry` performance (-4.29% vs +8.62% at the time), both instances turned out to have entered the exact same WOW-SOL pool near-simultaneously and both got HARD_EXIT'd ~31s apart for the identical reason ("1h volume dropped ~63%"). Root cause: `volume1hBaselineUsd` is captured once at entry and never refreshed for the rest of the position's life — worse in the real bot than paper-trade realized, since `compoundCycle` in `rebalanceEngine.ts` never touches it at all (paper-trade at least refreshes it on a full compound). Entering during a volume spike (which the entry-spike-floor now actively selects for) pins the baseline at an inflated level; normal spike decay over the next 1-3h then reads as a false-positive HARD_EXIT. `pumpguards-p0p4`'s second pick (GROK-SOL, spike 1.44x) hit the same trap in just 37 minutes.
- **Option A** — `VOLUME_BASELINE_REFRESH_MS` (0 = off): periodically refresh the baseline while holding, reusing the volume figure already fetched every tick. Root-cause fix, but too-frequent a refresh makes the check nearly blind to a genuinely fast real volume collapse.
- **Option B** — `VOLUME_DROP_GRACE_MS` (0 = off): suppress the volume-drop check for N ms after the baseline was last set. Simpler, but only delays enforcement — a position can still get exited right after the grace window for the same underlying reason.
- Both independently toggleable (0 = exactly the original behavior, unaffected). Self-check: `src/scripts/checkVolumeDropGuards.ts` (Option B only — Option A is caller-side logic in the tick loops, verified by code review instead).
- Three new live paper-trade instances to compare, all on top of `pumpguards-p0p4`'s codebase/entry-gate defaults (not `looser-entry`'s loosened ones — isolating this one variable): `voldrop-optA` (`VOLUME_BASELINE_REFRESH_MS=3600000`, 1h), `voldrop-optB` (`VOLUME_DROP_GRACE_MS=3600000`, 1h), `voldrop-optAB` (both). 1-hour values are low-confidence starting guesses, not yet validated.
- **`cap1.15-reserve0.1` (the original frozen baseline) retired** — user's call: it had drifted from +27.54% down to -6.62% overnight running pre-session code, no longer a useful reference point.

**Still open (not yet decided, see CLAUDE.md):**
- `HARD_EXIT`'s anti-thrash/volume-drop triggers have no profit-guard —
  can blacklist a deeply profitable position (unlike `TAKE_PROFIT`/`SWITCH`).

## Dead config (found while writing this doc, not acted on)

- `POOL_SCAN_INTERVAL_MS` (env.ts) is defined but **not referenced
  anywhere in `src/`** — the real scan throttle is `MIN_SCAN_INTERVAL_MS`
  (constants.ts, hardcoded 60,000ms, not env-tunable). Setting
  `POOL_SCAN_INTERVAL_MS` in `.env` currently does nothing.
