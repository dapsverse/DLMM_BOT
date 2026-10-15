import assert from 'node:assert/strict';
import { planRatioSwap } from '../services/jupiterSwap.js';

// target 50% must reproduce the old "move half the imbalance from the heavier side" math exactly
for (const [x, y] of [[0.9, 0.1], [0.1, 0.9], [0.7, 0.3], [0.3, 0.7]] as const) {
  const old = { fromX: x > y, fraction: (Math.abs(x - y) / 2) / Math.max(x, y) };
  const plan = planRatioSwap(x, y, true, 0.5)!;
  assert.equal(plan.fromX, old.fromX);
  assert.ok(Math.abs(plan.fraction - old.fraction) < 1e-12);
}
// within 2% of target -> no swap
assert.equal(planRatioSwap(0.5, 0.5, true, 0.5), null);
assert.equal(planRatioSwap(0.36, 0.64, true, 0.35), null);
// all SOL (SOL is Y, token is X), target 35% token -> buy token with 35% of the SOL side
const buy = planRatioSwap(0, 1, true, 0.35)!;
assert.equal(buy.fromX, false);
assert.ok(Math.abs(buy.fraction - 0.35) < 1e-12);
// all token (token is X) -> sell 65% of it to reach 35% token
const sell = planRatioSwap(1, 0, true, 0.35)!;
assert.equal(sell.fromX, true);
assert.ok(Math.abs(sell.fraction - 0.65) < 1e-12);
// token is Y (SOL is X): all SOL -> buy with fromX true
const buyY = planRatioSwap(1, 0, false, 0.35)!;
assert.equal(buyY.fromX, true);
assert.ok(Math.abs(buyY.fraction - 0.35) < 1e-12);
assert.equal(planRatioSwap(0, 0, true, 0.35), null);
console.log('OK: planRatioSwap reproduces 50:50 and hits 35% targets on both sides');
