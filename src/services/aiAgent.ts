import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { env } from '../config/env.js';
import { parseManagerDecision, parseScreenerDecision, type ManagerDecision, type ScreenerDecision } from '../logic/aiDecision.js';
import { buildManagerPrompt, buildScreenerPrompt, type AiCandidate, type AiPositionSnapshot, type AiRules } from '../logic/aiPrompts.js';
import { memoryBlock } from '../logic/aiMemory.js';
import { flipPromptInfo } from '../logic/flip.js';
import { loadOutcomes } from './aiOutcomes.js';
import { reactManage, reactScreen } from './aiReact.js';
import { logger } from '../utils/logger.js';

const DECISION_LOG = 'logs/ai-decisions.jsonl';

/** One `claude -p` call (no session persistence). Web tools only when asked. Rejects on non-zero exit or timeout. */
export function askClaude(prompt: string, web: boolean, timeoutMs: number): Promise<string> {
  const tools = web ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
  return new Promise((resolve, reject) => {
    const child = execFile(env.AI_CLAUDE_BIN, ['-p', ...tools, '--no-session-persistence'], { cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 2_000_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
    child.stdin?.end(prompt);
  });
}

function logDecision(kind: 'screen' | 'manage', entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(DECISION_LOG), { recursive: true });
    appendFileSync(DECISION_LOG, JSON.stringify({ at: new Date().toISOString(), kind, ...entry }) + '\n');
  } catch {
    /* best effort */
  }
}

/** Last few decisions of a kind, one short line each, to give the agent continuity. */
function recentLines(kind: 'screen' | 'manage', n: number): string[] {
  try {
    if (!existsSync(DECISION_LOG)) return [];
    return readFileSync(DECISION_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { at: string; kind: string; action?: string; pool?: string; reason?: string })
      .filter((d) => d.kind === kind)
      .slice(-n)
      .map((d) => `${d.at} ${d.action ?? '?'} ${d.pool ? d.pool.slice(0, 6) : ''} - ${(d.reason ?? '').slice(0, 160)}`);
  } catch {
    return [];
  }
}

// A skip for the same eligible set is cached so the 15s loop does not re-ask Claude.
let lastScreen: { key: string; atMs: number; decision: ScreenerDecision } | null = null;

/** Screener: pick one of the eligible candidates or skip. Any failure = skip (fail-closed). */
export async function aiScreen(candidates: AiCandidate[], capitalSol: number, nowMs = Date.now()): Promise<ScreenerDecision> {
  const key = candidates.map((c) => c.pool).sort().join(',');
  if (lastScreen && nowMs - lastScreen.atMs < env.AI_SCREEN_MIN_INTERVAL_MIN * 60_000 && lastScreen.decision.action === 'skip') {
    return lastScreen.decision;
  }
  let decision: ScreenerDecision;
  let extra: Record<string, unknown> = {};
  if (env.AI_REACT) {
    try {
      const r = await reactScreen(candidates, capitalSol, recentLines('screen', 5));
      decision = r.decision;
      extra = { react: true, turns: r.turns, costUsd: r.costUsd, tools: r.toolCalls };
    } catch (err) {
      decision = { action: 'skip', reason: `react agent failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    lastScreen = { key, atMs: Date.now(), decision };
    logDecision('screen', { candidates: candidates.map((c) => c.name), ...decision, ...extra });
    logger.info('[ai] screener decision', { ...decision, ...extra });
    return decision;
  }
  try {
    const text = await askClaude(buildScreenerPrompt(candidates, capitalSol, recentLines('screen', 5), memoryBlock(loadOutcomes()), flipPromptInfo(env)), true, env.AI_SCREEN_TIMEOUT_S * 1000);
    decision = parseScreenerDecision(text, new Set(candidates.map((c) => c.pool)), env.AI_MIN_BINS, env.AI_MAX_BINS, env.AI_MIN_CONVICTION, { minConviction: env.TOKEN_SPOT_MIN_CONVICTION, minBins: env.TOKEN_SPOT_MIN_BINS });
  } catch (err) {
    decision = { action: 'skip', reason: `claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  lastScreen = { key, atMs: Date.now(), decision };
  logDecision('screen', { candidates: candidates.map((c) => c.name), ...decision });
  logger.info('[ai] screener decision', decision);
  return decision;
}

/** Manager: hold or close. Any failure = hold (the automatic exits keep protecting the position). */
export async function aiManage(snapshot: AiPositionSnapshot, rules: AiRules): Promise<ManagerDecision> {
  let decision: ManagerDecision;
  if (env.AI_REACT_MANAGER) {
    let extra: Record<string, unknown> = {};
    try {
      const r = await reactManage(snapshot, rules, recentLines('manage', 5));
      decision = r.decision;
      extra = { react: true, turns: r.turns, costUsd: r.costUsd, tools: r.toolCalls };
    } catch (err) {
      decision = { action: 'hold', reason: `react manager failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    logDecision('manage', { pool: snapshot.pool, valueSol: snapshot.valueSol, profitPct: snapshot.profitPct, ...decision, ...extra });
    logger.info('[ai] manager decision', { pool: snapshot.pool, ...decision, ...extra });
    return decision;
  }
  try {
    const text = await askClaude(buildManagerPrompt(snapshot, rules, recentLines('manage', 5), memoryBlock(loadOutcomes(), 5), flipPromptInfo(env)), false, env.AI_MANAGE_TIMEOUT_S * 1000);
    decision = parseManagerDecision(text);
  } catch (err) {
    decision = { action: 'hold', reason: `claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  logDecision('manage', { pool: snapshot.pool, valueSol: snapshot.valueSol, profitPct: snapshot.profitPct, ...decision });
  logger.info('[ai] manager decision', { pool: snapshot.pool, ...decision });
  return decision;
}
