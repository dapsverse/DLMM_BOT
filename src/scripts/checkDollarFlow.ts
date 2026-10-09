/**
 * Self-check for classifyDollarFlow (flowAnalysis.ts) — added 2026-10-08
 * after the user noticed HIGGS-SOL's tx-count buy ratio looked healthy
 * (buys actually outnumbered sells at every window) while its price fell
 * hard the whole time. MeteoraPair.buyRatio1h counts TRANSACTIONS, not
 * dollars — blind to "many small buys vs a few large sells" distribution.
 * This classifies raw SOL-reserve balance deltas (positive = buy, negative
 * = sell) into a dollar-weighted buy/sell split instead.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkDollarFlow.ts`.
 */
import assert from 'node:assert';
import { classifyDollarFlow, MIN_DOLLAR_FLOW_SAMPLE_SIZE } from '../services/flowAnalysis.js';

const solPrice = 100; // $100/SOL, round number for easy arithmetic

// The exact scenario this was built for: tx COUNT favors buys (6 buys vs
// 4 sells) but the sells are much BIGGER in SOL terms — dollar-weighted
// ratio should correctly read as sell-dominant despite the count favoring buys.
{
  const deltas = [
    1, 1, 1, 1, 1, 1, // 6 tiny buys, 1 lamport each (+ = SOL in = buy)
    -1_000_000_000, -1_000_000_000, -1_000_000_000, -1_000_000_000, // 4 huge sells, 1 SOL each (- = SOL out = sell)
  ];
  const result = classifyDollarFlow(deltas, solPrice);
  assert(result !== null, 'expected a result for non-empty deltas');
  assert(result.buyRatioUsd < 0.5, `expected sell-dominant $ ratio despite buy-dominant tx count, got ${result.buyRatioUsd}`);
  assert(result.sellVolumeUsd > result.buyVolumeUsd, 'expected sell $ volume to dwarf buy $ volume');
}

// Symmetric case: a few big buys vs many tiny sells should read as buy-dominant.
{
  const deltas = [2_000_000_000, 2_000_000_000, -1, -1, -1, -1, -1, -1];
  const result = classifyDollarFlow(deltas, solPrice);
  assert(result !== null);
  assert(result.buyRatioUsd > 0.5, `expected buy-dominant $ ratio, got ${result.buyRatioUsd}`);
}

// Zero deltas (no real balance change, e.g. unrelated instructions in the tx) are ignored, not counted as either side.
{
  const deltas = [0, 0, 1_000_000_000, -500_000_000, 100, -100, 200]; // 5 non-zero + 2 zero
  const result = classifyDollarFlow(deltas, solPrice);
  assert(result !== null);
  assert.strictEqual(result.txSampled, 5, 'expected zero-deltas to be excluded from the sampled count');
}

// Empty / all-zero input -> null (unknown, don't block — same policy as the rest of the screen).
{
  assert.strictEqual(classifyDollarFlow([], solPrice), null, 'expected empty input to return null');
  assert.strictEqual(classifyDollarFlow([0, 0, 0], solPrice), null, 'expected all-zero input to return null');
}

// Dollar values scale correctly with solPrice.
{
  const result = classifyDollarFlow([1_000_000_000, 1, 1, 1, 1], 250); // 1 SOL buy @ $250 + 4 dust buys to clear the sample floor
  assert(result !== null);
  assert.strictEqual(result.buyVolumeUsd, 250 + (4 / 1e9) * 250, `expected 1 SOL @ $250 to value at ~$250, got ${result.buyVolumeUsd}`);
}

// Found live 2026-10-08 (BATON-SOL): a single $3.08 sample produced a
// 100% sell-dominant read and triggered a real exit on a healthy position.
// Below MIN_DOLLAR_FLOW_SAMPLE_SIZE, treat as unknown instead of acting.
{
  const tooFewDeltas = Array(MIN_DOLLAR_FLOW_SAMPLE_SIZE - 1).fill(-1_000_000_000); // all sells, but too few samples
  assert.strictEqual(
    classifyDollarFlow(tooFewDeltas, solPrice),
    null,
    `expected fewer than ${MIN_DOLLAR_FLOW_SAMPLE_SIZE} samples to return null regardless of how lopsided they look — the exact BATON-SOL incident (txSampled:1, 100% sell) this guard fixes`,
  );
  const justEnoughDeltas = Array(MIN_DOLLAR_FLOW_SAMPLE_SIZE).fill(-1_000_000_000);
  assert(classifyDollarFlow(justEnoughDeltas, solPrice) !== null, `expected exactly ${MIN_DOLLAR_FLOW_SAMPLE_SIZE} samples to be enough to act on`);
}

console.log('OK: classifyDollarFlow correctly weights by $ size (not tx count) — catches a few large sells outweighing many small buys, and vice versa');
