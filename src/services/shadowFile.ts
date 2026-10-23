import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShadowLine } from '../logic/shadowReport.js';

/** File access for the shadow strategy log. No env/wallet imports, so the report script and the self-check load it standalone. */
export const shadowFile = (): string => process.env.SHADOW_FILE ?? 'state/shadow-strategy.jsonl';

/** Best-effort append of one JSON line; false on any error (never throws). */
export function appendShadowLine(line: object, file = shadowFile()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function readShadowLines(file = shadowFile()): ShadowLine[] {
  if (!existsSync(file)) return [];
  const out: ShadowLine[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as ShadowLine);
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}
