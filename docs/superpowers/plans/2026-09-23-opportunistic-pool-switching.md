# Opportunistic Pool-Switching + Trailing Take-Profit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While holding a DLMM position, periodically compare it against the best available market opportunity and switch if the alternative is clearly better (≥1.5x volume-spike margin), gated by a profit-guard and cooldown; independently, protect large unrealized gains with a trailing take-profit exit that doesn't blacklist the pool.

**Architecture:** New pure-decision functions in `riskManager.ts` (TAKE_PROFIT trailing-stop check, SWITCH opportunity evaluator) fed by a new scanner function in `meteoraScanner.ts` (`scanForBetterOpportunity`, itself dependent on fixing `hydrateTrendData` to use DexScreener's batch endpoint instead of one-call-per-pool). Execution primitives land in `rebalanceEngine.ts` (a shared `executeCleanExit`, no-blacklist close+convert). Both the real bot (`index.ts`) and the paper-trade simulator (`paperTrade.ts`) wire the same decisions and the same 5-minute opportunity-scan cadence independently, since paper-trade never imports wallet-touching code.

**Tech Stack:** TypeScript (Node/tsx), axios, no test framework (project has none — verification is `tsx`-run assert scripts + paper-trade smoke runs, matching the established pattern in this codebase).

**Spec:** `docs/superpowers/specs/2026-09-23-opportunistic-pool-switching-design.md`

## Global Constraints

- Never commit to `main`/`master`. All work stays on `feature/trend-aware-entry` (current branch) — create commits there, do not open a PR as part of this plan (that happens after implementation, per project's CLAUDE.md workflow).
- `MAX_CONCURRENT_POOLS` stays 1 — a switch is a full exit-then-enter, never two simultaneous positions.
- No new test framework. Verification follows the pattern already used throughout this session: a disposable `tsx`-run script with `console.assert`, deleted after use; no committed test files (project genuinely has zero test infra, adding one is out of scope).
- Every new config value gets an env var with the exact default from the spec (`SWITCH_SPIKE_RATIO_MARGIN=1.5`, `SWITCH_PROFIT_GUARD_PCT=30`, `SWITCH_COOLDOWN_MS=15*60_000`, `OPPORTUNITY_SCAN_INTERVAL_MS=5*60_000`, `TAKE_PROFIT_ARM_PCT=30`, `TAKE_PROFIT_GIVEBACK_PCT=25`), following the existing `num()`/`bool()` helper pattern in `src/config/env.ts`.
- No blacklisting on SWITCH or TAKE_PROFIT exits — only `HARD_EXIT` blacklists, unchanged.

---

## Task 1: Batch DexScreener hydration (fixes the 429 root cause)

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/services/meteoraScanner.ts:219-272` (the `DexScreenerPair` interface and `hydrateTrendData`)

**Interfaces:**
- Produces: `hydrateTrendData(pairs: MeteoraPair[]): Promise<void>` — same signature as before, callers (`filterAndRankPools`) need no changes. `export function volumeSpikeRatio(p: MeteoraPair): number` — now exported (was private), used by Task 2.

Current `hydrateTrendData` makes one `axios.get` per pool at concurrency 5 — confirmed via research this week as the actual cause of 429 storms (DexScreener's documented limit is 300 req/min for token endpoints, but its `/tokens/v1/{chainId}/{tokenAddresses}` batch endpoint accepts up to 30 comma-separated addresses per call, billed as ONE request). Verified live this session: the batch endpoint returns a flat JSON array of pair objects (not wrapped in `{pairs: [...]}` like the old endpoint), and a single token address can match multiple pair entries (e.g. the same token traded on Raydium AND Meteora) — same ambiguity the old code already had (it took `pairs?.[0]`, the first match). The batch rewrite preserves that "take the first match for this mint" behavior, just batched.

- [ ] **Step 1: Add batch-endpoint constants**

In `src/config/constants.ts`, after the existing `DEXSCREENER_TOKEN_URL` line:

```typescript
export const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
// Batch endpoint: up to 30 comma-separated token addresses per call, billed
// as ONE request against DexScreener's 300/min limit — the fix for this
// week's 429 storms, which were caused by one-call-per-pool concurrency,
// not by polling too often. https://docs.dexscreener.com/api/reference
export const DEXSCREENER_TOKENS_BATCH_URL = 'https://api.dexscreener.com/tokens/v1';
export const DEXSCREENER_BATCH_MAX_ADDRESSES = 30;
export const SOLANA_CHAIN_ID = 'solana';
```

- [ ] **Step 2: Rewrite the DexScreener response type for the batch shape**

In `src/services/meteoraScanner.ts`, replace the `DexScreenerPair` interface (currently lines 219-223):

```typescript
interface DexScreenerPair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
}
```

(Added `baseToken`/`quoteToken` — needed to match each batch-response entry back to the mint address that requested it, since the batch endpoint returns one flat array covering every requested address at once, not keyed per-address like the old per-pool call was implicitly.)

- [ ] **Step 3: Replace `hydrateTrendData` with the batched version**

Replace the whole function (currently lines 250-272) with:

```typescript
/**
 * Applies one hydrated DexScreener pair's fields onto our MeteoraPair —
 * shared by the batch hydration below so the field-mapping logic exists
 * in exactly one place.
 */
function applyDexScreenerFields(pair: MeteoraPair, dexPair: DexScreenerPair): void {
  const priceChange = dexPair.priceChange;
  if (typeof priceChange?.h1 === 'number') pair.priceChange1hPct = priceChange.h1;
  if (typeof priceChange?.h6 === 'number') pair.priceChange6hPct = priceChange.h6;
  if (typeof priceChange?.h24 === 'number') pair.priceChange24hPct = priceChange.h24;
  if (typeof dexPair.volume?.m5 === 'number') pair.volumeM5Usd = dexPair.volume.m5;
  if (typeof dexPair.volume?.h6 === 'number') pair.volumeH6Usd = dexPair.volume.h6;
  const m5Txns = dexPair.txns?.m5;
  if (typeof m5Txns?.buys === 'number' && typeof m5Txns?.sells === 'number') pair.txCountM5 = m5Txns.buys + m5Txns.sells;
}

/**
 * Hydrates price-change fields (1h/6h/24h), volume (m5/h6), and 5-minute
 * tx count from DexScreener for a candidate list, via the batched
 * `/tokens/v1/{chainId}/{tokenAddresses}` endpoint (<=30 addresses/call,
 * billed as ONE request each — see DEXSCREENER_TOKENS_BATCH_URL comment).
 * Sequential batches, no concurrency wrapper needed (concurrency was only
 * ever there to avoid slamming the one-call-per-pool endpoint; the batch
 * endpoint removes the reason for it). Best-effort: a failed batch just
 * leaves that batch's pools' DexScreener fields undefined, which every
 * downstream filter already treats as "unknown, don't block".
 */
async function hydrateTrendData(pairs: MeteoraPair[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += DEXSCREENER_BATCH_MAX_ADDRESSES) {
    const batch = pairs.slice(i, i + DEXSCREENER_BATCH_MAX_ADDRESSES);
    const addresses = batch.map((p) => p.mint_x).join(',');
    try {
      const res = await withRetry(
        () => axios.get<DexScreenerPair[]>(`${DEXSCREENER_TOKENS_BATCH_URL}/${SOLANA_CHAIN_ID}/${addresses}`, { timeout: 10_000 }),
        { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:tokens-batch' },
      );
      const byMint = new Map<string, DexScreenerPair>();
      for (const dexPair of res.data) {
        const base = dexPair.baseToken?.address;
        const quote = dexPair.quoteToken?.address;
        // First match wins per mint — same "take pairs[0]" behavior the old
        // per-pool call already had when a mint has multiple DEX pairs.
        if (base && !byMint.has(base)) byMint.set(base, dexPair);
        if (quote && !byMint.has(quote)) byMint.set(quote, dexPair);
      }
      for (const pair of batch) {
        const dexPair = byMint.get(pair.mint_x);
        if (dexPair) applyDexScreenerFields(pair, dexPair);
      }
    } catch (err) {
      logger.debug('[scanner] dexscreener batch hydration failed', {
        addresses,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 4: Remove the now-unused concurrency import/constant**

`mapWithConcurrency` is still used by `hydrateMintAuthority` (RPC calls, unaffected by this task) — keep that import. Remove only the now-dead `DEXSCREENER_CONCURRENCY` constant (line 21) since nothing calls `mapWithConcurrency` with it anymore:

```typescript
const RPC_HYDRATION_CONCURRENCY = 4;
```

(Delete the `const DEXSCREENER_CONCURRENCY = 5;` line above it and update the comment above both — the comment currently says "flat concurrency caps... keep public/free-tier APIs from 429-storming" for both constants; adjust to reference only RPC hydration.)

- [ ] **Step 5: Export `volumeSpikeRatio`**

Change (currently line 39):
```typescript
function volumeSpikeRatio(p: MeteoraPair): number {
```
to:
```typescript
export function volumeSpikeRatio(p: MeteoraPair): number {
```

- [ ] **Step 6: Update the import block for the new constants**

In `src/services/meteoraScanner.ts`, the import from `../config/constants.js` (lines 3-13) needs `DEXSCREENER_TOKENS_BATCH_URL`, `DEXSCREENER_BATCH_MAX_ADDRESSES`, `SOLANA_CHAIN_ID` added alongside the existing `DEXSCREENER_TOKEN_URL` (which stays — `getVolume1hUsd`, untouched by this task, still uses the old single-token endpoint since it's a single ad-hoc lookup, not worth batching).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Verify batched hydration against the real API**

Write a disposable script, run it, then delete it (matches this session's established verification pattern — no committed test file):

```typescript
// check_batch_hydration_tmp.ts
import { fetchTopPools, filterAndRankPools, defaultScannerConfig } from './src/services/meteoraScanner.js';

async function main() {
  const pairs = await fetchTopPools();
  const blacklist = new Map();
  const config = defaultScannerConfig(blacklist);
  const shortlist = await filterAndRankPools(pairs.slice(0, 40), config);
  console.assert(Array.isArray(shortlist), 'filterAndRankPools should still return an array');
  // Spot-check that at least one hydrated field landed on SOME pool in the
  // pre-filtered set (can't assert a specific pool since market data changes).
  const anyHydrated = pairs.slice(0, 40).some((p) => p.priceChange6hPct !== undefined || p.volumeH6Usd !== undefined);
  console.assert(anyHydrated, 'expected at least one pool to have hydrated DexScreener fields after batch call');
  console.log('PASS: batch hydration produced hydrated fields, shortlist length =', shortlist.length);
}
main();
```

Run: `npx tsx check_batch_hydration_tmp.ts`
Expected: `PASS: ...` printed, no `429` errors in output (a couple of `429 Too Many Requests / Retrying...` lines from unrelated Meteora API calls are fine — the DexScreener-specific batch call is what matters here).

Then: `rm check_batch_hydration_tmp.ts`

- [ ] **Step 9: Commit**

```bash
git add src/config/constants.ts src/services/meteoraScanner.ts
git commit -m "$(cat <<'EOF'
fix: batch DexScreener hydration to fix 429 rate-limit storms

hydrateTrendData made one HTTP call per pool at concurrency 5 -
confirmed via research as the actual cause of this week's 429s, not
polling frequency. DexScreener's /tokens/v1/{chainId}/{tokenAddresses}
accepts up to 30 addresses per call, billed as one request. Also
exports volumeSpikeRatio for reuse by the upcoming opportunity-scan
feature.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `scanForBetterOpportunity` scanner function

**Files:**
- Modify: `src/services/meteoraScanner.ts` (add new exported function, after `filterAndRankPools`)

**Interfaces:**
- Consumes: `fetchTopPools()`, `filterAndRankPools()`, `volumeSpikeRatio()`, `hydrateTrendData()` (all from Task 1, same file — `hydrateTrendData` needs to change from private to used-within-file only, already is).
- Produces: `export interface OpportunityScanResult { candidate: MeteoraPair | null; candidateSpikeRatio: number; currentSpikeRatio: number }` and `export async function scanForBetterOpportunity(currentPoolAddress: string, config: ScannerConfig): Promise<OpportunityScanResult>` — consumed by Task 4 (riskManager's `evaluateSwitchOpportunity`) and Tasks 7/9 (index.ts/paperTrade.ts wiring).

- [ ] **Step 1: Add the function**

In `src/services/meteoraScanner.ts`, after the closing brace of `filterAndRankPools` (currently ends at line 410, right before the `PoolEligibility` interface), insert:

```typescript
export interface OpportunityScanResult {
  /** Top-ranked market candidate, if it's a genuinely different pool from the one currently held and one exists. Null if no candidate qualifies or the top candidate IS the currently-held pool. */
  candidate: MeteoraPair | null;
  candidateSpikeRatio: number;
  currentSpikeRatio: number;
}

/**
 * Full-market scan used by the opportunistic pool-switching feature: finds
 * the best currently-available candidate and compares its volume-spike
 * ratio against the currently-held pool's own live spike ratio, hydrated
 * in the same pass for apples-to-apples freshness. Not subject to
 * MIN_SCAN_INTERVAL_MS (that throttle guards the hot per-tick health-check
 * path; this runs on its own much slower OPPORTUNITY_SCAN_INTERVAL_MS
 * cadence, enforced by the caller in index.ts/paperTrade.ts, not here).
 */
export async function scanForBetterOpportunity(currentPoolAddress: string, config: ScannerConfig): Promise<OpportunityScanResult> {
  const pairs = await fetchTopPools();
  const currentPool = pairs.find((p) => p.address === currentPoolAddress) ?? null;
  const shortlist = await filterAndRankPools(pairs, config);
  const topCandidate = shortlist[0] ?? null;

  // filterAndRankPools already hydrated every pool in `shortlist` in place
  // (same object references as in `pairs`). The currently-held pool might
  // not be in that shortlist (e.g. it's not top-3-by-trend right now, or
  // it's temporarily blacklisted) — hydrate it separately if so, still just
  // one extra batched HTTP call, not one-per-pool.
  if (currentPool && currentPool.volumeH6Usd === undefined) {
    await hydrateTrendData([currentPool]);
  }

  const currentSpikeRatio = currentPool ? volumeSpikeRatio(currentPool) : 0;
  const candidateSpikeRatio = topCandidate ? volumeSpikeRatio(topCandidate) : 0;

  if (!topCandidate || topCandidate.address === currentPoolAddress) {
    return { candidate: null, candidateSpikeRatio: 0, currentSpikeRatio };
  }
  return { candidate: topCandidate, candidateSpikeRatio, currentSpikeRatio };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`hydrateTrendData` is called from within the same file, so no export needed for it.)

- [ ] **Step 3: Verify against the real API**

```typescript
// check_opportunity_scan_tmp.ts
import { fetchTopPools, defaultScannerConfig, scanForBetterOpportunity } from './src/services/meteoraScanner.js';

async function main() {
  const blacklist = new Map();
  const config = defaultScannerConfig(blacklist);
  const pairs = await fetchTopPools();
  const somePool = pairs[0]!;
  const result = await scanForBetterOpportunity(somePool.address, config);
  console.assert(typeof result.currentSpikeRatio === 'number', 'currentSpikeRatio should be a number');
  console.assert(typeof result.candidateSpikeRatio === 'number', 'candidateSpikeRatio should be a number');
  console.assert(result.candidate === null || result.candidate.address !== somePool.address, 'candidate should never equal the currently-held pool');
  console.log('PASS:', { currentSpikeRatio: result.currentSpikeRatio, candidateSpikeRatio: result.candidateSpikeRatio, candidate: result.candidate?.name ?? null });
}
main();
```

Run: `npx tsx check_opportunity_scan_tmp.ts`
Expected: `PASS: ...` printed with real numbers.

Then: `rm check_opportunity_scan_tmp.ts`

- [ ] **Step 4: Commit**

```bash
git add src/services/meteoraScanner.ts
git commit -m "$(cat <<'EOF'
feat: add scanForBetterOpportunity for opportunistic pool-switching

Compares the currently-held pool's live volumeSpikeRatio against the
best available market candidate, hydrated in the same batched
DexScreener pass. Pure data-gathering step; the switch decision itself
(profit-guard, cooldown, margin) lands in riskManager next.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `TAKE_PROFIT` trailing-stop decision

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/logic/riskManager.ts:4,45-100`

**Interfaces:**
- Consumes: nothing new externally — pure math on inputs the caller already tracks.
- Produces: `RiskDecision` gains `'TAKE_PROFIT'`. `PositionHealthInput` gains required field `peakProfitPct: number`. Consumed by Tasks 6 (index.ts) and 8 (paperTrade.ts), which must track and pass this field.

- [ ] **Step 1: Add the two new env vars**

In `src/config/env.ts`, after the existing `MAX_IDLE_OUT_OF_RANGE_MINUTES` line (currently line 116), add:

```typescript
  // Trailing take-profit: once unrealized profit peaks at/above
  // TAKE_PROFIT_ARM_PCT, a trailing floor is set at (peak -
  // TAKE_PROFIT_GIVEBACK_PCT) percentage points; if profit drops to/below
  // that floor, exit and lock in the remaining gain instead of riding it
  // all the way back down. No blacklist on this exit (see riskManager.ts) -
  // it's profit protection, not a risk violation, so the pool stays a
  // valid candidate if its run continues. 25pp giveback (not the 50pp
  // originally considered) matches the 15-30% range crypto-momentum
  // practice converges on for volatile assets; a flat 50pp giveback was
  // researched as too loose for Solana memecoin volatility specifically.
  TAKE_PROFIT_ARM_PCT: num('TAKE_PROFIT_ARM_PCT', 30),
  TAKE_PROFIT_GIVEBACK_PCT: num('TAKE_PROFIT_GIVEBACK_PCT', 25),
```

- [ ] **Step 2: Extend `RiskDecision` and `PositionHealthInput`**

In `src/logic/riskManager.ts`, change line 4:
```typescript
export type RiskDecision = 'HOLD' | 'REBALANCE' | 'HARD_EXIT' | 'TAKE_PROFIT';
```

Add a field to `PositionHealthInput` (after the `outOfRangeSinceMs` field, currently line 22):
```typescript
  /** Highest unrealized profit % this position has ever reached (caller-tracked, updated with THIS tick's profit before calling evaluatePosition — see rebalanceEngine.ts/paperTrade.ts). 0 for a fresh position. */
  peakProfitPct: number;
```

- [ ] **Step 3: Add the TAKE_PROFIT check**

In `evaluatePosition`, right after the existing `lossPct` calculation (currently lines 48-54), add a derived `profitPct`:

```typescript
  const lossPct =
    input.initialDepositUsd > 0
      ? ((input.initialDepositUsd - input.currentValueUsd) / input.initialDepositUsd) * 100
      : 0;
  if (lossPct >= env.STOP_LOSS_PCT) {
    reasons.push(`unrealized loss ${lossPct.toFixed(2)}% >= STOP_LOSS_PCT ${env.STOP_LOSS_PCT}%`);
  }
  const profitPct = -lossPct;
```

Then, right after the existing `if (reasons.length) { ... return { decision: 'HARD_EXIT', reasons }; }` block (currently lines 69-72), insert the new check — this makes `TAKE_PROFIT` second priority, right below `HARD_EXIT` and above the fee-threshold `REBALANCE` check, matching the spec's decision-tree ordering:

```typescript
  if (input.peakProfitPct >= env.TAKE_PROFIT_ARM_PCT) {
    const floorPct = input.peakProfitPct - env.TAKE_PROFIT_GIVEBACK_PCT;
    if (profitPct <= floorPct) {
      const r = [
        `profit ${profitPct.toFixed(2)}% dropped to trailing floor ${floorPct.toFixed(2)}% (peak ${input.peakProfitPct.toFixed(2)}% - ${env.TAKE_PROFIT_GIVEBACK_PCT}pp giveback)`,
      ];
      logger.info('[riskManager] TAKE_PROFIT', { reasons: r });
      return { decision: 'TAKE_PROFIT', reasons: r };
    }
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: errors at every existing call site of `evaluatePosition` (index.ts, paperTrade.ts) — they don't pass `peakProfitPct` yet. This is expected; Tasks 6 and 8 fix those call sites. Confirm the errors are ONLY about the missing `peakProfitPct` field (no other type errors), which validates the change is otherwise correct.

- [ ] **Step 5: Verify the trailing-stop math standalone**

```typescript
// check_take_profit_tmp.ts
import { evaluatePosition } from './src/logic/riskManager.js';

const now = Date.now();
const base = {
  rebalanceTimestamps: [],
  volume1hNowUsd: 1000,
  volume1hBaselineUsd: 1000,
  unclaimedFeesUsd: 0,
  estimatedGasCostUsd: 1,
  isOutOfRange: false,
  outOfRangeSinceMs: null,
};

// Peak was 50%, now at 30% (dropped 20pp, floor is 50-25=25) -> should NOT trigger yet
const r1 = evaluatePosition({ ...base, initialDepositUsd: 100, currentValueUsd: 130, peakProfitPct: 50 }, now);
console.assert(r1.decision !== 'TAKE_PROFIT', `expected NOT TAKE_PROFIT at 30% with peak 50%/floor 25%, got ${r1.decision}`);

// Peak was 50%, now at 25% (exactly at floor) -> should trigger
const r2 = evaluatePosition({ ...base, initialDepositUsd: 100, currentValueUsd: 125, peakProfitPct: 50 }, now);
console.assert(r2.decision === 'TAKE_PROFIT', `expected TAKE_PROFIT at exactly the floor, got ${r2.decision}`);

// Peak was only 20% (never armed, since arm threshold is 30%) -> should never trigger even at a big drop
const r3 = evaluatePosition({ ...base, initialDepositUsd: 100, currentValueUsd: 101, peakProfitPct: 20 }, now);
console.assert(r3.decision !== 'TAKE_PROFIT', `expected NOT TAKE_PROFIT when never armed (peak 20% < 30% arm), got ${r3.decision}`);

console.log('PASS: all trailing take-profit assertions passed');
```

Run: `npx tsx check_take_profit_tmp.ts`
Expected: `PASS: ...`, no assertion failures.

Then: `rm check_take_profit_tmp.ts`

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/logic/riskManager.ts
git commit -m "$(cat <<'EOF'
feat: add TAKE_PROFIT trailing-stop decision to riskManager

Arms once peak unrealized profit reaches 30%, then exits if profit
drops to (peak - 25pp). No blacklist on this exit - it's profit
protection, not a risk violation, so the pool stays re-entry-eligible.
25pp giveback chosen over the 50pp originally considered after
researching it sits well outside the 15-30% range crypto-momentum
practice converges on for volatile assets.

Breaks existing evaluatePosition call sites (index.ts, paperTrade.ts)
pending peakProfitPct wiring in follow-up tasks - expected, not a bug.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `evaluateSwitchOpportunity` decision function

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/logic/riskManager.ts`

**Interfaces:**
- Consumes: `OpportunityScanResult` shape from Task 2 (not imported directly — caller passes primitive fields, keeping this function pure and I/O-free like `evaluatePosition`).
- Produces: `export interface SwitchEvaluationInput { currentProfitPct: number; currentSpikeRatio: number; candidateSpikeRatio: number; hasCandidate: boolean; lastSwitchAtMs: number | null }`, `export interface SwitchEvaluation { shouldSwitch: boolean; reason: string }`, `export function evaluateSwitchOpportunity(input: SwitchEvaluationInput, now = Date.now()): SwitchEvaluation`. Consumed by Tasks 7 and 9.

- [ ] **Step 1: Add the four new env vars**

In `src/config/env.ts`, after the `TAKE_PROFIT_GIVEBACK_PCT` line added in Task 3, add:

```typescript

  // Opportunistic pool-switching: every OPPORTUNITY_SCAN_INTERVAL_MS while
  // holding a position, compare it against the best market candidate via
  // volumeSpikeRatio. Switch only if the candidate beats current by
  // SWITCH_SPIKE_RATIO_MARGIN (1.5x - deliberately not a marginal win, since
  // switching costs a full exit+re-entry cycle), UNLESS current unrealized
  // profit is already >= SWITCH_PROFIT_GUARD_PCT (don't abandon a proven
  // winner for an unproven candidate), and never more often than once per
  // SWITCH_COOLDOWN_MS (anti-whipsaw, stacked on top of the scan interval
  // itself).
  OPPORTUNITY_SCAN_INTERVAL_MS: num('OPPORTUNITY_SCAN_INTERVAL_MS', 5 * 60_000),
  SWITCH_SPIKE_RATIO_MARGIN: num('SWITCH_SPIKE_RATIO_MARGIN', 1.5),
  SWITCH_PROFIT_GUARD_PCT: num('SWITCH_PROFIT_GUARD_PCT', 30),
  SWITCH_COOLDOWN_MS: num('SWITCH_COOLDOWN_MS', 15 * 60_000),
```

- [ ] **Step 2: Add the function**

In `src/logic/riskManager.ts`, after `evaluatePosition`'s closing brace (right before the `// ── Blacklist manager ──` section), add:

```typescript
export interface SwitchEvaluationInput {
  /** Currently-held position's unrealized profit %, same sign convention as evaluatePosition (positive = profit). */
  currentProfitPct: number;
  currentSpikeRatio: number;
  candidateSpikeRatio: number;
  /** False if scanForBetterOpportunity found no distinct qualifying candidate this scan. */
  hasCandidate: boolean;
  /** Epoch ms of the last switch, or null if none has happened yet this run. */
  lastSwitchAtMs: number | null;
}

export interface SwitchEvaluation {
  shouldSwitch: boolean;
  reason: string;
}

/**
 * Pure decision function for the opportunistic pool-switching feature -
 * mirrors evaluatePosition's shape (no I/O, caller already did the scan).
 * Checked only at the caller's own OPPORTUNITY_SCAN_INTERVAL_MS cadence,
 * not every tick.
 */
export function evaluateSwitchOpportunity(input: SwitchEvaluationInput, now = Date.now()): SwitchEvaluation {
  if (!input.hasCandidate) {
    return { shouldSwitch: false, reason: 'no qualifying candidate found this scan' };
  }
  if (input.currentProfitPct >= env.SWITCH_PROFIT_GUARD_PCT) {
    return {
      shouldSwitch: false,
      reason: `current profit ${input.currentProfitPct.toFixed(2)}% >= SWITCH_PROFIT_GUARD_PCT ${env.SWITCH_PROFIT_GUARD_PCT}% - protecting winner`,
    };
  }
  if (input.lastSwitchAtMs !== null && now - input.lastSwitchAtMs < env.SWITCH_COOLDOWN_MS) {
    const remainingMin = ((env.SWITCH_COOLDOWN_MS - (now - input.lastSwitchAtMs)) / 60_000).toFixed(1);
    return { shouldSwitch: false, reason: `switch cooldown active, ${remainingMin}min remaining` };
  }
  const requiredRatio = input.currentSpikeRatio * env.SWITCH_SPIKE_RATIO_MARGIN;
  if (input.candidateSpikeRatio >= requiredRatio) {
    return {
      shouldSwitch: true,
      reason: `candidate spike ${input.candidateSpikeRatio.toFixed(2)}x >= current ${input.currentSpikeRatio.toFixed(2)}x * margin ${env.SWITCH_SPIKE_RATIO_MARGIN} (required ${requiredRatio.toFixed(2)}x)`,
    };
  }
  return {
    shouldSwitch: false,
    reason: `candidate spike ${input.candidateSpikeRatio.toFixed(2)}x < required ${requiredRatio.toFixed(2)}x`,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors beyond the pre-existing `peakProfitPct`-missing ones from Task 3 (not yet fixed until Tasks 6/8).

- [ ] **Step 4: Verify the switch decision logic standalone**

```typescript
// check_switch_eval_tmp.ts
import { evaluateSwitchOpportunity } from './src/logic/riskManager.js';

const now = Date.now();

// No candidate -> never switch
const r1 = evaluateSwitchOpportunity({ currentProfitPct: 0, currentSpikeRatio: 2, candidateSpikeRatio: 0, hasCandidate: false, lastSwitchAtMs: null }, now);
console.assert(!r1.shouldSwitch, 'expected no switch when hasCandidate is false');

// Profit guard: current profit 35% (>= 30% guard) -> never switch even with a huge candidate margin
const r2 = evaluateSwitchOpportunity({ currentProfitPct: 35, currentSpikeRatio: 2, candidateSpikeRatio: 100, hasCandidate: true, lastSwitchAtMs: null }, now);
console.assert(!r2.shouldSwitch, 'expected no switch when profit guard active');

// Cooldown: switched 5 minutes ago (< 15min cooldown) -> no switch even if margin met
const r3 = evaluateSwitchOpportunity({ currentProfitPct: 0, currentSpikeRatio: 2, candidateSpikeRatio: 10, hasCandidate: true, lastSwitchAtMs: now - 5 * 60_000 }, now);
console.assert(!r3.shouldSwitch, 'expected no switch during cooldown');

// Margin not met: candidate 1.2x current (< 1.5x required) -> no switch
const r4 = evaluateSwitchOpportunity({ currentProfitPct: 0, currentSpikeRatio: 10, candidateSpikeRatio: 12, hasCandidate: true, lastSwitchAtMs: null }, now);
console.assert(!r4.shouldSwitch, 'expected no switch below 1.5x margin');

// Margin met, no profit guard, no cooldown -> switch
const r5 = evaluateSwitchOpportunity({ currentProfitPct: 0, currentSpikeRatio: 10, candidateSpikeRatio: 16, hasCandidate: true, lastSwitchAtMs: null }, now);
console.assert(r5.shouldSwitch, 'expected switch at 1.6x margin (>= 1.5x required)');

console.log('PASS: all switch-evaluation assertions passed');
```

Run: `npx tsx check_switch_eval_tmp.ts`
Expected: `PASS: ...`, no assertion failures.

Then: `rm check_switch_eval_tmp.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/logic/riskManager.ts
git commit -m "$(cat <<'EOF'
feat: add evaluateSwitchOpportunity for opportunistic pool-switching

Pure decision function: switch only if a scanned candidate's
volumeSpikeRatio beats the current position's by >=1.5x, unless
current profit already >=30% (protect winners) or a switch happened
within the last 15 minutes (anti-whipsaw). No I/O - caller does the
scan via scanForBetterOpportunity and passes primitives in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rebalance-engine execution primitives

**Files:**
- Modify: `src/logic/rebalanceEngine.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PoolContext` gains `peakProfitPct: number`. New `export async function executeCleanExit(ctx: PoolContext, reason: 'SWITCH' | 'TAKE_PROFIT'): Promise<number>`. `executeHardExit` keeps its existing signature/behavior (refactored internally, no external change). Consumed by Tasks 6 and 7.

- [ ] **Step 1: Add `peakProfitPct` to `PoolContext`**

In `src/logic/rebalanceEngine.ts`, add to the `PoolContext` interface (after `outOfRangeSinceMs`, currently line 44):

```typescript
  /** Highest unrealized profit % this position has ever reached, since openInitialPosition. Not reset on compoundCycle (initialDepositSol itself is never reset on compound either — this mirrors that existing basis). Reset only by starting a fresh PoolContext (new entry or switch). */
  peakProfitPct: number;
```

Initialize it in `openInitialPosition`'s returned `ctx` object (in the object literal currently at lines 253-266), adding `peakProfitPct: 0,` alongside the other fields.

- [ ] **Step 2: Extract `closeAndConvertToSol` and refactor `executeHardExit`**

Replace the existing `executeHardExit` function (currently lines 273-297) with:

```typescript
/**
 * Closes the current position (claim fees + reclaim rent) and converts
 * everything to SOL. Shared by executeHardExit (adds a blacklist after)
 * and executeCleanExit (no blacklist - used by SWITCH and TAKE_PROFIT,
 * neither of which are risk violations).
 */
async function closeAndConvertToSol(ctx: PoolContext, logPrefix: string): Promise<number> {
  const [position] = await getUserPositions(ctx.pool);
  if (position) {
    logger.warn(`[rebalanceEngine] ${logPrefix}: closing position`, { pool: ctx.poolAddress });
    await closePositionFull(ctx.pool, position);
  }

  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const otherAmount = await getTokenBalance(otherMint);
  if (otherAmount.gtn(0)) {
    await emergencySwapAllToSol(otherMint, otherAmount);
  }

  const solBalance = await getWalletSolBalance();
  const nextCapital = Math.max(solBalance - env.MIN_GAS_RESERVE_SOL, 0);
  logger.warn(`[rebalanceEngine] ${logPrefix} complete`, { pool: ctx.poolAddress, solBalance, nextCapital });
  return nextCapital;
}

/**
 * Hard-exit flow: close position, dump 100% of the non-SOL side to SOL,
 * blacklist the pool for BLACKLIST_DURATION_MS, and return the leftover SOL
 * capital available for the next pool.
 */
export async function executeHardExit(ctx: PoolContext, blacklistPools: Map<string, number>): Promise<number> {
  const nextCapital = await closeAndConvertToSol(ctx, 'HARD_EXIT');
  addToBlacklist(blacklistPools, ctx.poolAddress);
  return nextCapital;
}

/**
 * Close position and convert to SOL WITHOUT blacklisting - used for both
 * SWITCH (leaving to chase a better opportunity) and TAKE_PROFIT (locking
 * in gains). Neither is a risk violation, so the pool stays a fully valid
 * candidate for the very next scan.
 */
export async function executeCleanExit(ctx: PoolContext, reason: 'SWITCH' | 'TAKE_PROFIT'): Promise<number> {
  return closeAndConvertToSol(ctx, reason);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (same pre-existing `peakProfitPct`-on-evaluatePosition-input errors from Task 3, still pending Tasks 6/8).

- [ ] **Step 4: Commit**

```bash
git add src/logic/rebalanceEngine.ts
git commit -m "$(cat <<'EOF'
feat: add executeCleanExit + peakProfitPct tracking to rebalanceEngine

Extracts closeAndConvertToSol as a shared helper between
executeHardExit (blacklists) and the new executeCleanExit (doesn't -
used by the upcoming SWITCH and TAKE_PROFIT decisions, neither of
which are risk violations). PoolContext gains peakProfitPct, tracked
by the caller each tick and never reset on compoundCycle (mirrors
initialDepositSol's own existing never-reset-on-compound basis).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Real bot — TAKE_PROFIT wiring

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `TAKE_PROFIT` decision (Task 3), `executeCleanExit` (Task 5), `ctx.peakProfitPct` (Task 5).
- Produces: nothing new for later tasks (Task 7 adds SWITCH to the same file, independently appendable).

- [ ] **Step 1: Import `executeCleanExit`**

In `src/index.ts`, add `executeCleanExit` to the existing import from `./logic/rebalanceEngine.js` (currently lines 5-16):

```typescript
import {
  openInitialPosition,
  compoundCycle,
  claimFeesOnly,
  executeHardExit,
  executeCleanExit,
  getPositionHealthSnapshot,
  getBinRangeStatus,
  updateOutOfRangeTracking,
  isCooldownActive,
  estimateCycleGasCostSol,
  type PoolContext,
} from './logic/rebalanceEngine.js';
```

- [ ] **Step 2: Track peak profit and pass it into `evaluatePosition`**

In `tick()`, right after `updateOutOfRangeTracking(ctx, binStatus.isOutOfRange);` (currently line 72) and before the `gasCostSol` calculation, add:

```typescript
  const currentProfitPct = ctx.initialDepositSol > 0 ? ((currentValueSol - ctx.initialDepositSol) / ctx.initialDepositSol) * 100 : 0;
  ctx.peakProfitPct = Math.max(ctx.peakProfitPct, currentProfitPct);
```

Then add `peakProfitPct: ctx.peakProfitPct,` to the `evaluatePosition({...})` call's argument object (currently lines 75-85), alongside the existing fields.

- [ ] **Step 3: Handle the `TAKE_PROFIT` decision**

Right after the existing `if (decision === 'HARD_EXIT') { ... return; }` block (currently lines 96-100), add:

```typescript
  if (decision === 'TAKE_PROFIT') {
    currentCapitalSol = await executeCleanExit(ctx, 'TAKE_PROFIT');
    currentPool = null;
    return;
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the `peakProfitPct`-missing error from Task 3 is now fixed for this file).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: wire TAKE_PROFIT decision into the real bot's tick loop

Tracks peakProfitPct on PoolContext each tick, feeds it into
evaluatePosition, and executes a clean (non-blacklisting) exit when
the trailing-stop fires.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Real bot — opportunity-scan + SWITCH wiring

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `scanForBetterOpportunity` (Task 2), `evaluateSwitchOpportunity` (Task 4), `executeCleanExit` (Task 5), `openPool` (already imported), `openInitialPosition` (already imported).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Import the new scanner/riskManager functions**

Add `scanForBetterOpportunity` to the existing `./services/meteoraScanner.js` import (currently line 3):

```typescript
import { scanPools, defaultScannerConfig, getVolume1hUsd, scanForBetterOpportunity } from './services/meteoraScanner.js';
```

Add `evaluateSwitchOpportunity` to the existing `./logic/riskManager.js` import (currently line 17):

```typescript
import { evaluatePosition, evaluateSwitchOpportunity } from './logic/riskManager.js';
```

- [ ] **Step 2: Add module-level state**

After the existing `let currentCapitalSol = env.INITIAL_LP_CAPITAL_SOL;` line (currently line 25), add:

```typescript
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;
```

- [ ] **Step 3: Add the opportunity-scan check**

In `tick()`, after the `if (decision === 'REBALANCE') { ... }` block closes (currently right before the `// HOLD — nothing to do.` comment at line 127) — i.e. this check runs whenever the tick did NOT already `return` from a HARD_EXIT/TAKE_PROFIT/REBALANCE branch above — add:

```typescript
  const now = Date.now();
  if (now - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
    lastOpportunityScanAtMs = now;
    const scanResult = await scanForBetterOpportunity(ctx.poolAddress, defaultScannerConfig(blacklistPools));
    const switchEval = evaluateSwitchOpportunity(
      {
        currentProfitPct,
        currentSpikeRatio: scanResult.currentSpikeRatio,
        candidateSpikeRatio: scanResult.candidateSpikeRatio,
        hasCandidate: scanResult.candidate !== null,
        lastSwitchAtMs,
      },
      now,
    );
    logger.info('[index] opportunity scan', { decision: switchEval.shouldSwitch ? 'SWITCH' : 'HOLD', reason: switchEval.reason });
    if (switchEval.shouldSwitch && scanResult.candidate) {
      const candidate = scanResult.candidate;
      currentCapitalSol = await executeCleanExit(ctx, 'SWITCH');
      const xIsSol = candidate.mint_x === WSOL_MINT;
      const yIsSol = candidate.mint_y === WSOL_MINT;
      if (xIsSol || yIsSol) {
        try {
          const newPool = await openPool(candidate.address);
          currentPool = await openInitialPosition(newPool, candidate.address, candidate.mint_x, candidate.mint_y, xIsSol, currentCapitalSol, candidate.bin_step);
          lastSwitchAtMs = now;
          logger.info('[index] SWITCH complete', { from: ctx.poolAddress, to: candidate.address });
        } catch (err) {
          logger.error('[index] SWITCH failed to open new position, capital left in SOL for next scan', {
            candidate: candidate.address,
            error: err instanceof Error ? err.message : String(err),
          });
          currentPool = null;
        }
      } else {
        // ponytail: engine only prices in SOL terms, same guard as tryEnterPool - shouldn't happen since filterAndRankPools already requires a SOL side via nonSolToken, but stay defensive.
        currentPool = null;
      }
      return;
    }
  }

```

(Note: `currentProfitPct` here is the same variable computed in Task 6's Step 2, already in scope at this point in `tick()`. `WSOL_MINT` is already imported at the top of `index.ts`.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: wire opportunistic pool-switching into the real bot's tick loop

Every OPPORTUNITY_SCAN_INTERVAL_MS (5min) while holding a position,
scans the full market and switches into a candidate whose
volumeSpikeRatio beats the current position's by >=1.5x - gated by a
30% profit-guard and a 15min post-switch cooldown. Closes the current
position (no blacklist, via executeCleanExit) and opens directly into
the already-validated candidate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Paper-trade — extract `enterPool` + TAKE_PROFIT wiring

**Files:**
- Modify: `src/scripts/paperTrade.ts`

**Interfaces:**
- Consumes: `TAKE_PROFIT` decision (Task 3).
- Produces: `async function enterPool(chosen: MeteoraPair): Promise<VirtualPosition>` — new, extracted from `enterBestPool`. Consumed by Task 9 for the SWITCH execution path.

- [ ] **Step 1: Add `peakProfitPct` to `VirtualPosition`**

In the `VirtualPosition` interface (currently lines 73-91), add after `outOfRangeSinceMs`:

```typescript
  /** Highest unrealized profit % since entry/last-compound. Reset to 0 whenever capitalUsd/entrySolPriceUsd/entryMemePriceUsd reset (compound or switch) - unlike the real bot, paper-trade's profit basis DOES reset on every compound (position.capitalUsd = compoundedToUsd), so the peak must reset with it to stay consistent. */
  peakProfitPct: number;
```

- [ ] **Step 2: Extract `enterPool` out of `enterBestPool`**

Replace the whole `enterBestPool` function (currently lines 225-288) with two functions:

```typescript
/** Entry mechanics for an already-chosen pool - shared by enterBestPool (fresh full-market pick) and the upcoming SWITCH path (a specific pre-validated candidate from scanForBetterOpportunity, no re-pick needed). */
async function enterPool(chosen: MeteoraPair): Promise<VirtualPosition | null> {
  const sol = solToken(chosen);
  const meme = nonSolToken(chosen);
  if (!sol || !meme) return null; // shouldn't happen post-screen, defensive

  if (summary.startingCapitalUsd === null) {
    idleCapitalUsd = env.INITIAL_LP_CAPITAL_SOL * sol.priceUsd;
    summary.startingCapitalUsd = idleCapitalUsd;
  }
  lastKnownSolPriceUsd = sol.priceUsd;

  // Entry costs real gas + a balancing swap too — deduct before the capital starts earning.
  const entryCostSol = estimateCycleGasCostSol(idleCapitalUsd / sol.priceUsd);
  const entryCostUsd = entryCostSol * sol.priceUsd;
  const capitalAfterEntryCostUsd = Math.max(idleCapitalUsd - entryCostUsd, 0);
  const centerBinId = await getActiveBinId(chosen.address);

  const now = Date.now();
  const entered: VirtualPosition = {
    poolAddress: chosen.address,
    poolName: chosen.name,
    enteredAtMs: now,
    lastRebalanceAtMs: now,
    lastFeeAccrualAtMs: now,
    rebalanceTimestamps: [],
    capitalUsd: capitalAfterEntryCostUsd,
    feesEarnedUsd: 0,
    entrySolPriceUsd: sol.priceUsd,
    entryMemePriceUsd: meme.priceUsd,
    volume1hBaselineUsd: chosen.volume1hUsd,
    binStep: chosen.bin_step,
    centerBinId,
    outOfRangeSinceMs: null,
    peakProfitPct: 0,
  };
  position = entered;
  summary.poolsEntered++;
  summary.poolHistory.push({
    pool: chosen.name,
    address: chosen.address,
    enteredAtMs: now,
    entryCapitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
    rebalanceCount: 0,
  });
  logEvent({
    type: 'ENTER',
    pool: chosen.name,
    address: chosen.address,
    capitalUsd: +capitalAfterEntryCostUsd.toFixed(2),
    entryCostUsd: +entryCostUsd.toFixed(2),
    solPriceUsd: sol.priceUsd,
    memePriceUsd: meme.priceUsd,
    tvlUsd: Number(chosen.liquidity),
    vol24hUsd: chosen.trade_volume_24h,
    centerBinId,
    binRange: centerBinId === null ? null : [centerBinId - computeBinRadius(chosen.bin_step), centerBinId + computeBinRadius(chosen.bin_step)],
  });
  return entered;
}

async function enterBestPool(pairs: MeteoraPair[]): Promise<VirtualPosition | null> {
  const candidates = await filterAndRankPools(pairs, defaultScannerConfig(blacklist));
  if (!candidates.length) {
    logEvent({ type: 'NO_CANDIDATE', note: 'no pool passes screen this tick' });
    return null;
  }
  return enterPool(candidates[0]!);
}
```

- [ ] **Step 3: Reset `peakProfitPct` on compound**

In the REBALANCE→stillEligible branch (currently lines 442-452, where `position.capitalUsd = compoundedToUsd;` etc. happens), add `position.peakProfitPct = 0;` alongside the other resets:

```typescript
        position.capitalUsd = compoundedToUsd;
        position.feesEarnedUsd = 0;
        finalPositionValueUsd = compoundedToUsd;
        position.entrySolPriceUsd = sol.priceUsd;
        position.entryMemePriceUsd = meme.priceUsd;
        position.peakProfitPct = 0;
        position.volume1hBaselineUsd = live.volume1hUsd;
```

- [ ] **Step 4: Track peak profit and pass it into `evaluatePosition`**

In `tick()`, right before the `const gasCostSol = ...` line (currently line 353), add:

```typescript
  const currentProfitPct = position.capitalUsd > 0 ? ((currentValueUsd - position.capitalUsd) / position.capitalUsd) * 100 : 0;
  position.peakProfitPct = Math.max(position.peakProfitPct, currentProfitPct);
```

Then add `peakProfitPct: position.peakProfitPct,` to the `evaluatePosition({...})` call's argument object (currently lines 355-365).

- [ ] **Step 5: Handle the `TAKE_PROFIT` decision**

Right after the existing `if (decision === 'HARD_EXIT') { ... return; }` block (currently lines 367-393), add a new branch:

```typescript
  if (decision === 'TAKE_PROFIT') {
    const exitValueAfterCostUsd = Math.max(currentValueUsd - gasCostUsd, 0);
    logEvent({
      type: 'TAKE_PROFIT',
      pool: position.poolName,
      reasons,
      finalValueUsd: +exitValueAfterCostUsd.toFixed(2),
      exitCostUsd: +gasCostUsd.toFixed(2),
      capitalAtEntryUsd: +position.capitalUsd.toFixed(2),
      peakProfitPct: +position.peakProfitPct.toFixed(2),
    });
    // No blacklist - profit-protection exit, not a violation. Matches LEAVE_POOL's policy.
    const visit = summary.poolHistory[summary.poolHistory.length - 1];
    if (visit) {
      visit.exitedAtMs = now;
      visit.exitType = 'LEFT_POOL';
      visit.exitValueUsd = +exitValueAfterCostUsd.toFixed(2);
      visit.exitReasons = reasons;
    }
    idleCapitalUsd = exitValueAfterCostUsd;
    position = null;
    writeState(portfolioValueUsd(idleCapitalUsd));
    return;
  }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Verify with a short smoke run**

Run: `PAPER_TRADE_LABEL=take-profit-smoke PAPER_TRADE_HOURS=0.02 timeout 90 npx tsx src/scripts/paperTrade.ts 2>&1 | grep -v "429\|Retrying"`
Expected: an `ENTER` event followed by `HOLD` events, no crash, no `TypeError`. (A `TAKE_PROFIT` event is unlikely to actually fire in a 1-minute smoke run — that's fine, this step only confirms the code path doesn't crash on load/execution, not that the trigger fires.)

Then clean up: `rm -f logs/paper-trade-state-take-profit-smoke.json logs/paper-trade-take-profit-smoke-*.jsonl logs/paper-trade-take-profit-smoke-stdout.log` (adjust filenames to whatever the run actually produced, matching this session's established cleanup pattern).

- [ ] **Step 8: Commit**

```bash
git add src/scripts/paperTrade.ts
git commit -m "$(cat <<'EOF'
feat: wire TAKE_PROFIT decision into paper-trade

Extracts enterPool from enterBestPool (entry mechanics for an
already-chosen pool, reused by the upcoming SWITCH path). Tracks
peakProfitPct on VirtualPosition, resetting it on compound (paper-
trade's profit basis itself resets on compound, unlike the real bot's
never-reset initialDepositSol - the peak follows the same basis).
Adds a TAKE_PROFIT log event and exit path matching LEAVE_POOL's
no-blacklist policy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Paper-trade — opportunity-scan + SWITCH wiring

**Files:**
- Modify: `src/scripts/paperTrade.ts`

**Interfaces:**
- Consumes: `scanForBetterOpportunity` (Task 2), `evaluateSwitchOpportunity` (Task 4), `enterPool` (Task 8).
- Produces: nothing new for later tasks (final feature task before verification).

- [ ] **Step 1: Import the new functions**

Add `scanForBetterOpportunity` to the existing import from `../services/meteoraScanner.js` (currently lines 41-49):

```typescript
import {
  fetchTopPools,
  filterAndRankPools,
  defaultScannerConfig,
  nonSolToken,
  solToken,
  poolRejectReasons,
  scanForBetterOpportunity,
  type MeteoraPair,
} from '../services/meteoraScanner.js';
```

Add `evaluateSwitchOpportunity` to the existing import from `../logic/riskManager.js` (currently line 50):

```typescript
import { evaluatePosition, evaluateSwitchOpportunity, addToBlacklist } from '../logic/riskManager.js';
```

- [ ] **Step 2: Add module-level state**

After the existing `let lastKnownSolPriceUsd = 0;` line (currently line 120), add:

```typescript
let lastOpportunityScanAtMs = 0;
let lastSwitchAtMs: number | null = null;
```

- [ ] **Step 3: Add the opportunity-scan check**

In `tick()`, the function currently ends with the `HOLD`-vs-`REBALANCE` `if/else` (closing at line 493) followed by the final `writeState(...)` call (line 495). Insert the opportunity-scan check AFTER that `if/else` block closes but BEFORE the final `writeState` call, and only when `position` is still non-null (a `HARD_EXIT`/`TAKE_PROFIT`/`LEAVE_POOL` branch already returned earlier in the function, so reaching here with `position !== null` means we're either in a HOLD state, a just-completed in-pool REBALANCE, or a claim-only cycle):

```typescript
  if (position) {
    const opportunityNow = Date.now();
    if (opportunityNow - lastOpportunityScanAtMs >= env.OPPORTUNITY_SCAN_INTERVAL_MS) {
      lastOpportunityScanAtMs = opportunityNow;
      const scanResult = await scanForBetterOpportunity(position.poolAddress, defaultScannerConfig(blacklist));
      const currentProfitPctForSwitch = position.capitalUsd > 0 ? ((finalPositionValueUsd - position.capitalUsd) / position.capitalUsd) * 100 : 0;
      const switchEval = evaluateSwitchOpportunity(
        {
          currentProfitPct: currentProfitPctForSwitch,
          currentSpikeRatio: scanResult.currentSpikeRatio,
          candidateSpikeRatio: scanResult.candidateSpikeRatio,
          hasCandidate: scanResult.candidate !== null,
          lastSwitchAtMs,
        },
        opportunityNow,
      );
      if (switchEval.shouldSwitch && scanResult.candidate) {
        const candidate = scanResult.candidate;
        logEvent({
          type: 'SWITCH',
          fromPool: position.poolName,
          toPool: candidate.name,
          reason: switchEval.reason,
          compoundedFromUsd: +position.capitalUsd.toFixed(2),
          exitValueUsd: +finalPositionValueUsd.toFixed(2),
        });
        const visit = summary.poolHistory[summary.poolHistory.length - 1];
        if (visit) {
          visit.exitedAtMs = opportunityNow;
          visit.exitType = 'LEFT_POOL';
          visit.exitValueUsd = +finalPositionValueUsd.toFixed(2);
          visit.exitReasons = [switchEval.reason];
        }
        idleCapitalUsd = finalPositionValueUsd;
        position = null;
        await enterPool(candidate);
        lastSwitchAtMs = opportunityNow;
        writeState(portfolioValueUsd(position ? position.capitalUsd : idleCapitalUsd));
        return;
      }
    }
  }

```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Verify with a short smoke run**

Run: `PAPER_TRADE_LABEL=switch-smoke PAPER_TRADE_HOURS=0.02 timeout 90 npx tsx src/scripts/paperTrade.ts 2>&1 | grep -v "429\|Retrying"`
Expected: `ENTER` + `HOLD` events, no crash. A `SWITCH` event won't fire in a 1-minute run (the 5-minute opportunity-scan interval hasn't elapsed) - this step only confirms no crash on load/execution.

Then clean up: `rm -f logs/paper-trade-state-switch-smoke.json logs/paper-trade-switch-smoke-*.jsonl logs/paper-trade-switch-smoke-stdout.log`

- [ ] **Step 6: Commit**

```bash
git add src/scripts/paperTrade.ts
git commit -m "$(cat <<'EOF'
feat: wire opportunistic pool-switching into paper-trade

Mirrors the real bot's wiring (Task 7): every OPPORTUNITY_SCAN_INTERVAL_MS
while holding a position, scans the market and switches via the same
evaluateSwitchOpportunity decision, logging a new SWITCH event type.
Uses the enterPool helper extracted in the previous task to open
directly into the validated candidate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full-run verification

**Files:** none (verification only, no code changes)

**Interfaces:** N/A

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors across the whole project.

- [ ] **Step 2: Stop any currently-running paper-trade process**

```bash
pgrep -fl paperTrade.ts
```

If a process is running (from prior sessions), note its PIDs and stop it:

```bash
kill <pid1> <pid2>
```

- [ ] **Step 3: Start a fresh long-running paper-trade validation run**

```bash
PAPER_TRADE_LABEL=switch-take-profit PAPER_TRADE_HOURS=87600 nohup npm run paper-trade > logs/paper-trade-switch-take-profit-stdout.log 2>&1 &
disown
sleep 3
pgrep -fl paperTrade.ts
```

Expected: two PIDs printed (the tsx wrapper + the actual node process), confirming the run started.

- [ ] **Step 4: Confirm the run produces a valid state file**

```bash
sleep 10
npm run paper-trade:report
```

Expected: a report section for label `switch-take-profit`, `(running)`, with a real `Starting capital`/`Current value` and a `Currently in: ...` pool — same shape as every other report this session, confirming the new code paths didn't break the existing reporting flow.

- [ ] **Step 5: Leave the run going for real-world observation**

No further action needed here — this run is the validation vehicle per the spec's testing section, same as every paper-trade run this session. `SWITCH` and `TAKE_PROFIT` events will only appear over hours, as market conditions actually produce them; there is nothing further to script-verify beyond what Tasks 1-9 already covered standalone.

---

## Self-Review Notes

**Spec coverage:** Every component listed in the spec's "Components touched" section has a task: `env.ts` (Tasks 3, 4), `meteoraScanner.ts` (Tasks 1, 2), `riskManager.ts` (Tasks 3, 4), `rebalanceEngine.ts` (Task 5), `index.ts` (Tasks 6, 7), `paperTrade.ts` (Tasks 8, 9). The spec's decision-tree priority (HARD_EXIT > TAKE_PROFIT > REBALANCE > HOLD, SWITCH separate/5-min-gated) is preserved in both index.ts and paperTrade.ts by placing the TAKE_PROFIT check immediately after HARD_EXIT inside `evaluatePosition` (shared logic, both callers get it automatically) and placing the opportunity-scan check after the REBALANCE branch resolves in both files.

**Type consistency:** `PoolContext.peakProfitPct` (Task 5) and `VirtualPosition.peakProfitPct` (Task 8) are both plain `number`, both fed into the same `PositionHealthInput.peakProfitPct` (Task 3) — consistent across both callers. `OpportunityScanResult` (Task 2) fields (`candidate`, `candidateSpikeRatio`, `currentSpikeRatio`) map 1:1 to `SwitchEvaluationInput`'s `hasCandidate`/`candidateSpikeRatio`/`currentSpikeRatio` (Task 4) at both call sites (Tasks 7, 9) - `hasCandidate` is derived as `scanResult.candidate !== null` in both.

**Known asymmetry, called out explicitly rather than silently introduced:** the real bot's `peakProfitPct` never resets on `compoundCycle` (matching `initialDepositSol`'s existing never-reset-on-compound behavior), while paper-trade's DOES reset on compound (matching `position.capitalUsd`'s existing reset-on-compound behavior). This is not a bug introduced by this plan - it's an existing inconsistency between the two codepaths' profit-basis semantics that this plan deliberately follows rather than silently "fixing" as an unrequested side effect.
