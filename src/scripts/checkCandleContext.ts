import assert from 'node:assert/strict';
import { computeEntryPriceContext, type Candle } from '../services/candleContext.js';

const mk = (closes: number[], lowMul = 0.99, highMul = 1.01): Candle[] =>
  closes.map((c, i) => ({ timestamp: i, open: c, high: c * highMul, low: c * lowMul, close: c }));

// 5m: 20 candles, close rises 100 -> 119; 1h: 48h low 50, high 200
const c5 = mk(Array.from({ length: 20 }, (_, i) => 100 + i));
const c1h: Candle[] = [{ timestamp: 0, open: 100, high: 200, low: 50, close: 100 }, { timestamp: 1, open: 100, high: 110, low: 90, close: 110 }];
const ctx = computeEntryPriceContext(c5, c1h)!;
assert.equal(ctx.aboveLow48hPct, 138); // 119 / 50 - 1
assert.equal(ctx.belowHigh48hPct, -40.5); // 119 / 200 - 1
assert.ok(ctx.higherLow, 'rising lows => higher low');
assert.ok(ctx.chg15mPct > 0 && ctx.chg1hPct > 0);
assert.equal(computeEntryPriceContext(c5.slice(0, 5), c1h), null, 'too little data => null');
// log-only pullback metrics (1h = last 12 five-minute candles, 4h = last 48, 5m = last close vs the previous close)
assert.equal(ctx.belowHigh1hPct, -0.99); // last high 119*1.01 = 120.19 is the 1h high; close 119 -> -0.99%
assert.equal(ctx.belowHigh4hPct, -0.99);
assert.equal(ctx.chg5mPct, 0.85); // 119 / 118 - 1
{
  // 60 candles: spike to 200 at index 20 (outside the last 12, inside the last 48), then drift to 120
  const closes = [...Array.from({ length: 20 }, () => 100), 200, ...Array.from({ length: 39 }, (_, i) => 160 - i)];
  const p = computeEntryPriceContext(mk(closes, 1, 1), c1h)!;
  assert.equal(p.belowHigh1hPct, -8.27); // 122 vs the 1h high 133
  assert.equal(p.belowHigh4hPct, -39); // 122 vs the 4h high 200 (the spike is outside the 1h window)
  assert.equal(p.chg5mPct, -0.81); // 122 / 123 - 1
}
console.log('OK: entry price context metrics + null on thin data');

// drawdownFromHighPct: -92% case (e/acc-SOL 2026-10-10), healthy case, empty input.
{
  const { drawdownFromHighPct } = await import('../services/candleContext.js');
  const c = (high: number, close: number) => ({ timestamp: 0, open: close, high, low: close, close });
  assert.strictEqual(drawdownFromHighPct([c(100, 90), c(23, 8)]), -92);
  assert.strictEqual(drawdownFromHighPct([c(100, 90), c(100, 80)]), -20);
  assert.strictEqual(drawdownFromHighPct([]), null);
}
