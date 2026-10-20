## 2026-09-30 session: DexScreener hydration fallback + range mode TVL/profit refinements + chase guard

Continuation of the same 4-instance run (`momentum-optAB`, `range-optAB`,
`momentum-optAB-90sol`, `range-optAB-90sol`) from the 2026-09-29 dexId fix.
Three real, distinct bugs/gaps found and fixed, all from watching live
paper-trade behavior — no speculative changes. Committed as `65f8534`.

**1. The 2026-09-29 dexId==='meteora' fix had a real regression.** After
3.68h of zero entries across all 4 instances (both `momentum` and `range`
screens independently returning "no candidate"), investigated whether
RugCheck's own rate limit was the new bottleneck (tested directly: 90 mints
at concurrency 4 resolved cleanly in 8.7s, 0 failures — ruled out). Traced
instead to `hydrateTrendData`: the `dexId === 'meteora'` filter (correct in
principle, fixes cross-DEX contamination) left **77/94 (82%) of real
candidates with zero DexScreener data at all** — confirmed live for
PAID-SOL/ANSEM-SOL/HOOKED-SOL/STOXES-SOL specifically, each a genuinely
live, high-volume Meteora pool per Meteora's own API, but DexScreener's
token-lookup endpoint only returns their `pumpswap`/`meteoradbc` pair, never
a `meteora`-tagged one. With no `volumeH6Usd` ever hydrated,
`volumeSpikeRatio` hard-defaults to 0 — guaranteed momentum-floor rejection
regardless of real market strength, and likely degraded trend/range's
DexScreener-sourced checks too. **Fix**: fall back to the highest-liquidity
pair (any DEX) when no meteora-tagged pair exists, instead of leaving the
field undefined forever (`highestLiquidityPair()`, `meteoraScanner.ts`).
Verified: candidate hydration coverage went from 17/94 to 94/94 in a live
re-test. Re-accepts a little of the original wrong-DEX-data risk, but only
for the 82% of pools that would otherwise get zero signal and guaranteed
rejection — net better. All 4 instances restarted on this fix.

**2. `range` mode refinements**, from watching `range-optAB` (1.2 SOL) vs
`range-optAB-90sol` (90 SOL) diverge to **-45.11% vs +24.06%** on the
*identical* strategy over the same ~11h window:
- **`RANGE_MIN_TVL_USD` (new, default 60,000, absolute not capital-relative)**
  — `range-optAB` entered `o-SOL` TWICE at $15,837 and $11,442 TVL
  (`MAX_CAPITAL_TVL_RATIO_PCT` scales with capital and let this through at
  1.2 SOL; at 90 SOL the same ratio would have blocked it). The second
  entry HARD_EXIT'd at -43% unrealized loss. TVL that thin is fragile
  regardless of how small our own position is — a genuinely different risk
  from price-impact, needed its own absolute floor. $60K chosen from the
  data itself: disasters clustered $11K-59K, healthy range entries
  (SI-SOL) sat $261K-574K.
- **`RANGE_CEILING_PROFIT_OVERRIDE_PCT` (new, default 0) +
  `rangeCeilingProfitOverride()` (`riskManager.ts`, shared by
  `paperTrade.ts` and `rebalanceEngine.ts` so both stay in parity)** —
  `range-optAB-90sol` left a SI-SOL position at ~28% peak profit (right
  before the idle-timer + volatility-ceiling combo fired) — SI-SOL then
  ran ~2x further. The existing sticky trailing-take-profit tiers
  (`TAKE_PROFIT_TIERS`, arm at 30%) never got a chance to engage because
  the idle-forced re-screen abandons the pool unconditionally, before
  profit could ever reach that arm threshold. Fix: when a held range
  position's re-screen fails ONLY on the volatility-ceiling reasons (not
  crash guard / dead activity / authority — those still abandon as
  before) AND current profit clears the threshold, don't abandon —
  recenter the bin and keep holding, letting the existing trailing-tier
  system govern the eventual exit. User explicitly rejected a time-based
  cooldown alternative for this same reasoning (see chase guard below) —
  profit-gating was judged the safer mechanism here specifically because
  the existing take-profit tiers already provide the downside protection
  once armed.

**3. Chase guard (`ScannerConfig.chaseGuardPools`, all modes)** — found
while explaining `momentum-optAB-90sol`'s worse-than-range behavior:
sold SI-SOL on a legitimate crash-guard exit at ~$23.8M mcap, whipsawed
through 2 losing rotations on other tokens (GP-SOL: dead activity, -8.2%;
PAID-SOL: another crash-guard, -8%) over ~7h, then re-bought the SAME
token fresh as a "new" accelerating candidate at ~$48.6M mcap — over 2x
higher than where it sold, zero memory of the prior loss. **A time-based
cooldown cannot fix this** (the 7h gap already exceeded both
`LEFT_POOL_COOLDOWN_MS` 20min and `BLACKLIST_DURATION_MS` 6h) and user
correctly rejected a fixed retention window as the fix on principle: a
memecoin can reverse bear→bull faster than any reasonable window, so a
blanket "no re-entry for N hours" would also block genuinely valid
reversals. **Fixed on price structure instead of time**: record the exit
price per mint (not pool address — the same token can list multiple
Meteora pools at different bin-steps, confirmed for this exact SI-SOL
case) on every exit; a mint stays guarded against re-entry above that
price until its OWN price has genuinely dipped back to/below it at least
once (checked every scan tick against data already fetched, no extra API
call) — then the guard clears **permanently**, not on a timer. A fast
reversal clears the guard fast; a token that never truly retraces stays
blocked indefinitely, however much calendar time passes. Wired into all 4
of `paperTrade.ts`'s exit paths (HARD_EXIT/TAKE_PROFIT/LEFT_POOL/SWITCHED)
and into `rebalanceEngine.ts`'s real-bot exit paths (`executeHardExit`,
`executeCleanExit`, `compoundCycle`'s abandon branch) via a new
`getCurrentPriceUsd()` lookup against Meteora's own `/pools` API (the real
bot otherwise prices everything in SOL-ratio terms with no USD feed of its
own, by design — see `rpc.ts`'s doc comment — so this is a deliberate,
narrow, one-off USD lookup just for this one purpose, not a broader
architecture change).

Two new self-checks (`checkRangeTvlFloorAndProfitOverride.ts`,
`checkChaseGuard.ts`), all 12 self-checks in the repo pass, TypeScript
clean. All 4 paper-trade instances restarted again on this combined fix
(restart timestamp 2026-09-30 ~00:02 UTC).

**Go-live clock restarted again, and it now misses the Friday target.**
Criterion 3 (below) requires the counted window to start AFTER the last
code change — today's 3 fixes are exactly that kind of change. New restart
timestamp 2026-09-30 ~00:02 UTC + 3 days lands **2026-10-03, Saturday**,
not the 2026-10-02 Friday target from the prior restart. Flagging this
explicitly rather than quietly re-deriving a new date that happens to still
say Friday — it doesn't, one more day slipped. If a fresh session or the
user wants a hard Friday start regardless, that would mean accepting a
window shorter than 3 days on the current code, a deliberate trade-off to
surface, not decide silently.

