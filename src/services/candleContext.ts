import axios from 'axios';
import { logger } from '../utils/logger.js';

const OHLCV_URL = (pool: string) => `https://dlmm.datapi.meteora.ag/pools/${pool}/ohlcv`;

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EntryPriceContext {
  /** % the last close sits above the window low / below the window high (<= 0). */
  aboveLow6hPct: number;
  belowHigh6hPct: number;
  aboveLow48hPct: number;
  belowHigh48hPct: number;
  chg15mPct: number;
  chg1hPct: number;
  /** log-only pullback metrics: % the last close sits below the 1h / 4h high (<= 0), and the last 5m candle's change */
  belowHigh1hPct: number;
  belowHigh4hPct: number;
  chg5mPct: number;
  /** min low of last 3 5m candles >= min low of the 9 before them. */
  higherLow: boolean;
}

const pct = (a: number, b: number) => +((a / b - 1) * 100).toFixed(2);

/** Pure: derive the entry-context metrics from 5m (last ~6h) and 1h (last ~48h) candles, oldest first. Null if too little data. */
export function computeEntryPriceContext(c5: Candle[], c1h: Candle[]): EntryPriceContext | null {
  if (c5.length < 13 || c1h.length < 2) return null;
  const last = c5[c5.length - 1]!.close;
  const low6 = Math.min(...c5.map((c) => c.low));
  const high6 = Math.max(...c5.map((c) => c.high));
  const low48 = Math.min(low6, ...c1h.map((c) => c.low));
  const high48 = Math.max(high6, ...c1h.map((c) => c.high));
  const lows = c5.map((c) => c.low);
  const recent = Math.min(...lows.slice(-3));
  const prior = Math.min(...lows.slice(-12, -3));
  const highOf = (n: number) => Math.max(...c5.slice(-n).map((c) => c.high));
  return {
    aboveLow6hPct: pct(last, low6),
    belowHigh6hPct: pct(last, high6),
    aboveLow48hPct: pct(last, low48),
    belowHigh48hPct: pct(last, high48),
    chg15mPct: pct(last, c5[c5.length - 4]!.close),
    chg1hPct: pct(last, c5[c5.length - 13]!.close),
    belowHigh1hPct: pct(last, highOf(12)),
    belowHigh4hPct: pct(last, highOf(48)),
    chg5mPct: pct(last, c5[c5.length - 2]!.close),
    higherLow: recent >= prior,
  };
}

async function fetchCandles(pool: string, timeframe: '5m' | '1h' | '4h', hours: number): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000);
  const res = await axios.get(OHLCV_URL(pool), { params: { timeframe, start_time: end - hours * 3600, end_time: end }, timeout: 8000 });
  return (res.data?.data ?? []) as Candle[];
}

/**
 * Observability only (2026-10-09): where the entry price sits vs recent
 * lows/highs. NEVER affects the entry decision — any failure returns null.
 * Meteora OHLCV caps 5m requests at ~97 candles (8h), hence 6h/5m + 47h/1h.
 */
export async function getEntryPriceContext(pool: string): Promise<EntryPriceContext | null> {
  try {
    const [c5, c1h] = await Promise.all([fetchCandles(pool, '5m', 6), fetchCandles(pool, '1h', 47)]);
    return computeEntryPriceContext(c5, c1h);
  } catch (err) {
    logger.warn('[candleContext] failed, skipping entry price context', { pool, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Pure: % the last close sits below the highest high in the window (<= 0). Null if no candles. */
export function drawdownFromHighPct(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  const high = Math.max(...candles.map((c) => c.high));
  const last = candles[candles.length - 1]!.close;
  return high > 0 ? pct(last, high) : null;
}

/**
 * Entry GATE input (2026-10-10): how far the price has fallen from its multi-day high (4h candles; Meteora
 * returns ~85 for 14d). Added after e/acc-SOL (-92% from its 14d high) passed every other filter. Null on
 * any failure — caller fails closed.
 */
export async function getDrawdownFromHighPct(pool: string, days: number): Promise<number | null> {
  try {
    return drawdownFromHighPct(await fetchCandles(pool, '4h', days * 24));
  } catch (err) {
    logger.warn('[candleContext] drawdown fetch failed', { pool, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
