/**
 * Read-only report of the SHADOW strategy selector: state/shadow-strategy.jsonl (written by the live bot and the shadow runner, log only) and the paper
 * positions of the runner, state/shadow-sim.jsonl. Run: npx tsx src/scripts/reportShadowStrategy.ts [shadow file] [sim file]. Prints no secrets, changes nothing.
 * Part 1: agreement between what the rule would have picked (A = two-sided 50:50, B = SOL-only ladder + flip) and what really ran (live is always B/C), and the
 * real strategy's PnL grouped by shadow mode. Part 2: the simulated positions per mode: entries, exits, PnL (total, average, win rate). Small samples are noise.
 */
import { readShadowLines, shadowFile } from '../services/shadowFile.js';
import { readSimLines, simLogFile } from '../services/shadowSimStore.js';
import { summarizeShadow } from '../logic/shadowReport.js';
import { summarizeSim } from '../logic/shadowSimReport.js';

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

const simFile = process.argv[3] ?? simLogFile();
const simLines = readSimLines(simFile);
const sim = summarizeSim(simLines);
console.log(`\nsimulated positions (${simFile}): ${simLines.length} lines`);
for (const mode of ['A', 'B'] as const) {
  const m = sim[mode];
  const label = mode === 'A' ? 'A two-sided 50:50' : 'B SOL-only ladder + flip';
  const avg = m.closed ? m.sumPnlSol / m.closed : 0;
  const reasons = Object.entries(m.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  console.log(`  ${label}: ${m.entries} entries, ${m.closed} exits, ${m.open} still open${mode === 'B' ? `, ${m.flipped} of the exits had flipped` : ''}`);
  console.log(`    PnL: total ${m.sumPnlSol.toFixed(4)} SOL (~$${m.sumPnlUsd.toFixed(2)}), avg ${avg.toFixed(4)} SOL (${((avg / 1) * 100).toFixed(2)}% of 1 SOL), win rate ${m.closed ? ((m.wins / m.closed) * 100).toFixed(0) : '-'}% (${m.wins}/${m.closed}), avg held ${m.closed ? Math.round(m.sumMinutes / m.closed) : '-'} min`);
  console.log(`    exits: ${reasons}`);
}
const recent = simLines.filter((l) => l.type === 'sim_exit').slice(-5);
for (const l of recent) if (l.type === 'sim_exit') console.log(`  last exit ${l.ts.slice(5, 16).replace('T', ' ')} ${l.mode} ${l.pool.slice(0, 6)} ${l.reason.split(':')[0]} ${l.pnlSol >= 0 ? '+' : ''}${l.pnlSol.toFixed(4)} SOL`);
console.log(`note: simulated, not live: model and assumptions in logic/shadowSim.ts; USD uses the SOL price at the entry decision; n is ${sim.A.closed + sim.B.closed} closed paper positions.`);
