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
console.log('OK: entry price context metrics + null on thin data');
