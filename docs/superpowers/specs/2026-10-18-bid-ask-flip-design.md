# Bid-Ask Flip (meridian mode) — design

Date: 2026-10-18. Status: awaiting user review. Branch: `feature/trend-aware-entry`.

## Intent

Yunus (meridian) strategy 1, "Bid-Ask Flip": DCA-in with a SOL-only bid-ask ladder, and once the liquidity has turned into the token, withdraw
and redeposit the token only (bid-ask above the price) to DCA-out on the bounce. Our `sol_ladder` is step 1; this adds the flip.
The fast tight-range scalp (strategy 2) is out of scope here and gets its own spec later.

## Agreed flow (user decisions, 2026-10-18)

1. Open `sol_ladder` as today.
2. Token share < 80%: all normal meridian rules (TP 5%, trailing arm 3% / drop 1.5, OOR 30 min, low-yield, SL 25%).
3. Token share >= 80%, confirmed over 2 ticks (15 s each): flip.
4. Flip phase, downside: SL 25% of the ORIGINAL deposit stays as the floor. No OOR-time exit, no flip limit, no recenter (user: wait for the bounce).
5. Flip phase, upside: no fixed TP. Trailing arms at cycle PnL peak >= 5% (not 3%), closes 1.5 points below the peak (same distance as meridian).
   The final take-profit is the existing "price above the range" close (token fully sold into SOL).
   A position that never reaches 80% keeps TP 5% / trailing 3% as before.

## Mechanics

- Trigger: `ctx.ladderBins !== undefined && !ctx.tokenSpot && !ctx.flipPhase` and token share (non-SOL principal / position value, same figure the AI
  manager snapshot already computes in `index.ts`) >= `FLIP_TOKEN_SHARE_PCT` (80, new env). Confirmed by the existing confirmer pattern (2 ticks).
- Flip action (`executeFlip` in `rebalanceEngine.ts`), inside `guarded()` (sets `inFlight`):
  1. `closePositionFull` (claims fees, returns SOL + token).
  2. `waitForTokenBalance` on the token (stale-read guard, expected amount from `positionData` before closing).
  3. `openLadderPosition(pool, !xIsSol, tokenAmount, bins, StrategyType.BidAsk, TOKEN_SPOT_START_OFFSET_BINS)`: token-only, above the price, ONE tx.
  No Jupiter swap, so none of the ~1% per-leg friction of `token_spot`.
- The leftover SOL from the close stays in the wallet ("banked"); `ctx.bankedSol` records it. It is NOT redeposited.
- New ctx fields (persisted in `PersistedPosition`, optional so old files still parse): `flipPhase?: boolean`, `bankedSol?: number`.
  `ctx.tokenSpot` stays false; geometry for the flip position reuses the token-side `ladderBounds(center, bins, !xIsSol)` exactly like `token_spot`.
  Call sites that branch on `ctx.tokenSpot` for geometry/range status (`index.ts` ~537, `rebalanceEngine.ts` `getBinRangeStatus` ~168) must treat
  `flipPhase` like the token-side case. Introduce one helper `isTokenSide(ctx) = ctx.tokenSpot || ctx.flipPhase` instead of editing each site ad hoc.
- PnL basis: `initialDepositSol` is unchanged by the flip and the peak PnL is NOT reset. In flip phase
  `cycle PnL = (position value + unclaimed fees + bankedSol) vs initialDepositSol`. Without `bankedSol` the SL could fire falsely (20% of the value sits in the wallet).
- Exit rules in flip phase (`meridianExitSignal` inputs):
  - trailing trigger = `FLIP_TRAILING_TRIGGER_PCT` (5), drop = `MERIDIAN_TRAILING_DROP_PCT` (1.5); fixed TP disabled (`takeProfitPct = Infinity`).
  - OOR-time close disabled for price BELOW the range; "price above range by > `MERIDIAN_OOR_BINS_TO_CLOSE` bins" stays.
  - SL stays (our `STOP_LOSS_PCT`, 2-tick confirmation).
  - The close uses `executeCleanExit` (sells the token side to SOL if any is left); the banked SOL is already in the wallet, so `nextCapital` from the wallet balance is correct afterwards.
- Known consequence (accepted): the cycle can exit at a small loss when the bounce recovers only part of the DCA-in loss and the token is sold out
  (price above range). A deep fall with no bounce hangs until the 25% SL.
- Unresolved defaults (flagged, change on request): low-yield rule and the AI manager keep running in flip phase. Low-yield (fee/TVL 24h < 7% after 60 min open)
  can close a flip before the bounce; set to skip in flip phase if that is unwanted.

## Failure handling

- Close succeeded, redeposit failed: token is in the wallet, `inFlight` was set. Retry the deposit (fresh active bin each attempt, already inside
  `openLadderPosition`). If it still fails, `reconcilePoolStateAfterFailure` sees no position; on the next boot/loop the existing stranded-token path swaps the token to SOL.
  `bankedSol` and the deposit basis are lost with the context, so the swap-back result is simply the new capital (same as every other failed-reopen path).
- Boot recovery: state with `flipPhase` resumes as a token-side position. Boot recovery rebuilt from chain (no state) cannot know it is a flip; it falls
  back to the existing rebuild (assumes SOL ladder). Acceptable, same limitation as `token_spot` today.
- Flip only when the pool is not protected (`assertNotProtected`) and never for the user's manual DARK-SOL pool.

## Testing

- Pure functions with `assert` self-checks (repo style, `src/scripts/check*.ts`): `shouldFlip(tokenSharePct, threshold, phase, strategy)`,
  `flipExitConfig(...)` (flip thresholds), cycle PnL with `bankedSol`.
- `simulateTransaction`-only script against a real pool for the token-only bid-ask deposit (same method used for the token_spot checks): nothing sent.
- Live check on the first real flip is manual (watch logs); not proven live until then. CLAUDE.md updated before the PR.

## Out of scope

Recenter in flip phase (option b, rejected), multiple strategies per pool, scalp strategy, auto-evolution of thresholds.

## New env

`FLIP_ENABLED` (default false until the first supervised live run), `FLIP_TOKEN_SHARE_PCT=80`, `FLIP_TRAILING_TRIGGER_PCT=5`.
