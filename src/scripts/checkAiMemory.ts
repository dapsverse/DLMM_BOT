import assert from 'node:assert/strict';
import { memoryBlock, parseOutcomes, priorFor, summarizeOutcomes, type OutcomeRecord } from '../logic/aiMemory.js';

const rec = (o: Partial<OutcomeRecord>): OutcomeRecord => ({ at: '2026-10-15T06:00:00Z', pool: 'P1', name: 'AAA-SOL', tokenMint: 'M1', minutesHeld: 30, depositSol: 0.3, lastValueSol: 0.3, pnlPct: 0, peakPct: 0, exitReason: 'UPSIDE_BREAK', entryConviction: 8, entryReason: 'calm', ...o });
const rs = [rec({ pnlPct: 2 }), rec({ pool: 'P2', tokenMint: 'M2', pnlPct: -10 }), rec({ pool: 'P3', tokenMint: 'M1', pnlPct: 1 }), rec({ pool: 'P4', tokenMint: 'M4', pnlPct: 0 })];

const s = summarizeOutcomes(rs);
assert.deepEqual([s.n, s.wins, s.winRatePct, s.avgPnlPct, s.worstPct], [4, 2, 50, -1.75, -10]);
assert.deepEqual(summarizeOutcomes([]), { n: 0, wins: 0, winRatePct: null, avgPnlPct: null, worstPct: null });
assert.equal(priorFor(rs, 'P1', 'M1').length, 2); // same pool (P1) and same token on another pool (P3)
assert.equal(priorFor(rs, 'PX', 'MX').length, 0);
assert.equal(priorFor(rs, 'P1', 'M1', 1).length, 1);
assert.match(memoryBlock([]), /no closed positions/);
assert.match(memoryBlock(rs), /4 closed, win rate 50%/);
assert.equal(parseOutcomes('{"pool":"a","pnlPct":1}\nnot json\n{"pool":"b","pnlPct":"x"}\n').length, 1); // corrupt/invalid lines skipped
console.log('checkAiMemory ok');
