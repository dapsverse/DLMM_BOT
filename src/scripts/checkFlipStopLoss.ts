import assert from 'node:assert/strict';
import { stopLossPctFor } from '../logic/flip.js';
import { evaluatePosition, type PositionHealthInput } from '../logic/riskManager.js';
import { env } from '../config/env.js';

// ---- level choice: the flip phase uses FLIP_STOP_LOSS_PCT, every other phase STOP_LOSS_PCT; 0 (or an invalid value) = fall back to STOP_LOSS_PCT
assert.equal(stopLossPctFor(true, 25, 15), 15);
assert.equal(stopLossPctFor(false, 25, 15), 25);
assert.equal(stopLossPctFor(undefined, 25, 15), 25);
assert.equal(stopLossPctFor(true, 25, 0), 25);
assert.equal(stopLossPctFor(true, 25, Number.NaN), 25);
assert.equal(stopLossPctFor(true, 25, -5), 25);
assert.equal(stopLossPctFor(true, 25, 30), 30); // a looser flip level is honoured (explicit config)

// ---- default of the env key (unless the environment overrides it)
if (process.env.FLIP_STOP_LOSS_PCT === undefined) assert.equal(env.FLIP_STOP_LOSS_PCT, 15);

// ---- evaluatePosition: -18% loss (value 0.82 of a 1.0 deposit)
const base: PositionHealthInput = {
  initialDepositUsd: 1,
  currentValueUsd: 0.82,
  rebalanceTimestamps: [],
  volume1hNowUsd: 1000,
  volume1hBaselineUsd: 1000,
  unclaimedFeesUsd: 0,
  estimatedGasCostUsd: 0,
  peakProfitPct: 0,
};
// outside the flip phase the global level (25 by default) still applies: -18% is a HOLD
const normal = evaluatePosition({ ...base });
assert.equal(env.STOP_LOSS_PCT > 18, true, 'test assumes STOP_LOSS_PCT above 18');
assert.equal(normal.decision, 'HOLD');
// in the flip phase the same -18% hits the flip level (15), and the reason keeps the STOP_LOSS_PCT token index.ts matches on
const flip = evaluatePosition({ ...base, flipPhase: true });
assert.equal(flip.decision, 'HARD_EXIT');
assert.match(flip.reasons[0] ?? '', /unrealized loss 18\.00% >= FLIP_STOP_LOSS_PCT 15%/);
assert.ok((flip.reasons[0] ?? '').includes('STOP_LOSS_PCT'));
// -14% in the flip phase is still inside the level
assert.equal(evaluatePosition({ ...base, currentValueUsd: 0.86, flipPhase: true }).decision, 'HOLD');
// the global level still stops a normal position at -26%
assert.equal(evaluatePosition({ ...base, currentValueUsd: 0.74 }).decision, 'HARD_EXIT');
console.log('OK: flip-phase stop loss level (FLIP_STOP_LOSS_PCT) vs STOP_LOSS_PCT');
