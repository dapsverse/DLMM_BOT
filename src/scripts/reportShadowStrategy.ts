/**
 * Read-only report of the SHADOW strategy selector (state/shadow-strategy.jsonl, written by the live bot, log only).
 * Run: npx tsx src/scripts/reportShadowStrategy.ts [file]      Prints no secrets, changes nothing.
 * Reads: agreement between what the rule would have picked (A = two-sided 50:50, B = SOL-only ladder + flip) and what really ran (always B/C live),
 * and the realized PnL of the REAL strategy grouped by the shadow mode. Small samples are noise: read the n.
 */
import { readShadowLines, shadowFile } from '../services/shadowFile.js';
import { summarizeShadow } from '../logic/shadowReport.js';

const file = process.argv[2] ?? shadowFile();
const lines = readShadowLines(file);
const s = summarizeShadow(lines);
console.log(`file ${file}: ${lines.length} lines, ${s.decisions} entry decisions, ${s.unlinkedOutcomes} outcomes without a linked decision`);
for (const mode of ['A', 'B', 'unknown'] as const) {
  const m = s.byMode[mode];
  const label = mode === 'A' ? 'A (two-sided 50:50 would be picked)' : mode === 'B' ? 'B (SOL-only ladder + flip would be picked)' : 'unknown (not enough data)';
  const avg = m.withOutcome ? m.sumPnlSol / m.withOutcome : 0;
  console.log(`  ${label}: ${m.decisions} decisions, ${m.withOutcome} closed | real strategy PnL: total ${m.sumPnlSol.toFixed(4)} SOL (~$${m.sumPnlUsd.toFixed(2)}), avg ${avg.toFixed(4)} SOL, wins ${m.wins}/${m.withOutcome}`);
}
console.log(`agreement with the real strategy (live is always B): ${s.agree}/${s.comparable}${s.comparable ? ` = ${((s.agree / s.comparable) * 100).toFixed(0)}%` : ''}`);
const a = s.byMode.A;
if (a.withOutcome > 0) console.log(`entries the rule would have sent to A but ran as B: ${a.withOutcome} closed, ${a.sumPnlSol.toFixed(4)} SOL in total. Compare with B-picked entries above before drawing any conclusion.`);
console.log(`note: n is ${s.comparable} comparable closed entries; USD uses the SOL price at the entry decision.`);
