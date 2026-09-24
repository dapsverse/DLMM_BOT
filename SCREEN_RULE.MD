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
| TVL floor | `MIN_TVL_USD` | $50,000 | |
| TVL ceiling **[entry-only]** | `MAX_TVL_USD` | $300,000 | Was $1M → $150k (near-zero pro-rata fee share above this for ~$490 working capital) → raised to $300k to widen the candidate pool. |
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
| 6h uptrend floor | `REQUIRE_UPTREND` + `MIN_PRICE_CHANGE_6H_PCT` | true / 0% | Only enforced if `REQUIRE_UPTREND`. Unknown → pass. Was -5% (merely "not crashing"); tightened to require genuine positive momentum. |
| 1h activity vs. own 24h pace | `MIN_RECENT_ACTIVITY_RATIO` | 0.15 (15%) | Meteora's own volume field, always present — no unknown case. |
| 5m activity vs. own 24h pace | same `MIN_RECENT_ACTIVITY_RATIO` | 15% of `vol24h/288` | Unknown (`volumeM5Usd` undefined) → pass. |
| 5m tx count absolute floor | `MIN_TX_COUNT_M5` | 20 trades (buys+sells) | Unknown → pass. Exists because a weak-24h-baseline pool can pass the ratio check above with 0 real trades. |
| Wash-trade heuristic | `WASH_TRADE_VOL_TVL_RATIO_THRESHOLD` / `WASH_TRADE_FLAT_PRICE_BAND_PCT` (constants.ts) | reject if vol/TVL > 30x AND \|1h price change\| < 2% | Unknown 1h price → pass. Heuristic, not a guarantee — organic high-ratio/flat-price pools exist too. |
| Mint authority revoked | `REQUIRE_MINT_AUTHORITY_DISABLED` | true (required) | **Fail-closed** — unlike every other unknown-tolerant rule above, unknown/failed RPC lookup here REJECTS the pool. |

---

## Ranking (after all filters pass)

Not a filter — decides which surviving candidate(s) win, two-stage:

1. **Trend shortlist**: sort survivors by 6h price change descending, take
   top `TREND_SHORTLIST_SIZE` (3, constants.ts). Missing 6h data sorts last
   (never displaces a confirmed trend, but can still surface if too few
   candidates exist).
2. **Tie-break within the shortlist**: sort by `volumeSpikeRatio` descending
   — this hour's volume pace vs. the preceding 5h's pace (via DexScreener's
   6h volume figure). Not a raw vol/TVL ratio — a spike means volume is
   running hot *right now* relative to the pool's own recent baseline, not
   just "has always been busy."

Top of the shortlist = what `scanPools`/`enterBestPool` enters, or what
`scanForBetterOpportunity` compares against the currently-held pool.

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
| Volume-drop hard exit | `VOLUME_DROP_HARD_EXIT_PCT` | 60% drop vs. baseline |
| Idle-forced rebalance | `MAX_IDLE_OUT_OF_RANGE_MINUTES` | 10 min out-of-range, regardless of profit/loss (tried 5min, reverted — see below) |
| Take-profit arm | `TAKE_PROFIT_ARM_PCT` | 30% unrealized profit |
| Take-profit trailing giveback | `TAKE_PROFIT_GIVEBACK_PCT` | 25pp below peak |
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
- **Not yet decided which margin (`SWITCH_TREND_PROTECT_PCT`=10%, low-confidence default) is right** — running two live paper-trade instances side by side to compare: `cap1.15-reserve0.1` (old code, no trend/buy-ratio guards — started before this fix, still running the pre-fix logic in memory) vs `switchguards-b` (new code, both guards active). Same capital config (1.15 SOL / 0.1 reserve) on both, only the switch logic differs. Self-check: `src/scripts/checkSwitchGuards.ts`.

**Still open (not yet decided, see CLAUDE.md):**
- `HARD_EXIT`'s anti-thrash/volume-drop triggers have no profit-guard —
  can blacklist a deeply profitable position (unlike `TAKE_PROFIT`/`SWITCH`).

## Dead config (found while writing this doc, not acted on)

- `POOL_SCAN_INTERVAL_MS` (env.ts) is defined but **not referenced
  anywhere in `src/`** — the real scan throttle is `MIN_SCAN_INTERVAL_MS`
  (constants.ts, hardcoded 60,000ms, not env-tunable). Setting
  `POOL_SCAN_INTERVAL_MS` in `.env` currently does nothing.
