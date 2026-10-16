import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { env } from '../config/env.js';
import { memoryBlock } from '../logic/aiMemory.js';
import { buildReactManagerPrompt, buildReactScreenerPrompt, type AiCandidate, type AiPositionSnapshot, type AiRules } from '../logic/aiPrompts.js';
import { type ManagerDecision, type ScreenerDecision } from '../logic/aiDecision.js';
import { loadOutcomes } from './aiOutcomes.js';
import { checkSmartWalletsOnPool } from './smartWallets.js';
import { logger } from '../utils/logger.js';

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o).slice(0, 6000) }] });

/** Subprocess env without wallet/RPC/Telegram secrets (the agent has no shell, but never hand it secrets anyway). */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !/PRIVATE_KEY|RPC_|TELEGRAM|API_KEY|SECRET|TOKEN/i.test(k)));
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** Pure: validate the agent's submit_decision against the eligible set (same rules as the one-shot parser). */
export function validateSubmit(
  a: { action: 'deploy' | 'skip'; pool?: string; bins_below?: number; conviction?: number; reason: string },
  allowed: ReadonlySet<string>,
  minBins: number,
  maxBins: number,
  minConviction: number,
): ScreenerDecision {
  const reason = a.reason.slice(0, 600);
  if (a.action === 'skip') return { action: 'skip', reason, ...(a.conviction !== undefined ? { conviction: a.conviction } : {}) };
  if (!a.pool || !allowed.has(a.pool)) return { action: 'skip', reason: 'invalid submit: pool is not an eligible candidate' };
  if (a.conviction === undefined || a.conviction < minConviction) return { action: 'skip', reason: `conviction ${String(a.conviction)} below ${minConviction}: ${reason}`, ...(a.conviction !== undefined ? { conviction: a.conviction } : {}) };
  if (a.bins_below === undefined) return { action: 'skip', reason: 'invalid submit: bins_below missing' };
  return { action: 'deploy', pool: a.pool, bins: Math.min(maxBins, Math.max(minBins, Math.round(a.bins_below))), conviction: a.conviction, reason };
}


export async function fetchPoolDetail(pool: string): Promise<unknown> {
  try {
    const d = (await getJson(`https://dlmm.datapi.meteora.ag/pools/${pool}`)) as Record<string, unknown> & { pool_config?: { base_fee_pct?: number } };
    const end = Math.floor(Date.now() / 1000);
    let closes: number[] = [];
    try {
      const o = (await getJson(`https://dlmm.datapi.meteora.ag/pools/${pool}/ohlcv?timeframe=1h&start_time=${end - 86_400}&end_time=${end}`)) as { data?: { close?: number }[] };
      closes = (o.data ?? []).map((c) => Number(c.close)).filter(Number.isFinite);
    } catch {
      /* candles optional */
    }
    const hi = Math.max(...closes);
    const lo = Math.min(...closes);
    const last = closes[closes.length - 1];
    return {
      tvl: d.tvl,
      volume: d.volume,
      feeTvlRatio: d.fee_tvl_ratio,
      baseFeePct: d.pool_config?.base_fee_pct,
      hourlyCloses: closes.length,
      rangePct24h: closes.length && lo > 0 ? +(((hi - lo) / lo) * 100).toFixed(1) : null,
      lastCloseVsHighPct: closes.length && last !== undefined && hi > 0 ? +(((last - hi) / hi) * 100).toFixed(1) : null,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchTokenInfo(mint: string): Promise<unknown> {
  try {
    const d = (await getJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`)) as unknown;
    const list = Array.isArray(d) ? d : ((d as { assets?: unknown[] }).assets ?? []);
    const a = (list as Record<string, unknown>[]).find((x) => x.id === mint);
    if (!a) return { error: 'not found' };
    return { symbol: a.symbol, organicScore: a.organicScore, holderCount: a.holderCount, globalFeesSol: a.fees, mcap: a.mcap, audit: a.audit, bundlerStats: a.bundlerStats, launchpad: a.launchpad, stats24h: a.stats24h };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Common Agent SDK options: only our MCP server + WebSearch, no settings, no secrets in the subprocess env. */
function sdkOptions(server: ReturnType<typeof createSdkMcpServer>, toolNames: string[], system: string) {
  return {
    mcpServers: { dlmm: server },
    tools: ['WebSearch'],
    allowedTools: [...toolNames.map((n) => `mcp__dlmm__${n}`), 'WebSearch'],
    maxTurns: env.AI_REACT_MAX_TURNS,
    maxBudgetUsd: env.AI_REACT_MAX_BUDGET_USD,
    cwd: tmpdir(),
    settingSources: [] as never[],
    persistSession: false,
    systemPrompt: system,
    env: agentEnv(),
  };
}

export interface ReactResult {
  decision: ScreenerDecision;
  toolCalls: string[];
  costUsd: number | null;
  turns: number;
}

/**
 * ReAct screener: the agent drives its own tool loop (Claude Agent SDK). Execution never happens inside the loop: the agent can only
 * SUBMIT a decision, which is validated against the eligible set; the bot executes afterwards. No submit / error / timeout = skip.
 */
export async function reactScreen(candidates: AiCandidate[], capitalSol: number, recentDecisions: string[]): Promise<ReactResult> {
  const allowed = new Set(candidates.map((c) => c.pool));
  const toolCalls: string[] = [];
  let submitted: ScreenerDecision | null = null;
  const note = (n: string, a: unknown) => toolCalls.push(`${n} ${JSON.stringify(a)}`.slice(0, 160));

  const getCandidates = tool('get_candidates', 'All pools that passed the hard numeric filters right now, with their metrics, audit data and our own prior outcomes. Call this first.', {}, async () => {
    note('get_candidates', {});
    return text(candidates);
  });
  const getPoolDetail = tool('get_pool_detail', 'Meteora pool detail plus hourly price closes of the last 24h summarised (range %, distance from the 24h high). Finalists only.', { pool: z.string() }, async ({ pool }) => {
    note('get_pool_detail', { pool });
    if (!allowed.has(pool)) return text({ error: 'not an eligible candidate' });
    return text(await fetchPoolDetail(pool));
  });
  const getTokenInfo = tool('get_token_info', 'Jupiter token facts: organic score, holders, global fees, top-holder and bot-holder %, bundler stats, launchpad. Finalists only.', { mint: z.string() }, async ({ mint }) => {
    note('get_token_info', { mint });
    if (!candidates.some((c) => c.tokenMint === mint)) return text({ error: 'not an eligible candidate token' });
    return text(await fetchTokenInfo(mint));
  });
  const checkSmartWallets = tool('check_smart_wallets_on_pool', 'Which tracked smart (LP) wallets currently hold a position in this pool. A hit is a strong signal; none is neutral. Finalists only.', { pool: z.string() }, async ({ pool }) => {
    note('check_smart_wallets_on_pool', { pool });
    if (!allowed.has(pool)) return text({ error: 'not an eligible candidate' });
    return text(await checkSmartWalletsOnPool(pool));
  });
  const submitDecision = tool(
    'submit_decision',
    'Submit your final decision. Call exactly once. deploy needs pool, bins_below (35-69) and conviction (1-10, logged only); skip if only weak candidates remain.',
    { action: z.enum(['deploy', 'skip']), pool: z.string().optional(), bins_below: z.number().optional(), conviction: z.number().min(1).max(10).optional(), reason: z.string() },
    async (a) => {
      note('submit_decision', { action: a.action, pool: a.pool, conviction: a.conviction });
      if (submitted) return text({ error: 'already submitted' });
      submitted = validateSubmit(a, allowed, env.AI_MIN_BINS, env.AI_MAX_BINS, env.AI_MIN_CONVICTION);
      return text({ ok: true, recorded: submitted.action });
    },
  );
  const server = createSdkMcpServer({ name: 'dlmm', tools: [getCandidates, getPoolDetail, getTokenInfo, checkSmartWallets, submitDecision] });

  const q = query({
    prompt: buildReactScreenerPrompt(capitalSol, memoryBlock(loadOutcomes()), recentDecisions),
    options: sdkOptions(server, ['get_candidates', 'get_pool_detail', 'get_token_info', 'check_smart_wallets_on_pool', 'submit_decision'], 'You are an autonomous DLMM LP screener agent. Reply in English. Use only the provided tools. Finish by calling submit_decision.'),
  });
  let costUsd: number | null = null;
  let turns = 0;
  const timer = setTimeout(() => q.close(), env.AI_SCREEN_TIMEOUT_S * 1000);
  try {
    for await (const m of q) {
      if (m.type === 'assistant') turns++;
      if (m.type === 'result') costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    }
  } catch (err) {
    logger.warn('[ai] react screener error', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
  const decision: ScreenerDecision = submitted ?? { action: 'skip', reason: 'react agent ended without submit_decision' };
  return { decision, toolCalls, costUsd, turns };
}

/** Pure: the manager can only hold or close; anything else is hold. */
export function validateManagerSubmit(a: { action: 'hold' | 'close'; reason: string }): ManagerDecision {
  return { action: a.action === 'close' ? 'close' : 'hold', reason: a.reason.slice(0, 600) };
}

export interface ReactManageResult {
  decision: ManagerDecision;
  toolCalls: string[];
  costUsd: number | null;
  turns: number;
}

/** ReAct manager: reads the live position and may pull pool/token context, then submits hold|close. No submit / error / timeout = hold. */
export async function reactManage(snapshot: AiPositionSnapshot, rules: AiRules, recentDecisions: string[]): Promise<ReactManageResult> {
  const toolCalls: string[] = [];
  let submitted: ManagerDecision | null = null;
  const note = (n: string, a: unknown) => toolCalls.push(`${n} ${JSON.stringify(a)}`.slice(0, 160));

  const getPosition = tool('get_position', 'The live snapshot of the open position: value, profit, fees, range status, minutes out of range, token share, volume vs entry baseline, entry thesis.', {}, async () => {
    note('get_position', {});
    return text(snapshot);
  });
  const getPoolDetail = tool('get_pool_detail', 'Meteora detail for the HELD pool plus hourly price closes of the last 24h summarised.', {}, async () => {
    note('get_pool_detail', {});
    return text(await fetchPoolDetail(snapshot.pool));
  });
  const getTokenInfo = tool('get_token_info', 'Jupiter facts for the HELD token: organic score, holders, top/bot holder %, bundlers, launchpad.', {}, async () => {
    note('get_token_info', {});
    return text(await fetchTokenInfo(snapshot.tokenMint));
  });
  const submitDecision = tool('submit_decision', 'Submit your decision, exactly once: hold or close.', { action: z.enum(['hold', 'close']), reason: z.string() }, async (a) => {
    note('submit_decision', { action: a.action });
    if (submitted) return text({ error: 'already submitted' });
    submitted = validateManagerSubmit(a);
    return text({ ok: true, recorded: submitted.action });
  });
  const server = createSdkMcpServer({ name: 'dlmm', tools: [getPosition, getPoolDetail, getTokenInfo, submitDecision] });

  const q = query({
    prompt: buildReactManagerPrompt(rules, memoryBlock(loadOutcomes(), 5), recentDecisions),
    options: sdkOptions(server, ['get_position', 'get_pool_detail', 'get_token_info', 'submit_decision'], 'You are an autonomous DLMM LP position manager agent. Reply in English. Use only the provided tools. Finish by calling submit_decision.'),
  });
  let costUsd: number | null = null;
  let turns = 0;
  const timer = setTimeout(() => q.close(), env.AI_MANAGE_TIMEOUT_S * 1000);
  try {
    for await (const m of q) {
      if (m.type === 'assistant') turns++;
      if (m.type === 'result') costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    }
  } catch (err) {
    logger.warn('[ai] react manager error', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
  const decision: ManagerDecision = submitted ?? { action: 'hold', reason: 'react manager ended without submit_decision (default hold)' };
  return { decision, toolCalls, costUsd, turns };
}
