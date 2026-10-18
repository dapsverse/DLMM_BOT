import assert from 'node:assert/strict';
import { estimateExitCostSol, realizedPnl, sanitizeSpent } from '../logic/realizedPnl.js';
import { pnlBasisSol } from '../logic/flip.js';
import { outcomePct, summarizeOutcomes, type OutcomeRecord } from '../logic/aiMemory.js';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// estimated cost of selling the token side at the exit
near(estimateExitCostSol(0.3, 1, 0.0005), 0.0035);
near(estimateExitCostSol(0, 1, 0.0005), 0.0005); // all-SOL position: gas only
near(estimateExitCostSol(-1, 1, 0.0005), 0.0005); // never a negative token value

// decision PnL basis is net of the exit cost and counts the banked SOL
near(pnlBasisSol(0.8, 0.02, 0.2, true, 0.01), 1.01);
near(pnlBasisSol(0.8, 0.02, 0.2, true), 1.02);

// realized = received - spent (+ banked); rent cancels because it is inside both legs
const r = realizedPnl(0.95, 0.96, 0, 0.94)!;
near(r.pnlSol, 0.01);
near(r.pnlPct, (0.01 / 0.94) * 100);
near(realizedPnl(0.95, 0.8, 0.2, 0.94)!.pnlSol, 0.05); // flip: banked SOL added
assert.equal(realizedPnl(undefined, 0.96, 0, 0.94), null); // entry not measured (boot rebuild)
assert.equal(realizedPnl(0.95, null, 0, 0.94), null); // swap-back pending: proceeds incomplete
assert.equal(realizedPnl(0.95, 0.96, 0, 0), null);

// an entry balance read that was stale (spent far below the capital) or absurdly high is dropped
assert.equal(sanitizeSpent(0.95, 0.94), 0.95);
assert.equal(sanitizeSpent(0.001, 0.94), undefined);
assert.equal(sanitizeSpent(2, 0.94), undefined);

// outcome memory prefers the realized result, falls back to the snapshot, and ignores a suspect gap
const base: OutcomeRecord = { at: 't', pool: 'p', name: 'X', tokenMint: 'm', minutesHeld: 5, depositSol: 1, lastValueSol: 1, pnlPct: 1, peakPct: 1, exitReason: 'x', entryConviction: null, entryReason: null };
assert.equal(outcomePct(base), 1);
assert.equal(outcomePct({ ...base, realizedPnlPct: -0.5 }), -0.5);
assert.equal(outcomePct({ ...base, realizedPnlPct: -20 }), 1); // > 5 points from the snapshot: stale balance read, not trusted
const s = summarizeOutcomes([{ ...base, realizedPnlPct: -0.5 }, { ...base, pnlPct: 2 }]);
assert.equal(s.wins, 1);
assert.equal(s.avgPnlPct, 0.75);

console.log('checkRealizedPnl ok');
