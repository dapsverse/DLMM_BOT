import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

export function loadOutcomes(): OutcomeRecord[] {
  try {
    return existsSync(FILE) ? parseOutcomes(readFileSync(FILE, 'utf8')) : [];
  } catch {
    return [];
  }
}
