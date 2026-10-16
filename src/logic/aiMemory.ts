/** Outcome memory for the AI agent (meridian-style performance + pool memory). Pure: file I/O lives in services/aiOutcomes.ts. */

export interface OutcomeRecord {
  at: string;
  pool: string;
  name: string | null;
  tokenMint: string;
  minutesHeld: number | null;
  depositSol: number;
  /** last value seen by the health check before the exit decision: excludes exit swap friction */
  lastValueSol: number;
  pnlPct: number;
  peakPct: number;
  exitReason: string;
  entryConviction: number | null;
  entryReason: string | null;
  strategy?: 'sol_ladder' | 'token_spot';
}

export interface OutcomeSummary {
  n: number;
  wins: number;
  winRatePct: number | null;
  avgPnlPct: number | null;
  worstPct: number | null;
}

export function summarizeOutcomes(rs: readonly OutcomeRecord[]): OutcomeSummary {
  if (rs.length === 0) return { n: 0, wins: 0, winRatePct: null, avgPnlPct: null, worstPct: null };
  const wins = rs.filter((r) => r.pnlPct > 0).length;
  const sum = rs.reduce((s, r) => s + r.pnlPct, 0);
  return {
    n: rs.length,
    wins,
    winRatePct: +((wins / rs.length) * 100).toFixed(0),
    avgPnlPct: +(sum / rs.length).toFixed(2),
    worstPct: +Math.min(...rs.map((r) => r.pnlPct)).toFixed(2),
  };
}

export const outcomeLine = (r: OutcomeRecord): string =>
  `${r.at.slice(0, 16)} ${r.name ?? r.pool.slice(0, 6)} held ${r.minutesHeld ?? '?'}min pnl ${r.pnlPct.toFixed(2)}% (peak ${r.peakPct.toFixed(2)}%) exit ${r.exitReason}${r.entryConviction != null ? ` entry-conviction ${r.entryConviction}` : ''}`;

/** Prior outcomes on the same pool or the same token (a token can have several pools), newest last. */
export function priorFor(rs: readonly OutcomeRecord[], pool: string, tokenMint: string, limit = 3): OutcomeRecord[] {
  return rs.filter((r) => r.pool === pool || r.tokenMint === tokenMint).slice(-limit);
}

/** Prompt block with overall stats and the latest outcomes; empty string when there is no history yet. */
export function memoryBlock(rs: readonly OutcomeRecord[], lastN = 8): string {
  if (rs.length === 0) return 'PERFORMANCE MEMORY: no closed positions yet (no track record: stay conservative).';
  const s = summarizeOutcomes(rs);
  return [
    `PERFORMANCE MEMORY (own closed positions, pnl = last value seen before exit, excludes exit swap friction): ${s.n} closed, win rate ${s.winRatePct}%, avg pnl ${s.avgPnlPct}%, worst ${s.worstPct}%.`,
    `Latest:`,
    ...rs.slice(-lastN).map(outcomeLine),
    'Learn from these: repeat what worked, avoid what repeatedly lost.',
  ].join('\n');
}

export function parseOutcomes(jsonl: string): OutcomeRecord[] {
  const out: OutcomeRecord[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as OutcomeRecord;
      if (typeof r.pool === 'string' && typeof r.pnlPct === 'number' && Number.isFinite(r.pnlPct)) out.push(r);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}
