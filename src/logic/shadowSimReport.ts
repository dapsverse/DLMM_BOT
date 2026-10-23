/** Pure summary of state/shadow-sim.jsonl (simulated entries/exits per mode). */
export interface SimEntryLine {
  type: 'sim_entry';
  id: string;
  decisionId: string;
  ts: string;
  pool: string;
  name: string | null;
  mode: 'A' | 'B';
  price: number;
  capitalSol: number;
}

export interface SimExitLine {
  type: 'sim_exit';
  id: string;
  ts: string;
  pool: string;
  mode: 'A' | 'B';
  price: number;
  reason: string;
  pnlSol: number;
  pnlUsd: number | null;
  pnlPct: number;
  minutesHeld: number;
  flipped: boolean;
}

export type SimLine = SimEntryLine | SimExitLine;

export interface SimModeStats {
  entries: number;
  open: number;
  closed: number;
  wins: number;
  sumPnlSol: number;
  sumPnlUsd: number;
  sumMinutes: number;
  flipped: number;
  reasons: Record<string, number>;
}

const empty = (): SimModeStats => ({ entries: 0, open: 0, closed: 0, wins: 0, sumPnlSol: 0, sumPnlUsd: 0, sumMinutes: 0, flipped: 0, reasons: {} });
/** the text before the first ':' is the reason kind ("stop loss", "take profit", ...) */
export const reasonKind = (r: string): string => r.split(':')[0]!.replace(/\s+\d.*$/, '').trim();

export function summarizeSim(lines: SimLine[]): Record<'A' | 'B', SimModeStats> {
  const out = { A: empty(), B: empty() };
  const exited = new Set<string>();
  for (const l of lines) if (l.type === 'sim_exit') exited.add(l.id);
  for (const l of lines) {
    if (l.type === 'sim_entry') {
      const s = out[l.mode];
      s.entries++;
      if (!exited.has(l.id)) s.open++;
    }
  }
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.type !== 'sim_exit' || seen.has(l.id)) continue;
    seen.add(l.id);
    const s = out[l.mode];
    s.closed++;
    if (l.pnlSol > 0) s.wins++;
    s.sumPnlSol += l.pnlSol;
    s.sumPnlUsd += l.pnlUsd ?? 0;
    s.sumMinutes += l.minutesHeld;
    if (l.flipped) s.flipped++;
    const k = reasonKind(l.reason);
    s.reasons[k] = (s.reasons[k] ?? 0) + 1;
  }
  return out;
}
