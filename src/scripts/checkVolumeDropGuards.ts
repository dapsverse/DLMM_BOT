/**
 * Self-check for Option B (VOLUME_DROP_GRACE_MS) — the volume-drop
 * HARD_EXIT grace period added 2026-09-24. Confirmed live: two separate
 * instances entered the SAME pool near-simultaneously during a volume
 * spike, and both got force-exited ~31s apart purely from the spike
 * naturally decaying (not a real problem) once it crossed the fixed 60%
 * drop threshold measured against the spike-inflated entry baseline.
 *
 * Option A (VOLUME_BASELINE_REFRESH_MS) is caller-side logic embedded in
 * index.ts/paperTrade.ts's tick loops (real API calls, async) — not
 * practical to unit-test in isolation here; verified by code review
 * instead (both call sites mirror each other exactly).
 *
 * env.ts reads VOLUME_DROP_GRACE_MS ONCE at module import time, so a
 * single process can't exercise both "disabled" and "enabled" behavior
 * (ESM module caching — a later process.env mutation doesn't get re-read).
 * Run this script TWICE instead:
 *   tsx src/scripts/checkVolumeDropGuards.ts                       (tests disabled/default)
 *   VOLUME_DROP_GRACE_MS=600000 tsx src/scripts/checkVolumeDropGuards.ts  (tests enabled, 10min grace)
 */
import assert from 'node:assert';
import { evaluatePosition } from '../logic/riskManager.js';
import { env } from '../config/env.js';

const BASE_INPUT = {
  initialDepositUsd: 100,
  currentValueUsd: 100, // no stop-loss involved
  rebalanceTimestamps: [] as number[],
  volume1hNowUsd: 30, // well below baseline
  volume1hBaselineUsd: 100, // 70% drop — clears VOLUME_DROP_HARD_EXIT_PCT (default 60%)
  unclaimedFeesUsd: 0,
  estimatedGasCostUsd: 1,
  peakProfitPct: 0,
};

const now = 1_000_000;

if (env.VOLUME_DROP_GRACE_MS === 0) {
  // Disabled (default) — volume-drop fires regardless of how recently the baseline was set.
  const result = evaluatePosition({ ...BASE_INPUT, volume1hBaselineSetAtMs: now }, now);
  assert.strictEqual(result.decision, 'HARD_EXIT', `expected HARD_EXIT with grace disabled, got ${result.decision}: ${result.reasons}`);
  console.log('OK (disabled): volume-drop HARD_EXIT fires unconditionally when VOLUME_DROP_GRACE_MS=0');
} else {
  // Enabled — within the window it's suppressed, past the window it fires again.
  const within = evaluatePosition({ ...BASE_INPUT, volume1hBaselineSetAtMs: now - env.VOLUME_DROP_GRACE_MS / 2 }, now);
  assert.strictEqual(within.decision, 'HOLD', `expected HOLD (suppressed by grace), got ${within.decision}: ${within.reasons}`);

  const past = evaluatePosition({ ...BASE_INPUT, volume1hBaselineSetAtMs: now - env.VOLUME_DROP_GRACE_MS * 2 }, now);
  assert.strictEqual(past.decision, 'HARD_EXIT', `expected HARD_EXIT (grace expired), got ${past.decision}: ${past.reasons}`);

  const unknown = evaluatePosition({ ...BASE_INPUT, volume1hBaselineSetAtMs: undefined }, now);
  assert.strictEqual(unknown.decision, 'HARD_EXIT', `expected HARD_EXIT when baseline-set timestamp is unknown (fail-safe, not fail-open), got ${unknown.decision}: ${unknown.reasons}`);

  console.log(`OK (enabled, ${env.VOLUME_DROP_GRACE_MS}ms grace): suppressed within window, fires past it, fires when timestamp unknown`);
}
