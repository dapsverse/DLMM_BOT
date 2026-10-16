/** Short-term price structure from 5m candles, for judging a local bottom / bounce. Pure; the AI interprets, nothing here decides. */
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number; // epoch seconds
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

const pct = (a: number, b: number): number | null => (b > 0 ? +(((a - b) / b) * 100).toFixed(2) : null);

export function summarizePriceAction(candles: Candle[], nowSec: number): Record<string, unknown> | null {
  const cs = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  if (cs.length < 6) return null;
  const last = cs[cs.length - 1]!;
  const closes = cs.map((c) => c.close);
  const low = cs.reduce((m, c) => (c.low < m.low ? c : m), cs[0]!);
  const high = cs.reduce((m, c) => (c.high > m.high ? c : m), cs[0]!);
  const at = (back: number) => cs[Math.max(0, cs.length - 1 - back)]!.close;
  const lastSix = cs.slice(-6);
  const prevSix = cs.slice(-12, -6);
  const vol = (xs: Candle[]) => xs.reduce((a, c) => a + c.volume, 0);
  const lastThree = cs.slice(-3);
  const prevThree = cs.slice(-6, -3);
  return {
    candles5m: cs.length,
    windowMinutes: Math.round((last.timestamp - cs[0]!.timestamp) / 60) + 5,
    lastClose: last.close,
    lowInWindow: low.low,
    highInWindow: high.high,
    pctAboveLow: pct(last.close, low.low),
    pctBelowHigh: pct(last.close, high.high),
    minutesSinceLow: Math.max(0, Math.round((nowSec - low.timestamp) / 60)),
    minutesSinceHigh: Math.max(0, Math.round((nowSec - high.timestamp) / 60)),
    change15mPct: pct(last.close, at(3)),
    change30mPct: pct(last.close, at(6)),
    change1hPct: pct(last.close, at(12)),
    rsi14_5m: rsi(closes),
    greenOfLast6: lastSix.filter((c) => c.close > c.open).length,
    lastCandle: { greenOrRed: last.close >= last.open ? 'green' : 'red', bodyPct: pct(last.close, last.open), lowerWickPct: pct(Math.min(last.open, last.close), last.low) },
    higherLowLast30mVsPrior30m: prevSix.length ? Math.min(...lastSix.map((c) => c.low)) > Math.min(...prevSix.map((c) => c.low)) : null,
    volumeLast15mVsPrior15m: vol(prevThree) > 0 ? +(vol(lastThree) / vol(prevThree)).toFixed(2) : null,
    last12Closes5m: cs.slice(-12).map((c) => c.close),
  };
}
