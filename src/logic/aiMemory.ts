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
  /** last health-check PnL before the exit (net of the estimated exit cost since 2026-10-18; older records: gross) */
  pnlPct: number;
  /** wallet-measured result (received - spent, see logic/realizedPnl.ts); absent when the entry/exit was not measured reliably */
  realizedPnlPct?: number;
  realizedPnlSol?: number;
  peakPct: number;
  exitReason: string;
  entryConviction: number | null;
  entryReason: string | null;
  strategy?: 'sol_ladder' | 'token_spot' | 'bid_ask_flip';
}

/** The result to learn from: the realized wallet result when present and consistent with the snapshot (within 5 points, else a stale balance read), otherwise the snapshot. */
export function outcomePct(r: OutcomeRecord): number {
  if (r.realizedPnlPct === undefined || Math.abs(r.realizedPnlPct - r.pnlPct) > 5) return r.pnlPct;
  return r.realizedPnlPct;
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
  const wins = rs.filter((r) => outcomePct(r) > 0).length;
  const sum = rs.reduce((s, r) => s + outcomePct(r), 0);
  return {
    n: rs.length,
    wins,
    winRatePct: +((wins / rs.length) * 100).toFixed(0),
    avgPnlPct: +(sum / rs.length).toFixed(2),
    worstPct: +Math.min(...rs.map(outcomePct)).toFixed(2),
  };
}

export const outcomeLine = (r: OutcomeRecord): string =>
  `${r.at.slice(0, 16)} ${r.name ?? r.pool.slice(0, 6)} held ${r.minutesHeld ?? '?'}min pnl ${outcomePct(r).toFixed(2)}% (peak ${r.peakPct.toFixed(2)}%) exit ${r.exitReason}${r.entryConviction != null ? ` entry-conviction ${r.entryConviction}` : ''}`;

/** Prior outcomes on the same pool or the same token (a token can have several pools), newest last. */
export function priorFor(rs: readonly OutcomeRecord[], pool: string, tokenMint: string, limit = 3): OutcomeRecord[] {
  return rs.filter((r) => r.pool === pool || r.tokenMint === tokenMint).slice(-limit);
}

/** Prompt block with overall stats and the latest outcomes; empty string when there is no history yet. */
export function memoryBlock(rs: readonly OutcomeRecord[], lastN = 8): string {
  if (rs.length === 0) return 'PERFORMANCE MEMORY: no closed positions yet (no track record: stay conservative).';
  const s = summarizeOutcomes(rs);
  return [
    `PERFORMANCE MEMORY (own closed positions, pnl = wallet-measured result after exit swap friction and gas when available, else the last value seen before exit minus an exit-cost estimate): ${s.n} closed, win rate ${s.winRatePct}%, avg pnl ${s.avgPnlPct}%, worst ${s.worstPct}%.`,
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
