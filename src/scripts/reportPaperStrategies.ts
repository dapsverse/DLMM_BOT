/** Read-only progress report of the paper strategies (state/paper-strategies/*.jsonl). No env, no network. */
import fs from 'node:fs';

type L = Record<string, unknown> & { type?: string };
const read = (f: string): L[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((x) => { try { return JSON.parse(x) as L; } catch { return {}; } }) : []);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
for (const name of ['dipladder', 'calm', 'hotyield', 'blitz']) {
  const lines = read(`state/paper-strategies/${name}.jsonl`);
  const ex = lines.filter((l) => l.type === 'paper_exit');
  const entries = lines.filter((l) => l.type === 'paper_entry').length;
  const n = ex.length;
  const f = (k: string) => ex.map((l) => Number(l[k]) || 0);
  const wins = f('netSol').filter((x) => x > 0).length;
  const reasons: Record<string, number> = {};
  for (const l of ex) { const r = String(l.reason).split(':')[0]!.replace(/ for \d+ min/, ''); reasons[r] = (reasons[r] ?? 0) + 1; }
  console.log(`${name}: entries ${entries}, closed ${n}/30, win ${n ? ((wins / n) * 100).toFixed(0) : '-'}%, NET ${sum(f('netSol')).toFixed(4)} SOL (avg ${n ? (sum(f('netPct')) / n).toFixed(2) : '-'}%)`);
  console.log(`  fees ${sum(f('feesSol')).toFixed(4)} | value change (IL+price) ${sum(f('valueChangeSol')).toFixed(4)} | exit cost ${sum(f('exitCostSol')).toFixed(4)} | gas ${sum(f('gasSol')).toFixed(4)}`);
  console.log(`  comparators: hold SOL 0.0000 | hold same token ${sum(f('holdTokenSol')).toFixed(4)} SOL | avg hold ${n ? Math.round(sum(f('minutesHeld')) / n) : '-'} min`);
  console.log(`  exits: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
}
