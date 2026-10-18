# Bid-Ask Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In meridian mode, a `sol_ladder` position whose token share reaches 80% is flipped: closed, then the token is redeposited token-only as a bid-ask above the price, with flip-specific exit rules.

**Architecture:** A pure module `src/logic/flip.ts` holds every decision (trigger, PnL basis, exit config, labels) and has a self-check. `rebalanceEngine.ts` gets `executeFlip` (close, wait for token balance, redeposit via the existing `openLadderPosition`). `index.ts` `tick()` calls the trigger, the flip PnL basis and the flip exit config. Two optional fields (`flipPhase`, `bankedSol`) ride on `PoolContext` and persist through the existing state store.

**Tech Stack:** TypeScript (ESM, `tsx` for self-checks), `@meteora-ag/dlmm` 1.9.x, `bn.js`. No test framework: plain `assert` scripts in `src/scripts/check*.ts`.

**Spec:** `docs/superpowers/specs/2026-10-18-bid-ask-flip-design.md`

## Global Constraints

- Answer/user-facing text Indonesian; code and comments English. No markdown tables anywhere.
- Never print secrets. Scripts that import `dist/services/*` need `set -a; . ./.env.live; set +a` (output must never echo env values).
- Work only on branch `feature/trend-aware-entry` (PR #2). Never commit to `main`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `FLIP_ENABLED` defaults to `false`. Do NOT turn it on in `.env.live` and do NOT restart the bot: the user decides both.
- Flip trigger: token share (`otherPrincipalSol / currentValueSol * 100`) >= `FLIP_TOKEN_SHARE_PCT` = 80, confirmed over `MERIDIAN_CONFIRM_TICKS` (2) ticks, only for ladder positions that are not `token_spot` and not already in flip phase.
- Flip phase: SL = existing `STOP_LOSS_PCT` on the ORIGINAL `initialDepositSol` basis; no fixed TP; trailing arms at `FLIP_TRAILING_TRIGGER_PCT` = 5, drop stays `MERIDIAN_TRAILING_DROP_PCT` = 1.5; no OOR-time exit; "price above range by > `MERIDIAN_OOR_BINS_TO_CLOSE`" stays; low-yield rule and AI manager stay on; a flip position never flips again and never recenters (it waits for the bounce).
- PnL basis in flip phase: `value + unclaimed fees + bankedSol` vs `initialDepositSol`. `bankedSol` = SOL principal + SOL fees read from the position right before the flip close; it stays in the wallet.
- AI screener and manager must know the whole lifecycle (what the bot does automatically and why) but stay free: the numbers are defaults, never rules for the AI. The flip text is only added to prompts when `FLIP_ENABLED` is true (never describe behaviour that is off).
- No Jupiter swap in the flip. If the redeposit fails after the close, the token is swapped back to SOL through the existing `swapBackOrPend`.

## Review Focus

- Token share is NaN, negative or the position value is 0 (position not found): must NOT flip. Pinned in Task 1 test.
- Share exactly equal to the threshold flips, just below does not; already in flip phase, `token_spot`, non-ladder and disabled never flip. Pinned in Task 1 test.
- Right after a flip 20% of the value sits in the wallet: PnL must include `bankedSol` or SL fires falsely. Pinned in Task 1 test (`pnlBasisSol`).
- Flip phase must never fire the fixed TP or the OOR timer, but must still fire on "pumped far above", trailing from 5, and low-yield. Pinned in Task 1 test.
- Old state files (no flip fields) and new ones with the fields must both parse. Pinned in Task 1 test (`parseState`).
- Close succeeded but the redeposit throws: token must not stay stranded. Covered by code review in Task 3 and the manual checklist in Task 6 (not unit-testable without a chain).
- A flip position sits in `bid_ask_flip` with profit measured on the whole cycle: the manager must be told so, or it reads the banked-SOL-adjusted loss as a fresh position and closes it on a bounce that has not happened yet. Pinned in Task 5 test (prompt contains the lifecycle only when enabled).

---

### Task 1: Pure flip logic, env, self-check

**Files:**
- Create: `src/logic/flip.ts`
- Create: `src/scripts/checkFlip.ts`
- Modify: `src/config/env.ts` (after the `TOKEN_SPOT_MIN_BINS` line, ~line 530)
- Modify: `src/services/stateStore.ts:34-38` (PersistedPosition optional fields)

**Interfaces:**
- Produces (used by Tasks 2-4):
  - `isTokenSide(c: { tokenSpot?: boolean; flipPhase?: boolean }): boolean`
  - `strategyLabel(c: { tokenSpot?: boolean; flipPhase?: boolean }): 'sol_ladder' | 'token_spot' | 'bid_ask_flip'`
  - `shouldFlip(i: ShouldFlipInput): boolean`
  - `pnlBasisSol(valueSol: number, feesSol: number, bankedSol: number, includeFees: boolean): number`
  - `flipExitConfig(base: MeridianExitConfig, trailingTriggerPct: number): MeridianExitConfig`
  - env: `env.FLIP_ENABLED: boolean`, `env.FLIP_TOKEN_SHARE_PCT: number`, `env.FLIP_TRAILING_TRIGGER_PCT: number`

- [ ] **Step 1: Write the failing self-check**

Create `src/scripts/checkFlip.ts`:

```ts
import assert from 'node:assert/strict';
import { isTokenSide, strategyLabel, shouldFlip, pnlBasisSol, flipExitConfig } from '../logic/flip.js';
import { meridianExitSignal, type MeridianExitConfig, type MeridianExitInput } from '../logic/meridianExit.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';

// labels / geometry side
assert.equal(isTokenSide({}), false);
assert.equal(isTokenSide({ tokenSpot: true }), true);
assert.equal(isTokenSide({ flipPhase: true }), true);
assert.equal(strategyLabel({}), 'sol_ladder');
assert.equal(strategyLabel({ tokenSpot: true }), 'token_spot');
assert.equal(strategyLabel({ flipPhase: true }), 'bid_ask_flip');

// trigger
const on = { enabled: true, thresholdPct: 80, isLadder: true, tokenSpot: false, flipPhase: false };
assert.equal(shouldFlip({ ...on, sharePct: 80 }), true); // boundary flips
assert.equal(shouldFlip({ ...on, sharePct: 79.99 }), false);
assert.equal(shouldFlip({ ...on, sharePct: 100 }), true);
assert.equal(shouldFlip({ ...on, sharePct: NaN }), false);
assert.equal(shouldFlip({ ...on, sharePct: -5 }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, enabled: false }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, isLadder: false }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, tokenSpot: true }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, flipPhase: true }), false);

// PnL basis: banked SOL counts, fees only when asked
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
near(pnlBasisSol(0.8, 0.02, 0.2, true), 1.02);
near(pnlBasisSol(0.8, 0.02, 0.2, false), 1.0);
near(pnlBasisSol(0.8, 0.02, 0, true), 0.82);

// flip exit rules
const base: MeridianExitConfig = { takeProfitPct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeBinsToClose: 10, outOfRangeWaitMinutes: 30, minFeePerTvl24hPct: 7, minAgeBeforeYieldCheckMin: 60 };
const flipCfg = flipExitConfig(base, 5);
assert.equal(flipCfg.trailingDropPct, 1.5);
assert.equal(flipCfg.outOfRangeBinsToClose, 10);
const inp: MeridianExitInput = { pnlPct: 0, peakPnlPct: 0, binsAbove: 0, isOutOfRange: false, minutesOutOfRange: null, feePerTvl24hPct: 20, ageMinutes: 120 };
const sig = (o: Partial<MeridianExitInput>) => meridianExitSignal({ ...inp, ...o }, flipCfg);
assert.equal(sig({ pnlPct: 9, peakPnlPct: 9 }), null); // no fixed TP
assert.equal(sig({ isOutOfRange: true, minutesOutOfRange: 600 }), null); // no OOR timer
assert.equal(sig({ pnlPct: 4, peakPnlPct: 4.9 }), null); // trailing not armed below 5
assert.equal(sig({ pnlPct: 3.6, peakPnlPct: 5 }), null); // armed, dropped only 1.4
assert.match(sig({ pnlPct: 3.4, peakPnlPct: 5.1 })!, /^trailing TP/); // armed, dropped 1.7
assert.match(sig({ binsAbove: 11 })!, /^pumped far above/);
assert.match(sig({ feePerTvl24hPct: 6 })!, /^low yield/);
// normal config is untouched
assert.match(meridianExitSignal({ ...inp, pnlPct: 5 }, base)!, /^take profit/);

// state files with and without the flip fields both parse
const wallet = 'W';
const pos = { poolAddress: 'p', mintX: 'x', mintY: 'y', reserveSolAccount: 'r', initialDepositSol: 1, lastRebalanceAt: 0, volume1hBaselineUsd: 0, volume1hBaselineSetAtMs: 0, binStep: 80, peakProfitPct: 0, otherMintDecimals: 6, xIsSol: false, rebalanceTimestamps: [], centerBinId: -1, outOfRangeSinceMs: null, inRangeSinceMs: null };
const st = (p: object) => JSON.stringify({ version: STATE_VERSION, savedAtMs: 1, wallet, position: p, inFlight: false, currentCapitalSol: 1, lastOtherMint: null, lastSwitchAtMs: null, blacklist: [], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 } });
assert.ok(parseState(st(pos), wallet));
assert.ok(parseState(st({ ...pos, flipPhase: true, bankedSol: 0.2 }), wallet));

console.log('checkFlip ok');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/irsantyomahandriohadi/Documents/DLMMBOT && npx tsx src/scripts/checkFlip.ts`
Expected: FAIL (cannot find module `../logic/flip.js`).

- [ ] **Step 3: Create `src/logic/flip.ts`**

```ts
import type { MeridianExitConfig } from './meridianExit.js';

/**
 * Bid-ask flip (yunus-0x/meridian strategy 1, meridian mode): a SOL-only bid-ask ladder (DCA-in) whose token share reaches
 * FLIP_TOKEN_SHARE_PCT is closed and redeposited token-only as a bid-ask ABOVE the price (DCA-out). Pure decisions only; the
 * on-chain steps live in rebalanceEngine.executeFlip. Kept import-free of the wallet so self-checks can load it.
 */
export interface SideFlags {
  tokenSpot?: boolean;
  flipPhase?: boolean;
}

/** Token-only position above the price: geometry/range status use the token-side bounds (same as token_spot). */
export const isTokenSide = (c: SideFlags): boolean => !!c.tokenSpot || !!c.flipPhase;

export function strategyLabel(c: SideFlags): 'sol_ladder' | 'token_spot' | 'bid_ask_flip' {
  return c.flipPhase ? 'bid_ask_flip' : c.tokenSpot ? 'token_spot' : 'sol_ladder';
}

export interface ShouldFlipInput {
  enabled: boolean;
  /** non-SOL principal / position value * 100 */
  sharePct: number;
  thresholdPct: number;
  isLadder: boolean;
  tokenSpot: boolean;
  flipPhase: boolean;
}

export function shouldFlip(i: ShouldFlipInput): boolean {
  return i.enabled && i.isLadder && !i.tokenSpot && !i.flipPhase && Number.isFinite(i.sharePct) && i.sharePct >= i.thresholdPct;
}

/** SOL value the PnL is measured on: position value (+ unclaimed fees in meridian mode) + the SOL banked at the flip. */
export function pnlBasisSol(valueSol: number, feesSol: number, bankedSol: number, includeFees: boolean): number {
  return valueSol + (includeFees ? feesSol : 0) + bankedSol;
}

/**
 * Exit rules of the flip phase: no fixed TP (the final TP is the "pumped far above range" close), trailing arms at
 * `trailingTriggerPct`, no OOR timer (wait for the bounce; SL is handled by the caller). Everything else is meridian's.
 */
export function flipExitConfig(base: MeridianExitConfig, trailingTriggerPct: number): MeridianExitConfig {
  return { ...base, takeProfitPct: Infinity, trailingTriggerPct, outOfRangeWaitMinutes: Infinity };
}
```

- [ ] **Step 4: Add the env vars**

In `src/config/env.ts`, directly after the line `TOKEN_SPOT_MIN_BINS: num('TOKEN_SPOT_MIN_BINS', 20),` add:

```ts
  // Bid-ask flip (meridian strategy 1): off until the first supervised live run. See docs/superpowers/specs/2026-10-18-bid-ask-flip-design.md.
  FLIP_ENABLED: bool('FLIP_ENABLED', false),
  FLIP_TOKEN_SHARE_PCT: num('FLIP_TOKEN_SHARE_PCT', 80),
  FLIP_TRAILING_TRIGGER_PCT: num('FLIP_TRAILING_TRIGGER_PCT', 5),
```

- [ ] **Step 5: Declare the persisted fields**

In `src/services/stateStore.ts`, in `PersistedPosition`, after `tokenSpotReached?: boolean;` add:

```ts
  /** bid-ask flip (meridian mode): the position was flipped to a token-only bid-ask above the price */
  flipPhase?: boolean;
  /** SOL taken out at the flip, left in the wallet and counted in the cycle PnL */
  bankedSol?: number;
```

- [ ] **Step 6: Run the check and the typecheck**

Run: `npx tsx src/scripts/checkFlip.ts && npx tsc --noEmit`
Expected: `checkFlip ok`, tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/logic/flip.ts src/scripts/checkFlip.ts src/config/env.ts src/services/stateStore.ts
git commit -m "feat(flip): pure flip logic, env flags (off by default) and self-check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Context fields and token-side wiring

**Files:**
- Modify: `src/logic/rebalanceEngine.ts` (PoolContext ~line 72; `getBinRangeStatus` ~line 168; import)
- Modify: `src/index.ts` (lines ~111, ~537, ~570, ~728; import)
- Modify: `src/logic/aiMemory.ts:17`, `src/logic/aiPrompts.ts:50` (widen `strategy` union)

**Interfaces:**
- Consumes: `isTokenSide`, `strategyLabel` from Task 1.
- Produces: `PoolContext.flipPhase?: boolean`, `PoolContext.bankedSol?: number`.

- [ ] **Step 1: Add the fields to `PoolContext`**

In `src/logic/rebalanceEngine.ts`, after the `tokenSpotReached?: boolean;` line add:

```ts
  /** bid-ask flip (meridian mode): the SOL ladder was closed and its token redeposited as a token-only bid-ask above the price */
  flipPhase?: boolean;
  /** SOL taken out at the flip, left in the wallet and counted in the cycle PnL (see logic/flip.ts pnlBasisSol) */
  bankedSol?: number;
```

- [ ] **Step 2: Token-side range status**

In `rebalanceEngine.ts` add near the other imports `import { isTokenSide } from './flip.js';` and change in `getBinRangeStatus`:

```ts
  if (ctx.ladderBins !== undefined && ctx.tokenSpot) {
```
to
```ts
  if (ctx.ladderBins !== undefined && isTokenSide(ctx)) {
```
(Also update the comment on the line below it: "deposited side is the memecoin" holds for flip phase too.)

- [ ] **Step 3: `index.ts` call sites**

Add `import { isTokenSide, strategyLabel } from './logic/flip.js';` with the other logic imports. Then:
- line ~111 `strategy: ctx.tokenSpot ? 'token_spot' : 'sol_ladder',` becomes `strategy: strategyLabel(ctx),`
- line ~728 (the AI manager snapshot) same replacement.
- line ~537 `ladderBounds(ctx.centerBinId, ctx.ladderBins, ctx.tokenSpot ? !ctx.xIsSol : ctx.xIsSol)` becomes `ladderBounds(ctx.centerBinId, ctx.ladderBins, isTokenSide(ctx) ? !ctx.xIsSol : ctx.xIsSol)`
- line ~570 `&& binStatus.tokenBelowRange && !ctx.tokenSpot` becomes `&& binStatus.tokenBelowRange && !isTokenSide(ctx)`

Do NOT touch line ~465 (`tokenSpotReached`) or line ~557 (`oorWaitMinutes(!!ctx.tokenSpot, ...)`): flip phase has no OOR timer (Task 4).

- [ ] **Step 4: Widen the strategy label type**

`src/logic/aiMemory.ts:17` and `src/logic/aiPrompts.ts:50`: change `strategy?: 'sol_ladder' | 'token_spot';` to `strategy?: 'sol_ladder' | 'token_spot' | 'bid_ask_flip';`. Leave `aiDecision.ts` `Strategy` and `index.ts:377` (`aiStrategy`) alone: the AI never picks a flip at entry.

- [ ] **Step 5: Typecheck and existing checks**

Run: `npx tsc --noEmit && npx tsx src/scripts/checkFlip.ts && npx tsx src/scripts/checkTokenSpot.ts && npx tsx src/scripts/checkLadderRange.ts && npx tsx src/scripts/checkMeridianExit.ts`
Expected: tsc exits 0; all print their `ok` lines. If tsc flags another place that exhaustively handles the strategy union, widen it the same way.

- [ ] **Step 6: Commit**

```bash
git add src/logic/rebalanceEngine.ts src/index.ts src/logic/aiMemory.ts src/logic/aiPrompts.ts
git commit -m "feat(flip): flipPhase/bankedSol context fields, token-side geometry and strategy label

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `executeFlip`

**Files:**
- Modify: `src/logic/rebalanceEngine.ts` (add the function right after `openTokenSpotEntry`, before `export { estimateCycleGasCostSol }`)

**Interfaces:**
- Consumes: `openLadderPosition`, `StrategyType`, `closePositionFull`, `getUserPositions`, `waitForTokenBalance`, `swapBackOrPend`, `getTokenBalance`, `env.TOKEN_SPOT_START_OFFSET_BINS` (all already imported/defined in this file, as `openTokenSpotEntry` and `closeAndConvertToSol` use them).
- Produces: `executeFlip(ctx: PoolContext): Promise<PoolContext>`; returns the SAME ctx mutated (`flipPhase`, `bankedSol`, `centerBinId`, timers cleared).

- [ ] **Step 1: Add the function**

```ts
/**
 * Bid-ask flip (meridian strategy 1): close the SOL ladder (claims fees), wait for the token to land in the wallet, then redeposit ALL
 * of it token-only as a bid-ask above the price in ONE tx (no Jupiter swap). The SOL that came out of the close (principal + SOL fees)
 * stays in the wallet as `ctx.bankedSol` and is counted in the cycle PnL. `initialDepositSol` and `peakProfitPct` are untouched.
 * If the redeposit fails after the close, the token is swapped back to SOL and the error rethrown (caller reconciles state).
 */
export async function executeFlip(ctx: PoolContext): Promise<PoolContext> {
  if (ctx.ladderBins === undefined || ctx.tokenSpot || ctx.flipPhase) throw new Error('[rebalanceEngine] executeFlip: not a SOL ladder position');
  const [position] = await getUserPositions(ctx.pool);
  if (!position) throw new Error('[rebalanceEngine] executeFlip: no open position on chain');
  const { feeX, feeY, totalXAmount, totalYAmount } = position.positionData;
  const solRaw = new BN(ctx.xIsSol ? totalXAmount : totalYAmount).add(new BN(ctx.xIsSol ? feeX : feeY));
  const expectedOther = new BN(ctx.xIsSol ? totalYAmount : totalXAmount).add(new BN(ctx.xIsSol ? feeY : feeX));
  if (!expectedOther.gtn(0)) throw new Error('[rebalanceEngine] executeFlip: position holds no token to flip');
  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  logger.warn('[rebalanceEngine] FLIP: closing the SOL ladder to redeposit its token above the price', {
    pool: ctx.poolAddress,
    bankedSol: Number(solRaw.toString()) / LAMPORTS_PER_SOL,
    expectedTokenRaw: expectedOther.toString(),
  });
  await closePositionFull(ctx.pool, position);
  let result;
  try {
    const tokenAmount = await waitForTokenBalance(otherMint, expectedOther.muln(95).divn(100));
    // deposited token is X when the memecoin is X (SOL is Y): the flag of openLadderPosition means "deposited side is X"
    result = await openLadderPosition(ctx.pool, !ctx.xIsSol, tokenAmount, ctx.ladderBins, StrategyType.BidAsk, env.TOKEN_SPOT_START_OFFSET_BINS);
  } catch (err) {
    logger.error('[rebalanceEngine] FLIP redeposit failed after the close — swapping the token back to SOL', {
      pool: ctx.poolAddress,
      otherMint,
      error: err instanceof Error ? err.message : String(err),
    });
    const stuck = await getTokenBalance(otherMint);
    if (stuck.gtn(0)) await swapBackOrPend(otherMint, stuck, 'flip redeposit rollback');
    throw err;
  }
  ctx.centerBinId = result.centerBinId;
  ctx.flipPhase = true;
  ctx.bankedSol = Number(solRaw.toString()) / LAMPORTS_PER_SOL;
  ctx.outOfRangeSinceMs = null;
  ctx.inRangeSinceMs = null;
  logger.warn('[rebalanceEngine] FLIP complete: token-only bid-ask is live above the price', { pool: ctx.poolAddress, centerBinId: result.centerBinId, bankedSol: ctx.bankedSol });
  return ctx;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0. (If `swapBackOrPend` or `waitForTokenBalance` are not in scope in that part of the file, they are used by `openTokenSpotEntry` directly above, so they are; no new imports should be needed.)

- [ ] **Step 3: Review the failure path by reading**

Confirm by reading the function: (a) every throw after `closePositionFull` goes through the `catch` that swaps back; (b) `waitForTokenBalance` is inside the `try`. Review Focus item 6 depends on this.

- [ ] **Step 4: Commit**

```bash
git add src/logic/rebalanceEngine.ts
git commit -m "feat(flip): executeFlip closes the ladder and redeposits the token as a token-only bid-ask

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the trigger, PnL basis and exit rules into `tick()`

**Files:**
- Modify: `src/index.ts` (imports; `flipConfirmer` next to `meridianConfirmer` ~line 53; PnL basis ~line 477; meridian exit block ~lines 541-561; flip trigger before `if (decision === 'HARD_EXIT')`)

**Interfaces:**
- Consumes: `shouldFlip`, `pnlBasisSol`, `flipExitConfig`, `isTokenSide` (Task 1); `executeFlip` (Task 3); `ExitConfirmer`, `guarded`, `reconcilePoolStateAfterFailure` (existing).

- [ ] **Step 1: Imports and confirmer**

Extend the flip import to `import { isTokenSide, strategyLabel, shouldFlip, pnlBasisSol, flipExitConfig } from './logic/flip.js';`, add `executeFlip` to the existing `rebalanceEngine.js` import list (where `openTokenSpotEntry` is imported), and after `const meridianConfirmer = new ExitConfirmer();` add:

```ts
const flipConfirmer = new ExitConfirmer();
```

- [ ] **Step 2: PnL basis includes the banked SOL**

Replace
```ts
  const pnlValueSol = meridianRules ? currentValueSol + unclaimedFeesSol : currentValueSol;
```
with
```ts
  // flip phase: the SOL banked at the flip sits in the wallet; the cycle PnL (SL, trailing, peak) must count it
  const pnlValueSol = pnlBasisSol(currentValueSol, unclaimedFeesSol, ctx.bankedSol ?? 0, meridianRules);
```
and in the `lastSnap = { valueSol: currentValueSol, ...` line change `valueSol: currentValueSol` to `valueSol: currentValueSol + (ctx.bankedSol ?? 0)`.

- [ ] **Step 3: Flip-phase exit config**

Replace the whole `const signal = ... meridianExitSignal(...)` statement (from `const slReason = ...` through the closing `);` of `meridianExitSignal`, currently ~lines 541-561) with:

```ts
    const slReason = slHit ? evald.reasons.find((r) => r.includes('STOP_LOSS_PCT')) : undefined;
    const exitCfg = {
      takeProfitPct: env.MERIDIAN_TAKE_PROFIT_PCT,
      trailingTriggerPct: env.MERIDIAN_TRAILING_TRIGGER_PCT,
      trailingDropPct: env.MERIDIAN_TRAILING_DROP_PCT,
      outOfRangeBinsToClose: env.MERIDIAN_OOR_BINS_TO_CLOSE,
      outOfRangeWaitMinutes: oorWaitMinutes(!!ctx.tokenSpot, !!ctx.tokenSpotReached, { standard: env.MERIDIAN_OOR_WAIT_MIN, spotFirst: env.MERIDIAN_TOKEN_SPOT_OOR_WAIT_MIN, spotAfterReach: env.MERIDIAN_TOKEN_SPOT_OOR_AFTER_REACH_MIN }),
      minFeePerTvl24hPct: env.MERIDIAN_MIN_FEE_TVL_24H_PCT,
      minAgeBeforeYieldCheckMin: env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN,
    };
    const signal = slReason !== undefined ? `stop loss: ${slReason}` : meridianExitSignal(
      {
        pnlPct: currentProfitPct,
        peakPnlPct: ctx.peakProfitPct,
        binsAbove,
        isOutOfRange: binStatus.isOutOfRange,
        minutesOutOfRange: ctx.outOfRangeSinceMs !== null ? (now - ctx.outOfRangeSinceMs) / 60_000 : null,
        feePerTvl24hPct: ageMinutes !== null && ageMinutes >= env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN ? await getPoolFeeTvl24hPct(ctx.poolAddress) : null,
        ageMinutes,
      },
      ctx.flipPhase ? flipExitConfig(exitCfg, env.FLIP_TRAILING_TRIGGER_PCT) : exitCfg,
    );
```
(Keep the `const ageMinutes = ...` line that precedes it unchanged.)

- [ ] **Step 4: Flip trigger**

Replace the exact text
```ts
      return;
    }
  }

  if (decision === 'HARD_EXIT') {
```
with
```ts
      return;
    }

    // Bid-ask flip: the SOL ladder has turned into the token. Only when no exit signal is pending (exits win), confirmed over N ticks.
    if (!signal && env.FLIP_ENABLED) {
      const sharePct = currentValueSol > 0 ? (otherPrincipalSol / currentValueSol) * 100 : 0;
      const want = shouldFlip({
        enabled: true,
        sharePct,
        thresholdPct: env.FLIP_TOKEN_SHARE_PCT,
        isLadder: ctx.ladderBins !== undefined,
        tokenSpot: !!ctx.tokenSpot,
        flipPhase: !!ctx.flipPhase,
      });
      if (flipConfirmer.hit(want ? 'flip' : null, env.MERIDIAN_CONFIRM_TICKS)) {
        logger.warn('[index] flip confirmed — closing the ladder and redepositing the token above the price', { pool: ctx.poolAddress, tokenSharePct: +sharePct.toFixed(1) });
        try {
          currentPool = await guarded(() => executeFlip(ctx));
        } catch (err) {
          logger.error('[index] executeFlip threw, reconciling state', { pool: ctx.poolAddress, error: err instanceof Error ? err.message : String(err) });
          currentPool = await reconcilePoolStateAfterFailure(ctx);
        }
        return;
      }
    } else {
      flipConfirmer.hit(null, env.MERIDIAN_CONFIRM_TICKS);
    }
  }

  if (decision === 'HARD_EXIT') {
```

- [ ] **Step 5: Typecheck, all checks, build**

Run:
```bash
npx tsc --noEmit && for f in src/scripts/check*.ts; do npx tsx "$f" > /dev/null 2>&1 || echo "FAIL $f"; done; npm run build
```
Expected: tsc exits 0, no `FAIL` lines (any pre-existing failure must be shown to the user, not hidden), build exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(flip): tick() triggers the flip at 80% token share and applies flip-phase PnL basis and exit rules

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: AI screener and manager know the strategy

**Files:**
- Modify: `src/logic/flip.ts` (add `FlipPromptInfo` + `flipPromptInfo`)
- Modify: `src/logic/aiPrompts.ts` (strategy text, new optional `flip` params, snapshot field)
- Modify: `src/services/aiReact.ts:204` and `:263`, `src/services/aiAgent.ts:77` and `:105` (pass `flipPromptInfo(env)`)
- Modify: `src/index.ts` AI manager snapshot (~line 728): add `bankedSol`
- Modify: `src/scripts/checkFlip.ts` (append prompt assertions)

**Interfaces:**
- Consumes: `env.FLIP_ENABLED`, `env.FLIP_TOKEN_SHARE_PCT`, `env.FLIP_TRAILING_TRIGGER_PCT`, `env.MERIDIAN_TRAILING_DROP_PCT`, `env.STOP_LOSS_PCT`.
- Produces: `FlipPromptInfo = { tokenSharePct: number; trailingTriggerPct: number; trailingDropPct: number; stopLossPct: number }`; `flipPromptInfo(e): FlipPromptInfo | null` (null when disabled); optional trailing `flip: FlipPromptInfo | null = null` parameter on `buildScreenerPrompt`, `buildReactScreenerPrompt`, `buildManagerPrompt`, `buildReactManagerPrompt`; `AiPositionSnapshot.bankedSol?: number`.

- [ ] **Step 1: Append failing assertions to `src/scripts/checkFlip.ts`** (before the final `console.log`)

```ts
import { flipPromptInfo } from '../logic/flip.js';
import { buildReactScreenerPrompt, buildReactManagerPrompt } from '../logic/aiPrompts.js';
const envOn = { FLIP_ENABLED: true, FLIP_TOKEN_SHARE_PCT: 80, FLIP_TRAILING_TRIGGER_PCT: 5, MERIDIAN_TRAILING_DROP_PCT: 1.5, STOP_LOSS_PCT: 25 };
assert.equal(flipPromptInfo({ ...envOn, FLIP_ENABLED: false }), null);
const info = flipPromptInfo(envOn)!;
assert.equal(info.tokenSharePct, 80);
const rules = { stopLossPct: 25, ladderOorExitMin: 30, idleOutOfRangeMin: 60, volumeDropExitPct: 60 };
const scrOn = buildReactScreenerPrompt(0.3, '', [], info);
const scrOff = buildReactScreenerPrompt(0.3, '', [], null);
assert.match(scrOn, /BID-ASK FLIP/);
assert.match(scrOn, /80%/);
assert.doesNotMatch(scrOff, /BID-ASK FLIP/);
const manOn = buildReactManagerPrompt(rules, '', [], info);
assert.match(manOn, /bid_ask_flip/);
assert.match(manOn, /not rules|defaults/i); // numbers are defaults, the AI stays free
assert.doesNotMatch(buildReactManagerPrompt(rules, '', [], null), /bid_ask_flip/);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/scripts/checkFlip.ts`
Expected: FAIL (`flipPromptInfo` is not exported).

- [ ] **Step 3: Add the info type to `src/logic/flip.ts`**

```ts
/** What the AI prompts need to describe the flip; null when the flip is off (never describe behaviour that is disabled). */
export interface FlipPromptInfo {
  tokenSharePct: number;
  trailingTriggerPct: number;
  trailingDropPct: number;
  stopLossPct: number;
}

export function flipPromptInfo(e: { FLIP_ENABLED: boolean; FLIP_TOKEN_SHARE_PCT: number; FLIP_TRAILING_TRIGGER_PCT: number; MERIDIAN_TRAILING_DROP_PCT: number; STOP_LOSS_PCT: number }): FlipPromptInfo | null {
  if (!e.FLIP_ENABLED) return null;
  return { tokenSharePct: e.FLIP_TOKEN_SHARE_PCT, trailingTriggerPct: e.FLIP_TRAILING_TRIGGER_PCT, trailingDropPct: e.MERIDIAN_TRAILING_DROP_PCT, stopLossPct: e.STOP_LOSS_PCT };
}
```

- [ ] **Step 4: Prompt text in `src/logic/aiPrompts.ts`**

Add `import type { FlipPromptInfo } from './flip.js';` at the top and `bankedSol?: number;` to `AiPositionSnapshot` (comment: `/** SOL taken out at the flip, held in the wallet and counted in profitPct; absent before a flip */`). Add these two functions above `screenerCore`:

```ts
function flipScreenerText(f: FlipPromptInfo | null): string {
  if (!f) return '';
  return `BID-ASK FLIP (our strategy; it is what happens to EVERY sol_ladder you deploy after entry — the bot runs it, you only choose the entry):
1. DCA-in: the SOL-only bid-ask sits below the price. As price falls through the bins the SOL turns into the token and earns fees on the way.
2. Flip: when about ${f.tokenSharePct}% of the position value is the token, the bot withdraws it and redeposits the token ALONE as a bid-ask ABOVE the price (DCA-out). The SOL taken out stays in the wallet and counts in the PnL.
3. DCA-out: it then WAITS for a bounce (no out-of-range timer, no recenter). Floor: stop loss ${f.stopLossPct}% of the original deposit. Take profit: a trailing stop that arms at +${f.trailingTriggerPct}% PnL and closes ${f.trailingDropPct} points under the peak; the position also closes when price runs far above the range (the token has sold back into SOL).
What this means for your pick: a sol_ladder entry is a plan to buy the dip AND hold the token until it bounces. A token with real volume and holders that can bounce fits; a token whose volume and buyers are disappearing (dump, rug, dead narrative) never bounces and the loss runs to the stop loss. The numbers above are the bot's defaults, not rules for you: judge with all the data, and skip when the bounce case is weak.`;
}

function flipManagerText(f: FlipPromptInfo | null): string {
  if (!f) return '';
  return `STRATEGY CONTEXT (bid-ask flip, ours). The position is in one of these phases (snapshot field "strategy"):
- sol_ladder: DCA-in. SOL-only bid-ask below the price; the SOL turns into the token as price falls. The bot flips it automatically at about ${f.tokenSharePct}% token share.
- bid_ask_flip: DCA-out. The token was redeposited alone as a bid-ask above the price and the bot WAITS for a bounce on purpose: being out of range below the position is expected, not a problem by itself. profitPct is the WHOLE cycle versus the original deposit and already includes bankedSol (SOL taken out at the flip, held in the wallet); valueSol is only what is still in the pool. Automatic exits: stop loss ${f.stopLossPct}%, a trailing stop that arms at +${f.trailingTriggerPct}% and closes ${f.trailingDropPct} points under the peak, and a close when price runs far above the range (the final take profit).
- token_spot: a token-only spot bounce trade, unrelated to the flip.
These numbers are defaults, not rules for you. Close earlier when the data says the bounce is not coming (volume dead, sustained dump, rug or holder signals), hold longer when it still looks alive. Closing a flip position early realises the cycle loss, so give a concrete reason.`;
}
```

Wire them in (keep everything else as is):
- `screenerCore(capitalSol, memory, recentDecisions, flip)`: add `flipScreenerText(flip),` to the joined array right after the `STRATEGY — choose ONE ...` template string block (before `TIMEFRAME_SCALING`).
- `managerCore(memory, recentDecisions, flip)`: add `flipManagerText(flip),` right after the `BEHAVIORAL CORE` template string.
- `buildScreenerPrompt(candidates, capitalSol, recentDecisions, memory = '', flip: FlipPromptInfo | null = null)` passes `flip` to `screenerCore`; `buildReactScreenerPrompt(capitalSol, memory, recentDecisions, flip: FlipPromptInfo | null = null)` likewise.
- `buildManagerPrompt(p, _rules, recentDecisions, memory = '', flip: FlipPromptInfo | null = null)` and `buildReactManagerPrompt(_rules, memory, recentDecisions, flip: FlipPromptInfo | null = null)` pass `flip` to `managerCore`.
- Also change the ReAct manager instruction line to mention it: no change needed.

- [ ] **Step 5: Pass the info at the four call sites**

In each of `src/services/aiReact.ts` and `src/services/aiAgent.ts`: `import { flipPromptInfo } from '../logic/flip.js';` (and `env` if that file does not import it yet), then:
- `aiAgent.ts:77`: `buildScreenerPrompt(candidates, capitalSol, recentLines('screen', 5), memoryBlock(loadOutcomes()), flipPromptInfo(env))`
- `aiAgent.ts:105`: `buildManagerPrompt(snapshot, rules, recentLines('manage', 5), memoryBlock(loadOutcomes(), 5), flipPromptInfo(env))`
- `aiReact.ts:204`: `buildReactScreenerPrompt(capitalSol, memoryBlock(loadOutcomes()), recentDecisions, flipPromptInfo(env))`
- `aiReact.ts:263`: `buildReactManagerPrompt(rules, memoryBlock(loadOutcomes(), 5), recentDecisions, flipPromptInfo(env))`

In `src/index.ts` AI manager snapshot object (the one with `strategy: strategyLabel(ctx),`) add `bankedSol: ctx.bankedSol,` right after `strategy`.

- [ ] **Step 6: Run checks**

Run: `npx tsx src/scripts/checkFlip.ts && npx tsx src/scripts/checkAiReact.ts && npx tsx src/scripts/checkAiDecision.ts && npx tsx src/scripts/checkAiTriggers.ts && npx tsc --noEmit`
Expected: `checkFlip ok` and the other checks print their ok lines, tsc exits 0. (The AI cannot be made to "understand" in a unit test; this pins that the lifecycle text is present when the flip is on, absent when off. A real read happens on the first live screen/manage call: check `logs/ai-decisions.jsonl` for reasons that mention the flip phases.)

- [ ] **Step 7: Commit**

```bash
git add src/logic/flip.ts src/logic/aiPrompts.ts src/services/aiReact.ts src/services/aiAgent.ts src/index.ts src/scripts/checkFlip.ts
git commit -m "feat(flip): AI screener and manager prompts describe the flip lifecycle (only when enabled)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Chain-shape check, docs, push (flip stays OFF)

**Files:**
- Create: `scratchpad/flipbuild.mjs` (scratchpad dir of this session, NOT committed)
- Modify: `CLAUDE.md` (append a bullet to the 2026-10-16/17 sections; required before any PR update)

- [ ] **Step 1: Check the token-only bid-ask deposit builds as ONE tx (nothing is sent)**

Create `$SCRATCH/flipbuild.mjs` (`SCRATCH=/private/tmp/claude-501/-Users-irsantyomahandriohadi-Documents-DLMMBOT/4442cb96-acb8-41d4-b777-e2f0cefbcf7f/scratchpad`):

```js
import BN from 'bn.js';
import { openPool, buildLadderTx, StrategyType } from '/Users/irsantyomahandriohadi/Documents/DLMMBOT/dist/services/meteoraDLMM.js';
const pool = await openPool('7dCLVSgExKHWZLWcuLbyYNKHxmZbtpqiYbgynv5HpdFk'); // FTR: token X, SOL Y -> xIsSol=false
const r = await buildLadderTx(pool, true /* deposited token is X */, new BN(1_000_000), 60, undefined, StrategyType.BidAsk, 1);
console.log('active', r.activeBinId, 'min', r.minBinId, 'max', r.maxBinId, 'ixs', r.tx.instructions.length);
process.exit(0);
```

Run: `cd /Users/irsantyomahandriohadi/Documents/DLMMBOT && set -a; . ./.env.live; set +a; node "$SCRATCH/flipbuild.mjs"`
Expected: one line; `min` = `active + 1`, `max` = `active + 60`, no thrown error (`ladder deposit needs N txs` would mean the BidAsk token-only shape does not fit one tx; stop and report to the user). Do not print env values.

- [ ] **Step 2: Append to `CLAUDE.md`**

Add this bullet at the end of the "2026-10-16 session" section group (after the `/aireport token share` bullet):

```markdown
- **Bid-ask flip** (2026-10-18, spec `docs/superpowers/specs/2026-10-18-bid-ask-flip-design.md`, plan `docs/superpowers/plans/2026-10-18-bid-ask-flip.md`; `FLIP_ENABLED=false` by default, NOT enabled in `.env.live`, NOT proven live): meridian strategy 1. A `sol_ladder` whose token share (`otherPrincipalSol / currentValueSol`) reaches `FLIP_TOKEN_SHARE_PCT` (80, 2-tick confirm, only when no exit signal is pending) is closed (`executeFlip`, `rebalanceEngine.ts`) and its token redeposited token-only as a bid-ask above the price (`openLadderPosition(..., StrategyType.BidAsk, TOKEN_SPOT_START_OFFSET_BINS)`, no Jupiter swap). SOL that came out of the close stays in the wallet as `ctx.bankedSol` and is added to the cycle PnL (`pnlBasisSol`), basis stays `initialDepositSol`, peak not reset. Flip phase exits (`logic/flip.ts`): SL 25% unchanged, no fixed TP, trailing arms at `FLIP_TRAILING_TRIGGER_PCT` (5) with the usual 1.5 drop, no OOR timer (wait for the bounce), "pumped far above range" close stays (that is the final TP), low-yield and the AI manager stay on. Flip positions never flip again and never recenter. A cycle can exit at a small loss when the bounce recovers only part of the DCA-in loss. Redeposit failure after the close swaps the token back to SOL (`swapBackOrPend`). Boot recovery rebuilt from chain (no state) cannot know a flip (same limitation as token_spot). Telegram `/status` reads Meteora and does not include `bankedSol`. AI prompts (`aiPrompts.ts`, `flipPromptInfo`) describe the lifecycle to the screener and manager only while `FLIP_ENABLED` is true; numbers are given as defaults, the AI stays free; snapshot `strategy` can be `bid_ask_flip` and carries `bankedSol`. The manager trigger "holding token at a loss" will keep firing in flip phase (cooldown 10 min limits the cost). Self-check `checkFlip.ts`. Enable only with the user's go (set `FLIP_ENABLED=true` via a non-printing script, then restart when flat or when the user says so).
```

- [ ] **Step 3: Final verification and commit, push**

Run: `npx tsc --noEmit && npx tsx src/scripts/checkFlip.ts && git status --short`
Expected: tsc exits 0, `checkFlip ok`, only `CLAUDE.md` modified (plus the untracked moonbot scripts that were already untracked).

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md note for the bid-ask flip

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 4: Manual live checklist (for the user, bot is NOT restarted by this plan)**

1. User decides to enable: `FLIP_ENABLED=true` in `.env.live` (non-printing edit), restart.
2. Watch the log for `[index] flip confirmed`, `FLIP: closing`, `FLIP complete`, then `meridian rule signal` lines. A `FLIP redeposit failed` line means the token was swapped back to SOL (check `pendingSwapBack` in the state file if the swap also failed).
3. First flip only: compare wallet SOL before/after to confirm `bankedSol` equals the SOL that came out.
