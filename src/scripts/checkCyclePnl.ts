import assert from 'node:assert/strict';
import { cycleView } from '../logic/cyclePnl.js';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// flipped: Meteora sees only the NEW position (deposit 0.2034, PnL +0.0086 = +4.21%), but the cycle started at 0.30 SOL and banked 0.06 SOL at the flip
const flipped = cycleView(0.21, 0.002, 0.2034, 0.0086, 4.21, { initialDepositSol: 0.3, flipPhase: true, bankedSol: 0.06 });
assert.equal(flipped.flipped, true);
near(flipped.depositSol, 0.3);
near(flipped.bankedSol, 0.06);
near(flipped.pnlSol, 0.21 + 0.002 + 0.06 - 0.3); // -0.028
near(flipped.pnlPct, ((0.21 + 0.002 + 0.06 - 0.3) / 0.3) * 100);
assert.ok(flipped.pnlSol < 0 && flipped.pnlPct < -9, 'a flip must not erase the loss of the ladder phase');
near(flipped.totalValueSol, 0.21 + 0.002 + 0.06); // position + fees + banked

// flipped and recovered: the banked SOL counts as value, so the cycle can be positive even when the new position alone looks worse
const up = cycleView(0.25, 0.01, 0.2, -0.04, -16, { initialDepositSol: 0.3, flipPhase: true, bankedSol: 0.06 });
near(up.pnlSol, 0.25 + 0.01 + 0.06 - 0.3);
assert.ok(up.pnlSol > 0);

// non-flip position: Meteora's own numbers, untouched
const plain = cycleView(0.27, 0.001, 0.2709, 0.0001, 0.037, null);
assert.equal(plain.flipped, false);
near(plain.depositSol, 0.2709);
near(plain.pnlSol, 0.0001);
near(plain.pnlPct, 0.037);
near(plain.bankedSol, 0);
near(plain.totalValueSol, 0.27 + 0.001);

// state present but not in flip phase (basis ignored), or unusable basis: fall back to Meteora
assert.equal(cycleView(0.27, 0, 0.27, 0, 0, { initialDepositSol: 0.3, flipPhase: false, bankedSol: 0.06 }).flipped, false);
assert.equal(cycleView(0.27, 0, 0.27, 0, 0, { initialDepositSol: 0, flipPhase: true, bankedSol: 0.06 }).flipped, false);
assert.equal(cycleView(0.27, 0, 0.27, 0, 0, undefined).flipped, false);

// missing bankedSol in a flipped state counts as 0 instead of NaN
const noBank = cycleView(0.2, 0.01, 0.2, 0, 0, { initialDepositSol: 0.3, flipPhase: true });
near(noBank.bankedSol, 0);
near(noBank.pnlSol, 0.2 + 0.01 - 0.3);

console.log('checkCyclePnl ok');
