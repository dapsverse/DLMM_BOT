import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SimPosition } from '../logic/shadowSim.js';
import type { SimLine } from '../logic/shadowSimReport.js';

/** File access for the shadow simulation. No env/wallet imports, so the report script and the self-check load it standalone. Never throws. */
export const simLogFile = (): string => process.env.SHADOW_SIM_FILE ?? 'state/shadow-sim.jsonl';
export const simOpenFile = (): string => process.env.SHADOW_SIM_OPEN_FILE ?? 'state/shadow-sim-open.json';

export function appendSimLine(line: object, file = simLogFile()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function readSimLines(file = simLogFile()): SimLine[] {
  if (!existsSync(file)) return [];
  const out: SimLine[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as SimLine);
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}

export function loadOpenSims(file = simOpenFile()): SimPosition[] {
  try {
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(j) ? (j as SimPosition[]).filter((p) => p && typeof p.id === 'string' && typeof p.pool === 'string' && Array.isArray(p.solBins) && Array.isArray(p.tokBins)) : [];
  } catch {
    return [];
  }
}

/** atomic: tmp file + rename */
export function saveOpenSims(positions: SimPosition[], file = simOpenFile()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(positions));
    renameSync(file + '.tmp', file);
    return true;
  } catch {
    return false;
  }
}
