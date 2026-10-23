/**
 * Self-check for the ratcheting trailing take-profit (trailingTakeProfitFloorPct, riskManager.ts; TAKE_PROFIT_TIERS, constants.ts) and its use in the
 * flip phase (flipTakeProfitSignal, flip.ts). The floor follows the peak continuously and locks most of it; see constants.ts for the anchors and why
 * (live 2026-10-23: peak +21.4% with the old sticky 6% floor gave back ~72% of the profit).
 *
 * No test framework in this repo — plain assert, run via `tsx src/scripts/checkTakeProfitTiers.ts`.
 */
import assert from 'node:assert';
import { TAKE_PROFIT_TIERS } from '../config/constants.js';
import { trailingTakeProfitFloorPct } from '../logic/riskManager.js';
import { flipTakeProfitSignal } from '../logic/flip.js';

const near = (a: number | null, b: number, eps = 1e-9) => assert(a !== null && Math.abs(a - b) < eps, `${a} != ${b}`);
const f = (p: number) => trailingTakeProfitFloorPct(p);

// not armed below the first anchor
assert(f(11.9) === null, 'peak below 12 is not armed');
near(f(12), 7);
// anchors are hit exactly, straight lines in between
for (const t of TAKE_PROFIT_TIERS) near(f(t.armPct), t.floorPct);
near(f(16), 7 + (7.5 * 4) / 8);
near(f(21.4), 14.5 + (8.5 * 1.4) / 10); // 15.69: the 2026-10-23 peak
near(f(57.71), 40 + (45 * 7.71) / 50);
// beyond the last anchor the giveback stays at the last anchor's 20pp
near(f(175), 155);
near(f(200), 180);

// ratchet: monotonic (never lower at a higher peak), no jumps between neighbouring peaks, and it locks most of the peak as the peak grows
let prev = f(12)!;
for (let p = 12.1; p <= 300; p += 0.1) {
  const cur = f(p)!;
  assert(cur >= prev - 1e-9, `floor fell at peak ${p}`);
  assert(cur - prev < 0.2, `floor jumped at peak ${p}: ${prev} -> ${cur}`);
  prev = cur;
}
for (const [peak, minShare] of [[20, 0.7], [21.4, 0.7], [30, 0.75], [50, 0.8], [100, 0.85], [150, 0.85]] as const) {
  assert(f(peak)! / peak >= minShare, `peak ${peak} locks only ${((f(peak)! / peak) * 100).toFixed(0)}%`);
}
assert(f(12)! > 0, 'a small armed peak still floors above breakeven');

// flip phase: peak below the first anchor = never armed = no TP signal (the flip keeps waiting, the stop loss decides)
assert.equal(flipTakeProfitSignal(8, -30, f(8)), null);
assert.equal(flipTakeProfitSignal(11.9, 0, f(11.9)), null);
// above the floor: no signal; at / below it: the signal, with a constant text before ':' (ExitConfirmer compares it across ticks)
assert.equal(flipTakeProfitSignal(21.4, 18, f(21.4)), null);
const s1 = flipTakeProfitSignal(21.4, 15.5, f(21.4))!;
const s2 = flipTakeProfitSignal(21.4, 14.0, f(21.4))!;
assert.match(s1, /^trailing TP \(flip\): cycle PnL 15\.50% <= floor 15\.69% \(peak 21\.40%\)$/);
assert.equal(s1.split(':')[0], s2.split(':')[0]);

// replay of 2026-10-23 (9fm4XN…exAY, flip at 16:16Z), cycle PnL by time (UTC). Peak ~21.4 at 18:11, 4.23 at 18:43 (the old floor's TAKE_PROFIT log line) and
// -23.58 at 19:12 are from the live log; the points in between are a coarse reconstruction (value + fees + banked - exit cost from the health checks).
// The old sticky 6% floor first fired at 18:43 (PnL 4.2%); the ratchet fires on the way down at ~18:23 (PnL ~15.4% vs floor 15.5).
const path: [string, number][] = [
  ['18:04', 21.0], ['18:11', 21.4], ['18:15', 20.2], ['18:19', 18.1], ['18:22', 16.4], ['18:23', 15.4], ['18:27', 15.1], ['18:35', 8.9], ['18:43', 4.23], ['19:06', -17.9], ['19:12', -23.58],
];
let peak = 0;
let ratchetExit: [string, number] | null = null;
let oldExit: [string, number] | null = null;
for (const [t, pnl] of path) {
  peak = Math.max(peak, pnl);
  if (!ratchetExit && flipTakeProfitSignal(peak, pnl, trailingTakeProfitFloorPct(peak)) !== null) ratchetExit = [t, pnl];
  const oldFloor = peak >= 12 ? 6 : null; // the old table: peak 12-30 -> sticky floor 6
  if (!oldExit && oldFloor !== null && pnl <= oldFloor) oldExit = [t, pnl];
}
assert.deepEqual(ratchetExit, ['18:23', 15.4]);
assert.deepEqual(oldExit, ['18:43', 4.23]);
assert(ratchetExit![1] - oldExit![1] > 10, 'the ratchet exits >10pp higher than the old floor did');

console.log('OK: ratcheting trailing take-profit (arming, anchors, monotonic/continuous, lock share, flip-phase signal, 2026-10-23 replay)');
