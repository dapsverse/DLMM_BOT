import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseOutcomes, type OutcomeRecord } from '../logic/aiMemory.js';

const FILE = 'state/ai-outcomes.jsonl';

export function recordOutcome(r: OutcomeRecord): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(r) + '\n');
  } catch {
    /* best effort */
  }
}

/**
 * Fills the realized PnL of the LATEST outcome line of `pool` that has none (written while a swap-back was still pending). Pure on the JSONL text:
 * returns the new text, or null when no such line exists (nothing to change). Other lines are kept byte for byte.
 */
export function patchLatestOutcome(jsonl: string, pool: string, patch: { realizedPnlSol: number; realizedPnlPct: number }): string | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.pool !== pool) continue;
    if (typeof o.realizedPnlSol === 'number') return null; // the latest exit of this pool is already measured
    lines[i] = JSON.stringify({ ...o, realizedPnlSol: +patch.realizedPnlSol.toFixed(5), realizedPnlPct: +patch.realizedPnlPct.toFixed(2), realizedAfterSwapBack: true });
    return lines.join('\n');
  }
  return null;
}

/** Writes the completed realized PnL into state/ai-outcomes.jsonl (temp file + rename, so a crash never leaves a half-written file). Best effort. */
export function completeOutcomeRealized(pool: string, patch: { realizedPnlSol: number; realizedPnlPct: number }): boolean {
  try {
    if (!existsSync(FILE)) return false;
    const next = patchLatestOutcome(readFileSync(FILE, 'utf8'), pool, patch);
    if (next === null) return false;
    writeFileSync(`${FILE}.tmp`, next);
    renameSync(`${FILE}.tmp`, FILE);
    return true;
  } catch {
    return false;
  }
}

export function loadOutcomes(): OutcomeRecord[] {
  try {
    return existsSync(FILE) ? parseOutcomes(readFileSync(FILE, 'utf8')) : [];
  } catch {
    return [];
  }
}
