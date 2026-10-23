import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { computeShadowInputs, decideShadow, type ShadowCandle, type ShadowDecision, type ShadowParams } from '../logic/shadowStrategy.js';
import type { ShadowLine } from '../logic/shadowReport.js';
import { appendShadowLine as append, readShadowLines } from './shadowFile.js';

/**
 * SHADOW strategy selector I/O (see logic/shadowStrategy.ts). Everything here is observability: every function swallows its own errors and is
 * bounded by a timeout, and the entry path never awaits shadowDecision. Writes one JSON line per entry decision and one per closed position.
 */
const paramsFromEnv = (): ShadowParams => ({
  chg15mPct: env.SHADOW_CHG_15M_PCT,
  chg1hPct: env.SHADOW_CHG_1H_PCT,
  chg4hPct: env.SHADOW_CHG_4H_PCT,
  emaSlopePct: env.SHADOW_EMA_SLOPE_PCT,
  pressureBand: env.SHADOW_PRESSURE_BAND,
  volConfirmRatio: env.SHADOW_VOL_CONFIRM_RATIO,
  downScore: env.SHADOW_DOWN_SCORE,
  exitScore: env.SHADOW_EXIT_SCORE,
});

// hysteresis memory per pool (in-process only: after a restart the first decision uses the entry threshold)
const wasDown = new Map<string, boolean>();

/** 5m OHLCV of the last `hours` (Meteora caps a 5m request at about 97 candles = 8 h). Read-only. */
export async function fetchCandles5m(pool: string, timeoutMs: number, hours = 6): Promise<ShadowCandle[]> {
  const end = Math.floor(Date.now() / 1000);
  const res = await axios.get(`https://dlmm.datapi.meteora.ag/pools/${pool}/ohlcv`, { params: { timeframe: '5m', start_time: end - Math.min(hours, 8) * 3600, end_time: end }, timeout: timeoutMs });
  const rows = (res.data?.data ?? []) as Record<string, unknown>[];
  return rows.map((r) => ({ timestamp: Number(r.timestamp), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

export interface ShadowEntryInfo {
  pool: string;
  name: string | null;
  mint: string;
  binStep: number;
  buyRatio1h: number | null;
  solPriceUsd: number | null;
  aiStrategy: string;
  aiConviction: number | null;
}

/** The decision plus what the simulation needs to open a position at the decision price: the logged id/time and the start time of the last candle the price came from. */
export type LoggedShadowDecision = ShadowDecision & { id: string; ts: number; lastCandleTs: number | null };

/** Decide + log. NEVER throws and is meant to be fired without await from the entry path; resolves with the decision (or null on any failure/timeout). */
export async function shadowDecision(info: ShadowEntryInfo): Promise<LoggedShadowDecision | null> {
  if (!env.SHADOW_STRATEGY_ENABLED) return null;
  try {
    const budget = env.SHADOW_FETCH_TIMEOUT_MS;
    const candles = await Promise.race([
      fetchCandles5m(info.pool, budget),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('shadow fetch timeout')), budget + 500).unref()),
    ]);
    const prev = wasDown.get(info.pool) ?? false;
    const decision = decideShadow(computeShadowInputs(candles, info.buyRatio1h), paramsFromEnv(), prev);
    if (decision.mode !== 'unknown') wasDown.set(info.pool, decision.mode === 'B');
    const ts = Date.now();
    append({
      type: 'decision',
      id: `${info.pool}:${ts}`,
      ts: new Date(ts).toISOString(),
      pool: info.pool,
      name: info.name,
      mint: info.mint,
      binStep: info.binStep,
      priceAtDecision: decision.inputs?.lastClose ?? null,
      solPriceUsd: info.solPriceUsd,
      mode: decision.mode,
      trend: decision.trend,
      score: decision.score,
      votes: decision.votes,
      reasons: decision.reasons,
      inputs: decision.inputs,
      prevDown: decision.prevDown,
      realIntent: { aiStrategy: info.aiStrategy, aiConviction: info.aiConviction },
    });
    const lastCandleTs = candles.reduce((m, c) => (Number.isFinite(c.timestamp) && c.timestamp > m ? c.timestamp : m), 0);
    return { ...decision, id: `${info.pool}:${ts}`, ts, lastCandleTs: lastCandleTs > 0 ? lastCandleTs : null };
  } catch (err) {
    logger.warn('[shadow] decision skipped', { pool: info.pool, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface ShadowOutcomeInfo {
  pool: string;
  openedAtMs: number | undefined;
  realStrategy: string;
  flipped: boolean;
  exitReason: string;
  minutesHeld: number | null;
  depositSol: number;
  realizedPnlSol: number | null;
  realizedPnlPct: number | null;
  snapshotPnlPct: number;
  solPriceUsd?: number | null;
}

/** Link the closed position to its shadow decision (latest decision of the pool made up to a minute after the position opened) and log the real result. Never throws. */
export function shadowOutcome(o: ShadowOutcomeInfo): void {
  if (!env.SHADOW_STRATEGY_ENABLED) return;
  try {
    const lines = readShadowLines();
    let decision: Extract<ShadowLine, { type: 'decision' }> | null = null;
    let solPriceUsd = o.solPriceUsd ?? null;
    if (o.openedAtMs !== undefined) {
      for (const l of lines) {
        if (l.type !== 'decision' || l.pool !== o.pool) continue;
        const t = Date.parse(l.ts);
        if (t <= o.openedAtMs + 60_000 && t >= o.openedAtMs - 600_000) decision = l;
      }
    }
    if (decision) solPriceUsd = (decision as unknown as { solPriceUsd?: number | null }).solPriceUsd ?? solPriceUsd;
    append({
      type: 'outcome',
      decisionId: decision ? decision.id : null,
      ts: new Date().toISOString(),
      pool: o.pool,
      realStrategy: o.realStrategy,
      realMode: o.realStrategy === 'token_spot' ? 'C' : 'B',
      flipped: o.flipped,
      exitReason: o.exitReason.slice(0, 120),
      minutesHeld: o.minutesHeld,
      depositSol: o.depositSol,
      realizedPnlSol: o.realizedPnlSol,
      realizedPnlPct: o.realizedPnlPct,
      // approximation: SOL price at the entry decision, not at the close
      realizedPnlUsd: o.realizedPnlSol !== null && solPriceUsd ? +(o.realizedPnlSol * solPriceUsd).toFixed(2) : null,
      snapshotPnlPct: o.snapshotPnlPct,
    });
  } catch (err) {
    logger.warn('[shadow] outcome skipped', { pool: o.pool, error: err instanceof Error ? err.message : String(err) });
  }
}
