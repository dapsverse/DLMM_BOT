## Go-live criteria (real capital) — added 2026-09-28

User asked directly: "is `range-optAB` ready for real money yet?" Answer at
the time (43.6h in, +9.21%, 9 closed positions, 0 hard exits): **no** — the
signal is genuinely encouraging but the sample is far too small to promote
a strategy on, and two real bugs (idle-capital bootstrap bypassing the
capital/TVL gate, LEFT_POOL whipsaw) had JUST been fixed with zero
validation time on the fix itself. These are the concrete bars to clear
before moving `.env.live` capital into a real cycle, for WHICHEVER strategy
(`momentum`/`trend`/`range`, spot or DLMM) is being promoted — don't lower
these just because one strategy currently looks best:

1. **≥30 closed positions** for the specific strategy being promoted, not
   combined across strategies. 9 is not enough to distinguish skill from
   variance.
2. **≥3 calendar days of continuous unattended runtime** (revised
   2026-09-29 from 4 days, revised from an initial 5 — user's call,
   targeting a Friday start if 1-8 all check out; the clock restarts from
   the 2026-09-29 dexId=meteora fix + spot-drop restart, since criterion 3
   requires zero code changes in the counted window — 2026-09-29 ~00:19 UTC
   + 3 days lands exactly on 2026-10-02, Friday), ideally spanning more than
   one visibly different market condition (a clear uptrend stretch AND a
   choppy/down stretch) — a single lucky window isn't evidence the edge
   generalizes.
3. **A full run in that ≥3-day window with zero code changes needed** —
   i.e. the last stretch of data has to come from code that wasn't itself
   still being debugged. Two real bugs were found and fixed THIS session
   alone (2026-09-27/28); the run that counts toward criteria 1-2 has to
   start clean AFTER the last fix, not include time before it.
4. **Net positive cumulative PnL after all costs** (fees, gas, slippage —
   already what the paper-trade PnL number reports) over that window.
5. **Peak-to-trough drawdown ≤20%** at any point in the qualifying window
   (not just at the end) — a strategy that was ever down 50% before
   recovering to +9% is not the same risk profile as one that was
   monotonic. `trend-optAB-spot`'s pre-fix run (peak-to-trough -80%+) is
   the cautionary example already on file.
6. **`MAX_CAPITAL_TVL_RATIO_PCT` (5%) and `RANGE_MAX_VOLATILITY_PCT` (15%)
   deliberately revisited with data**, not left at their original
   starting-guess values by default — even if the conclusion is "5%/15%
   turned out fine," that has to be an explicit, evidenced call, not an
   oversight.
7. **An explicit decision on rug/whale-concentration/sniper-dump
   screening** — currently NOT implemented at all (see "Known
   limitations" above). Either build a basic version, or write down why
   it's being accepted as an open risk anyway. Silent deferral isn't a
   decision.
8. **One supervised manual dry cycle on the real bot** (`.env.live`, real
   wallet, the actual 1.2 SOL capital) — watched closely start to finish
   through at least one full entry→exit, per the standing "no devnet
   dry-run, watch the first cycle closely" plan every session has agreed
   to. Passing 1-7 on paper-trade doesn't skip this; the real bot has
   NEVER executed a single real transaction as of this writing.

None of these are met yet for any strategy as of 2026-09-28. Re-evaluate
against this exact list (don't re-negotiate the bar down) once the current
1.2-SOL-capital paper-trade runs (started this session, whipsaw fix +
bootstrap fix both live) have had time to accumulate.

