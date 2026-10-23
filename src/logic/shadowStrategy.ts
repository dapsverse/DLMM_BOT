/**
 * SHADOW strategy selector: which strategy a simple, auditable trend rule WOULD pick at an entry. LOG ONLY, never used by the live entry or exits.
 *
 *   A = two-sided 50:50 bid-ask centered on the price (the classic position: `openInitialPosition` swaps TOKEN_SHARE_PCT=50% of the capital to the
 *       token, then `openPosition` BidAsk over +-computeBinRadius(binStep) bins around the active bin; classic ENTRY_STRATEGY_MODEs, see docs/claude-notes/03)
 *   B = the current SOL-only bid-ask ladder below the price, flipped to a token-only ladder above the price when price falls under the lowest bin
 *
 * Rule: six votes of -1 / 0 / +1 from 5m candles (Meteora OHLCV, the data candleContext/priceAction already use) and the DexScreener tx-count buy ratio
 * the scanner already has. The sum is the score. Trend is "down" when the score <= -SHADOW_DOWN_SCORE, "up" when >= +SHADOW_DOWN_SCORE, else "neutral".
 * Mode: B when "down", A when up/neutral. Hysteresis: once a pool was "down", it stays down until the score >= SHADOW_EXIT_SCORE (default +1), so a score
 * oscillating around the threshold does not flip the mode. Too little data -> mode "unknown" (nothing is guessed).
 *
 *   V1 chg15m   <= -SHADOW_CHG_15M_PCT => -1, >= +SHADOW_CHG_15M_PCT => +1
 *   V2 chg1h    same with SHADOW_CHG_1H_PCT
 *   V3 chg4h    same with SHADOW_CHG_4H_PCT
 *   V4 ema      EMA12 of the 5m closes, change over the last 15 min: <= -SHADOW_EMA_SLOPE_PCT => -1, >= +SHADOW_EMA_SLOPE_PCT => +1
 *   V5 pressure mean of [share of the last-1h candle volume that sits in green candles, DexScreener buyRatio1h when known]:
 *               < 0.5 - SHADOW_PRESSURE_BAND => -1, > 0.5 + SHADOW_PRESSURE_BAND => +1
 *   V6 volume   volume of the last 1h / the prior 1h. When >= SHADOW_VOL_CONFIRM_RATIO the volume CONFIRMS the 1h move: vote = sign(chg1h). Otherwise 0.
 * Pure, no imports of the wallet or the network.
 */
export interface ShadowCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ShadowParams {
  chg15mPct: number;
  chg1hPct: number;
  chg4hPct: number;
  emaSlopePct: number;
  pressureBand: number;
  volConfirmRatio: number;
  downScore: number;
  exitScore: number;
}

export interface ShadowInputs {
  candles: number;
  lastClose: number;
  chg15mPct: number;
  chg1hPct: number;
  chg4hPct: number;
  emaSlopePct: number;
  upVolShare: number | null;
  buyRatio1h: number | null;
  pressure: number | null;
  volRatio: number | null;
}

export type ShadowTrend = 'up' | 'neutral' | 'down' | 'unknown';
export interface ShadowDecision {
  mode: 'A' | 'B' | 'unknown';
  trend: ShadowTrend;
  score: number | null;
  votes: Record<string, number>;
  reasons: string[];
  inputs: ShadowInputs | null;
  /** the hysteresis state that was applied (true = the pool was "down" at the previous decision) */
  prevDown: boolean;
}

const pct = (a: number, b: number): number => (b > 0 ? (a / b - 1) * 100 : NaN);
const r2 = (x: number) => +x.toFixed(2);

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (const v of values) out.push(out.length === 0 ? v : v * k + out[out.length - 1]! * (1 - k));
  return out;
}

/** Needs >= 49 five-minute candles (4h + 1 and EMA warm-up); null otherwise. Candles may come in any order. */
export function computeShadowInputs(candlesIn: ShadowCandle[], buyRatio1h: number | null): ShadowInputs | null {
  const cs = [...candlesIn].filter((c) => Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.timestamp - b.timestamp);
  if (cs.length < 49) return null;
  const closes = cs.map((c) => c.close);
  const last = closes[closes.length - 1]!;
  const at = (back: number) => closes[closes.length - 1 - back]!;
  const e = ema(closes, 12);
  const emaSlope = pct(e[e.length - 1]!, e[e.length - 4]!);
  const lastHour = cs.slice(-12);
  const priorHour = cs.slice(-24, -12);
  const vol = (xs: ShadowCandle[]) => xs.reduce((a, c) => a + (Number.isFinite(c.volume) ? c.volume : 0), 0);
  const volLast = vol(lastHour);
  const volPrior = vol(priorHour);
  const upVol = lastHour.reduce((a, c) => a + (c.close >= c.open && Number.isFinite(c.volume) ? c.volume : 0), 0);
  const upVolShare = volLast > 0 ? upVol / volLast : null;
  const parts = [upVolShare, buyRatio1h !== null && Number.isFinite(buyRatio1h) ? buyRatio1h : null].filter((x): x is number => x !== null);
  return {
    candles: cs.length,
    lastClose: last,
    chg15mPct: r2(pct(last, at(3))),
    chg1hPct: r2(pct(last, at(12))),
    chg4hPct: r2(pct(last, at(48))),
    emaSlopePct: r2(emaSlope),
    upVolShare: upVolShare === null ? null : +upVolShare.toFixed(3),
    buyRatio1h: buyRatio1h !== null && Number.isFinite(buyRatio1h) ? +buyRatio1h.toFixed(3) : null,
    pressure: parts.length ? +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(3) : null,
    volRatio: volPrior > 0 ? +(volLast / volPrior).toFixed(2) : null,
  };
}

const vote = (x: number, thr: number): number => (!Number.isFinite(x) ? 0 : x <= -thr ? -1 : x >= thr ? 1 : 0);

export function decideShadow(inputs: ShadowInputs | null, p: ShadowParams, prevDown = false): ShadowDecision {
  if (!inputs) return { mode: 'unknown', trend: 'unknown', score: null, votes: {}, reasons: ['not enough 5m candles (need 49)'], inputs: null, prevDown };
  const votes: Record<string, number> = {
    chg15m: vote(inputs.chg15mPct, p.chg15mPct),
    chg1h: vote(inputs.chg1hPct, p.chg1hPct),
    chg4h: vote(inputs.chg4hPct, p.chg4hPct),
    ema: vote(inputs.emaSlopePct, p.emaSlopePct),
    pressure: inputs.pressure === null ? 0 : inputs.pressure < 0.5 - p.pressureBand ? -1 : inputs.pressure > 0.5 + p.pressureBand ? 1 : 0,
    volume: inputs.volRatio !== null && inputs.volRatio >= p.volConfirmRatio ? Math.sign(inputs.chg1hPct) : 0,
  };
  const score = Object.values(votes).reduce((a, b) => a + b, 0);
  const down = prevDown ? score < p.exitScore : score <= -p.downScore;
  const trend: ShadowTrend = down ? 'down' : score >= p.downScore ? 'up' : 'neutral';
  const reasons = Object.entries(votes).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v > 0 ? '+1' : '-1'}`);
  reasons.push(`score ${score} => ${trend}${prevDown ? ' (was down: exit needs score >= ' + p.exitScore + ')' : ' (down needs score <= -' + p.downScore + ')'}`);
  return { mode: down ? 'B' : 'A', trend, score, votes, reasons, inputs, prevDown };
}
