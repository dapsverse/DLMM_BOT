/** Pure summary of state/shadow-sim.jsonl (simulated entries/exits per mode). */
export interface SimEntryLine {
  type: 'sim_entry';
  id: string;
  decisionId: string;
  ts: string;
  pool: string;
  name: string | null;
  mode: 'A' | 'B';
  /** paired mode: true = the selector's pick, false = counterfactual twin; absent (old lines) = chosen */
  chosen?: boolean;
  paired?: boolean;
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

export type SimScope = 'all' | 'chosen';

/** scope 'chosen' keeps only the positions of the mode the selector picked (old unmarked lines count as chosen) */
export function summarizeSim(lines: SimLine[], scope: SimScope = 'all'): Record<'A' | 'B', SimModeStats> {
  const out = { A: empty(), B: empty() };
  const exited = new Set<string>();
  const skip = new Set<string>();
  for (const l of lines) {
    if (l.type === 'sim_exit') exited.add(l.id);
    else if (scope === 'chosen' && l.chosen === false) skip.add(l.id);
  }
  for (const l of lines) {
    if (l.type === 'sim_entry') {
      if (skip.has(l.id)) continue;
      const s = out[l.mode];
      s.entries++;
      if (!exited.has(l.id)) s.open++;
    }
  }
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.type !== 'sim_exit' || seen.has(l.id) || skip.has(l.id)) continue;
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

export interface PairStats {
  /** decisions with both twins closed */
  complete: number;
  /** decisions with at least one twin still open */
  pending: number;
  sumChosenSol: number;
  sumOtherSol: number;
  /** the selector's pick earned at least as much as the counterfactual */
  agree: number;
  /** the pair's better mode, by count (ties go to neither) */
  aBetter: number;
  bBetter: number;
  sumASol: number;
  sumBSol: number;
}

/** Apple-to-apple on the same decision: only decisions whose A and B twins both closed. */
export function summarizePairs(lines: SimLine[]): PairStats {
  const byDecision = new Map<string, { A?: { id: string; chosen: boolean }; B?: { id: string; chosen: boolean } }>();
  for (const l of lines) {
    if (l.type !== 'sim_entry' || l.paired !== true) continue;
    const g = byDecision.get(l.decisionId) ?? {};
    g[l.mode] = { id: l.id, chosen: l.chosen !== false };
    byDecision.set(l.decisionId, g);
  }
  const pnl = new Map<string, number>();
  for (const l of lines) if (l.type === 'sim_exit' && !pnl.has(l.id)) pnl.set(l.id, l.pnlSol);
  const r: PairStats = { complete: 0, pending: 0, sumChosenSol: 0, sumOtherSol: 0, agree: 0, aBetter: 0, bBetter: 0, sumASol: 0, sumBSol: 0 };
  for (const g of byDecision.values()) {
    if (!g.A || !g.B) continue;
    const a = pnl.get(g.A.id);
    const b = pnl.get(g.B.id);
    if (a === undefined || b === undefined) { r.pending++; continue; }
    r.complete++;
    r.sumASol += a;
    r.sumBSol += b;
    const [c, o] = g.A.chosen ? [a, b] : [b, a];
    r.sumChosenSol += c;
    r.sumOtherSol += o;
    if (c >= o) r.agree++;
    if (a > b) r.aBetter++;
    else if (b > a) r.bBetter++;
  }
  return r;
}
