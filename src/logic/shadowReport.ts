/** Pure summary of state/shadow-strategy.jsonl lines: shadow-vs-real agreement and PnL of the REAL strategy grouped by the shadow mode. */
export interface ShadowDecisionLine {
  type: 'decision';
  id: string;
  ts: string;
  pool: string;
  name?: string | null;
  mode: 'A' | 'B' | 'unknown';
  trend: string;
  score: number | null;
}

export interface ShadowOutcomeLine {
  type: 'outcome';
  decisionId: string | null;
  ts: string;
  pool: string;
  /** the strategy that really ran: sol_ladder | bid_ask_flip | token_spot */
  realStrategy: string;
  /** the real strategy expressed in the shadow vocabulary: every live ladder (and its flip) is B, token_spot is C */
  realMode: 'B' | 'C';
  realizedPnlSol: number | null;
  realizedPnlUsd: number | null;
  realizedPnlPct: number | null;
  exitReason?: string;
}

export type ShadowLine = ShadowDecisionLine | ShadowOutcomeLine;

export interface ModeStats {
  decisions: number;
  withOutcome: number;
  wins: number;
  sumPnlSol: number;
  sumPnlUsd: number;
}

export interface ShadowSummary {
  decisions: number;
  byMode: Record<'A' | 'B' | 'unknown', ModeStats>;
  unlinkedOutcomes: number;
  /** decisions with an outcome whose shadow mode is A or B: how many the real strategy "agreed" with (real is B: agrees when shadow = B) */
  comparable: number;
  agree: number;
}

const empty = (): ModeStats => ({ decisions: 0, withOutcome: 0, wins: 0, sumPnlSol: 0, sumPnlUsd: 0 });

export function summarizeShadow(lines: ShadowLine[]): ShadowSummary {
  const byMode = { A: empty(), B: empty(), unknown: empty() };
  const decisions = new Map<string, ShadowDecisionLine>();
  for (const l of lines) {
    if (l.type === 'decision') {
      decisions.set(l.id, l);
      byMode[l.mode].decisions++;
    }
  }
  let unlinked = 0;
  let comparable = 0;
  let agree = 0;
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.type !== 'outcome') continue;
    const d = l.decisionId ? decisions.get(l.decisionId) : undefined;
    if (!d || seen.has(d.id)) {
      unlinked++;
      continue;
    }
    seen.add(d.id);
    const s = byMode[d.mode];
    s.withOutcome++;
    if ((l.realizedPnlSol ?? 0) > 0) s.wins++;
    s.sumPnlSol += l.realizedPnlSol ?? 0;
    s.sumPnlUsd += l.realizedPnlUsd ?? 0;
    if (d.mode !== 'unknown') {
      comparable++;
      if (d.mode === l.realMode) agree++;
    }
  }
  return { decisions: decisions.size, byMode, unlinkedOutcomes: unlinked, comparable, agree };
}
