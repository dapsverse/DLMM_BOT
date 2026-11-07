# Strategy research + 3 paper strategies (2026-11-04)

Goal: strategies from our own data, not tied to the Meridian rules. Facts and assumptions are marked. Sample sizes are small everywhere; nothing below is proof.

## 1. Data findings

### 1a. Real closed trades (`state/ai-outcomes.jsonl`, 95 clean trades, 16 Oct - 3 Nov; FACTS)
- Net about -0.87 SOL on the 75 trades with a measured realized PnL. Fees per trade ~0.005 SOL, about the same as gas: at ~1 SOL per position fees barely cover costs.
- 4 stop losses = -1.105 SOL; the 7 bid-ask flips = -1.045 SOL; everything except flips is about -0.02 SOL.
- By exit kind (n, avg, hold): trailing TP +3.55% (n=10, +0.145 SOL, ~232 min); take profit +5.73% (n=5); pumped far above +0.11% (n=25, 28 min); AI exit -1.33% (n=32); low yield -0.16% (n=13, ~61 min).
- Positions that stay in range for hours and exit on trailing/TP are the profitable ones. OOR-above exits earn ~0. Losses come from dump tails (stop loss) and the flip phase.
- 5 of the 6 losses >= 10% were flips; entry features that differed for the big losers (medians): 6h change -18.5% vs +1.9%, % above the 48h low 906 vs 128, 24h change +463% vs +131. Volume spike, buy ratio, entry hour did NOT separate them (n=6, in-sample, picked after looking).

### 1b. S2 shadow data (`state/s2/*.jsonl`, 24-31 Oct, arm a0; model-based, see assumptions)
- Feature buckets of simulated PnL by fee/TVL 24h, TVL, bin step, mcap, holders were computed with a jq join (earlier in this session). Higher fee/TVL 24h and larger TVL/mcap/holders buckets did better than the small/new ones; the fee model has a bias (below).

### 1c. Backtest of exit/ladder structure on S2 candidates (`src/scripts/zzStratBacktest.ts`, run 2026-11-04; MODEL results)
Candidates passing the base entry gates (341 decisions, 61 pools), 1 SOL per position, ladder SOL-only, no flip, bot TP/trailing unless stated:
- 69 bins SL25: +0.93 SOL, avg +0.27%, win 39%, PF 1.70
- 69 bins SL12: +0.85 SOL, avg +0.25%, PF 1.64
- 35 bins SL12: -2.60 SOL, avg -0.76%, PF 0.36
- 25 bins SL10: -4.11 SOL, avg -1.21%, PF 0.21
- 25 bins SL8/TP8: -4.12 SOL; 15 bins SL6/TP6: -5.85 SOL, PF 0.08
With fee/TVL 24h >= 7 (169 decisions): 69 bins SL12 +1.015 SOL (avg +0.60%, win 63%, PF 1.69, t 1.76); 69 bins SL25 +0.91 SOL; every narrower variant stays strongly negative.
Reading: in this model, wide ladders with a tight-ish stop beat narrow ones, and every narrow variant lost.

### 1d. Assumptions / caveats (NOT proven)
- Fee model: fee = value x pool fee/TVL 24h at entry x minutes/1440 while in range, no concentration bonus. A real narrow range earns more per SOL than the pool average, so the model penalises narrow ladders; the "narrow loses" result is partly this bias. It is NOT proven that narrow ladders lose live.
- Simulated exits at 5m candle closes, exit cost 1% of token value + 0.0005 SOL gas per tx, no slippage beyond that, entry price = last closed candle.
- One of the winners in 1c comes from the same period used to design the gates (in-sample).

## 2. Three strategies (all paper only, 1 SOL per position, max 3 open, SOL-quoted pools only)

Common candidate source: the normal scanner in meridian mode (env `ENTRY_STRATEGY_MODE=meridian`, wallet-free); each strategy then applies its own entry rule. Unknown data = reject.

- A `dipladder` (buy the dip, wide): fee/TVL 24h >= 15, volume spike >= 0.5, price 10-30% below its 4h high. SOL-only bid-ask ladder 69 bins below the price. Exit: TP net +5%, trailing (trigger +3%, drop 1.5%), SL net -12%, out of range 30 min, time stop 12 h. Re-entry cooldown 120 min. Basis: 1c (wide + SL12 best), dip idea from the live dip gate.
- B `calm` (mature, two-sided): TVL >= 100k USD, mcap >= 5M, holders >= 5000, fee/TVL 24h >= 7, |6h change| <= 15%, 24h >= -30%. Two-sided 12+12 bins around the price (half SOL, half token bought at the swap cost). Exit: TP +3%, SL -6%, OOR 30 min, time stop 12 h. Cooldown 240 min. Basis: S2 buckets favour bigger/older pools; NO backtest of the two-sided shape exists, this is the exploratory arm. Unit sets `MERIDIAN_MIN/MAX_TVL_USD`, `MERIDIAN_MIN/MAX_MCAP_USD`, `MERIDIAN_MIN/MAX_BIN_STEP` 10-100, `MERIDIAN_MIN_HOLDERS` 5000 so the scanner passes such pools.
- C `hotyield` (momentum, wide): fee/TVL 24h >= 40, volume spike >= 1.5, 1h change -5..+25%, 24h <= +300%. Ladder 69 bins. Exit: TP +3%, SL -8%, OOR 15 min, time stop 3 h. Cooldown 60 min. Basis: highest-yield pools earned more in S2, but a pump/dump risk; short hold limits the dump tail. (A first draft with 12-bin ladders was dropped because of 1c.)

Net PnL per position = fees + (value at exit - deposit: IL and price move) - exit cost - gas. Comparators per exit: hold SOL = 0; hold the same token = deposit x (exit price / entry price - 1) (no entry cost).

## 3. Running paper units (systemd user, no wallet: `PRIVATE_KEY=SHADOW_RUNNER_NO_KEY`, `DOTENV_CONFIG_PATH=/nonexistent`)
- `dlmm-paper-dipladder`, `dlmm-paper-calm`, `dlmm-paper-hotyield`; script `src/scripts/paperStrategies.ts` (env `PAPER_STRATEGY`), logic `src/logic/paperStrategies.ts`, check `src/scripts/checkPaperStrategies.ts`.
- Data: `state/paper-strategies/<name>.jsonl` (entries/exits), `<name>-open.json`; logs `logs/paper-<name>.log`.
- Check progress: `npx tsx src/scripts/reportPaperStrategies.ts` (entries, closed/30, win rate, NET, fees / value change / exit cost / gas, hold-SOL and hold-token totals, exit reasons).
- Stop a unit: `systemctl --user stop dlmm-paper-<name>`. Units do not survive a reboot (transient `systemd-run`); re-run the command in CLAUDE.md after a reboot.
- The live `dlmmbot.service` and `.env.live` were not touched.

## 4. Pass criteria (decide after >= 30 closed positions per strategy)
- NET > 0 AND net per position > 0.5% (above fee-model noise) AND profit factor >= 1.3.
- Beats hold-same-token on the sum (a strategy that only matches buy-and-hold is not earning LP yield) and loses less than 15% of deposit in the worst trade.
- Not carried by one trade: removing the best trade keeps NET >= 0.
- The simulator pays pool-average fees (no concentration bonus, no slippage): a pass is a reason to go small-size live, not proof; a fail on A or C means the entry idea has no edge even under a fee-friendly model.
- Expected time: depends on scan hits; calm and hotyield entry rules are strict and may take days to reach 30.

## 5. Addendum 2026-11-05: strategy D `blitz` (aggressive, paper)
Requested by Master: more aggressive than `dipladder`. Unit `dlmm-paper-blitz`, same runner/logging/accounting (net PnL = fees + value change - exit cost - gas; comparators hold SOL = 0 and hold the same token; target 30 closed).

Parameters: concentrated TWO-sided position, 6 SOL-side bins + 6 token-side bins (range about +-6% at bin step 100) so it follows the token; capital 2 SOL (2x the others, paper); bin step 100-250 and TVL 20k-300k USD via unit env `MERIDIAN_MIN/MAX_BIN_STEP`, `MERIDIAN_MIN/MAX_TVL_USD`. Entry: fee/TVL 24h >= 30, volume spike >= 1.5, 1h change +3..+30%, 24h change <= +250% (positive momentum, no late parabola). Exit: TP net +2%, trailing (trigger +1.2%, drop 0.6%), SL net -3%, out of range 10 min, time stop 60 min. Max 3 open, cooldown 45 min.

Reasons (FACTS): fees per trade at ~1 SOL are about gas, so size and concentration are the only levers for fee income per position; OOR-above exits earn ~0, so a short time stop cuts dead time; in the first 10 h of paper, `calm` (two-sided) was the only strategy that captured a token pump (+3.99% net while the token rose 9.2%) while the SOL-only `dipladder` earned fees only (+1.88% while the token rose 64%): a two-sided shape participates in upside.
Assumptions / risks (NOT proven): the sim pays pool-average fees (no concentration bonus), so a narrow range is under-credited on fees but fully charged for IL, stops and the 1% swap cost on the token half; with TP 2% that friction is large. The backtest in 1c showed every narrow variant losing, so the expected result of `blitz` in this model is negative; a pass would mean real concentrated fees matter more than the model says. Sample at start: 0 closed. Pass criteria as section 4, and net per position must exceed the swap cost (about 0.5% of capital).
Correction 2026-11-05 (Master: blitz must NOT be selective, high-frequency paper): config changed. Old: capital 2 SOL, max open 3, cooldown 45 min, entry fee/TVL24h >= 30, spike >= 1.5, 1h +3..+30%, 24h <= +250%, unit scan filter bin step 100-250, TVL 20k-300k. New: capital 1 SOL x max open 2 (2 SOL max exposure; earlier drafts 0.5 SOL x 8 and 0.25 SOL x 8, corrected by Master the same day, their state was archived as `blitz*.bak-0.5sol` and `blitz*.bak-8pos`), cooldown 5 min, entry fee/TVL24h >= 0 (known), no spike rule, 1h -30..+100%, 24h -70..+1000%; TP +2%, trailing 1.2/0.6, SL -3%, OOR 10 min, time stop 60 min unchanged. Unit scan filter (env of `dlmm-paper-blitz`, set at `systemd-run`) must be widened to bin step 20-400, TVL 5k-1M, mcap >= 50k, holders >= 100 for the extra pools to reach the strategy; it takes effect only when the unit is re-created.
Risk fixes 2026-11-05 (after the fee 0.0000 investigation: the two closed blitz positions were the same tiny LEEROY-SOL pool, both left the range above within the first 2 candles, so no in-range candle accrued fee, and the +0.0256 SOL net was value change only, in a pool of 7-18k USD where a 1 SOL position is about 15% of TVL): (1) blitz enters only pools with TVL >= 50k USD AND position size <= 2% of TVL (size vs TVL unknown = reject); (2) slippage `slipFrac` = 2 x trade / TVL (capped 50%) on the entry swap of the token half and on the exit swap, on top of the flat 1%, ONLY for strategies with `maxPosPctOfTvl` (blitz), logged as `slippageSol`; (3) one position per TOKEN (any pool) and a 60 min cooldown per token after an out-of-range-above exit (rebuilt from the log on restart; exit lines carry `mint` from now on). `reportPaperStrategies.ts` also prints net without value change and the slippage total. Old blitz state archived as `blitz*.bak-pre-tvl`. Assumption: 2 x trade / TVL is a constant-product approximation, not a measured impact.
## 6. 2026-11-07: blitz stopped, S1 `widehold` + S2 `dipladder2` (paper)
Blitz stopped by Master's word after 135 closed positions: net -2.975 SOL (44 wins), fee +0.139, value change -2.173, exit cost 0.806 (slippage 0.143), hold token +1.512 SOL; 65 stop losses at avg -5.11% on a -3% stop (5m-close overshoot), 25 out-of-range-above exits at +1.02%. No subset was profitable in both time halves (split 2026-11-06 04:55 UTC). Data archived as `blitz*.bak-final-20261107`.
Simulator v2 (only for the new strategies, `simV2`): stop loss checked on the candle LOW and filled at the stop level (at the open on a gap); fee pro rata to the candle high-low span inside the range; max 5 entries per token per run; pool age (h) and 1h high-low range (%) recorded per entry (`cand.poolAgeH`, `cand.vol1hPct`); early kill after 15 closed positions when avg net < -1.5% or total < -0.3 SOL (no new entries; also shown by the report).
- S1 `widehold`: two-sided SPOT (uniform) +-35% (bins per side from the bin step), 1 SOL, max 2 open; entry TVL >= 150k, pool age >= 48 h, fee/TVL 24h >= 15, 24h -40..+150%, 5-25% below the 4h high, spike 0.5-3; exits: SL -15% (low), trailing after +6% (drop 2%), no fixed TP, out of range 60 min, time stop 24 h; cooldown 60 min. Unit env widens the scanner TVL/mcap window (meridian defaults cap TVL at 150k).
- S2 `dipladder2`: dipladder (69-bin SOL ladder, TP 5, trailing 3/1.5, SL 12 on the low, OOR 30 min, 12 h) plus 24h <= +300%, pool age >= 24 h, crash guard (one 5m candle > -10% open->close) and fast slide (30% of the ladder depth within 30 min of entry).
Assumptions: pool age stands in for token age; the fee is still the pool average (no concentration bonus); the flat 1% exit cost is kept. Pass/kill as section 4 plus the early kill above.
## 7. 2026-11-07: calm and hotyield loosened (paper)
calm had no entry since 5 Nov, hotyield never entered. A one-scan dry run (`PAPER_DRY_RUN=1`, logs each candidate and the reject reason, writes nothing) with the unit env showed the fee floor rejected every pool: calm 15/15 at fee/TVL 24h 0.2-4.5% (floor 7), hotyield 6/6 at 2.5-28% (floor 40), and every hotyield spike was 0.2-0.5 (floor 1.5). New: calm fee/TVL 24h >= 2 (other rules unchanged); hotyield fee >= 15, spike >= 0.3, 1h -10..+25% (was -5..+25), 24h <= +300% unchanged. Exits, SL and sizing unchanged; both now run simulator v2 and max 5 entries per token; old state archived as `calm*/hotyield*.bak-pre-loosen-20261107`. The runner's `cycle done` line now carries `rejects` (reason counts, numbers masked). Caveat: calm at fee 2-4.5%/day earns about 1-2% in its 12 h time stop before the ~1% exit cost; expect a thin edge at best.
Fix note: `reportPaperStrategies.ts` was committed empty by mistake (truncated while rewriting) and printed nothing until 2026-11-05; rewritten.
