## 2026-10-08 session (continued further): researched sibling DLMM bots on
   GitHub, decided NOT to switch, ported 2 ideas instead (equity-scaled gas
   reserve, bin-array rent cost estimate)

User asked to survey GitHub for similar Meteora DLMM bots. Found
`CryptoGnome/dlmmbot` (+ fork `asterfi/dlmmbot`) as the closest match —
same thesis (scan/vet/one-sided-SOL-entry/rule-based-exit/paper-first) but
a much more mature, productized sibling: web dashboard, CLI, Railway/PM2
deploy automation, Kelly-criterion sizing with multi-sleeve portfolios,
backtesting/sim engine, full vitest test suite, TOML config with
hot-reload + operator "profiles" (aggressive/balanced/conservative), and a
commercial model (1% fee skimmed on live wins, PolyForm Shield license).
Read several of its actual source files (`scanner/gates.ts`, `risk/
limits.ts`, `ranges/planner.ts`, `vetting/rugcheck.ts`) for a real
comparison, not just the README.

**Decision: do NOT switch to it.** Reasoning (user asked for an honest
opinion, this was the answer): (1) their live executor automatically skims
profit, meaning adopting it means trusting unaudited third-party code with
real wallet custody — a direct regression against this session's own
private-key-safety discipline; (2) "production ready" (dashboard, tests,
TOML config) is tooling polish, not evidence of actual live profitability
— no visibility into their real track record, and the repo has only 3
stars; (3) this project's own codebase is now something we have full,
hard-won operational understanding of (every bug found/fixed tonight is
documented) — switching means starting that understanding from zero on
~2400 lines of someone else's `loop.ts`; (4) some of our own mechanisms are
arguably more rigorous already (the dollar-flow check reads real on-chain
reserve deltas directly, vs. their candle-color-based "red volume" proxy;
the chase guard is price-structure-based, not time-based).

**Ported 2 ideas instead** (into our own, fully-understood codebase):

1. **Equity-scaled gas reserve** — directly solves the exact pain from
   tonight's multiple restarts (manually re-tuning `MIN_GAS_RESERVE_SOL` by
   hand after nearly every restart: 0.8 → 0.35 → ... → 0.06, chasing the
   wallet's actual balance each time). New `computeGasReserveSol(equitySol)`
   (`rebalanceEngine.ts`) = `max(MIN_GAS_RESERVE_SOL as a FLOOR,
   equitySol * MIN_GAS_RESERVE_PCT/100)` (new env var, default 5%). Scoped
   deliberately narrow per explicit user instruction: ONLY the reserve
   scales with equity — `INITIAL_LP_CAPITAL_SOL` stays a fixed 1.3, same
   standing rule as before, not touched. Wired into all 4 places that used
   to read `env.MIN_GAS_RESERVE_SOL` directly as an absolute (both
   `reserveGasFromSolSide` call sites, `closeAndConvertToSol`'s
   `nextCapital`, `compoundCycle`'s pre-swap spendable estimate, and all 3
   `index.ts` call sites including the boot sufficiency check). Self-check
   `checkGasReserve.ts` rewritten to cover floor-wins-small/pct-wins-large/
   monotonic-scaling behavior, not just the original subtract-from-correct-
   side cases.
2. **Bin-array rent cost estimate** — this project never modeled DLMM
   bin-array rent at all before. New `estimateBinRentSol(radius)`
   (`costEstimate.ts`, `BIN_ARRAY_RENT_SOL=0.075`, `BINS_PER_ARRAY=70`) —
   deliberately an approximate, never-under-estimating ceiling (plain
   `ceil` + 1 safety array for alignment straddling), not the sibling
   project's alignment-exact version, since this is purely informational
   (logged at both `openInitialPosition` and `compoundCycle`'s reopen, not
   a hard budget gate yet). Self-check: `checkBinRent.ts`.

Both verified: `tsc --noEmit` clean, self-checks pass (27 now, +2 new:
`checkBinRent.ts`, `checkGasReserve.ts` extended), `npm run build` clean.

**First restart attempt immediately failed boot** — real validation, not a
bug: at the actual wallet balance (1.366484111), the OLD default
`MIN_GAS_RESERVE_PCT=5%` computed a reserve (0.0683) that, added to the
fixed 1.3 capital, exceeded the balance by ~0.002 SOL. This is the feature
working correctly (it computed a MORE accurate reserve than the stale
manual 0.06 that used to be there) — it just revealed that 5% (borrowed
directly from the sibling bot's default, tuned for presumably a much
larger scale) doesn't fit this project's current ~1.3-1.4 SOL scale
comfortably against a fixed 1.3 capital. Lowered to `MIN_GAS_RESERVE_PCT=3`
+ `MIN_GAS_RESERVE_SOL=0.03` (both in `.env.live`) — fits with ~0.025 SOL
of headroom at the current balance. Second restart booted clean.

**Not done, explicitly deferred**: Kelly-criterion sizing, multi-sleeve
portfolios, backtesting/sim engine, dashboard UI, TOML hot-reload config —
noted as real ideas worth considering in a FUTURE session, not pulled in
tonight (scope was explicitly limited to the 2 items above).

