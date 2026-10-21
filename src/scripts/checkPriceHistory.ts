import assert from 'node:assert/strict';
import { summarizeHistory, type Candle } from '../logic/priceAction.js';
import { buildReactScreenerPrompt } from '../logic/aiPrompts.js';

// synthetic 24h of 5m candles shaped like mucron 2026-10-18: pump x6, dump, chop, one -40% candle
const T0 = 1_000_000;
const mk = (i: number, o: number, c: number, v = 1000): Candle => ({ open: o, close: c, high: Math.max(o, c) * 1.01, low: Math.min(o, c) * 0.99, volume: v, timestamp: T0 + i * 300 });
const cs: Candle[] = [];
let p = 1.8;
for (let i = 0; i < 40; i++) { const n = p * 1.05; cs.push(mk(i, p, n)); p = n; } // run-up ~x7
for (let i = 40; i < 50; i++) { const n = p * 0.9; cs.push(mk(i, p, n)); p = n; } // -10% candles
const n1 = p * 0.6; cs.push(mk(50, p, n1, 25_000)); p = n1; // -40% candle
for (let i = 51; i < 60; i++) { const n = p * 1.001; cs.push(mk(i, p, n)); p = n; }
const now = T0 + 60 * 300;
const h = summarizeHistory(cs, now)!;
assert.equal(h.drops10pct, 11);
assert.equal(h.drops20pct, 1);
assert.equal(h.biggest5mDropPct, -40);
assert.ok((h.maxRunUpX as number) > 6 && (h.maxRunUpX as number) < 9);
assert.ok((h.pctBelow24hHigh as number) < -75);
assert.equal(h.minutesSinceHigh24h, Math.round((now - (T0 + 39 * 300)) / 60));
assert.equal(summarizeHistory(cs.slice(0, 10), now), null); // too little history -> null, never guessed

const prompt = buildReactScreenerPrompt(0.9, '', []);
assert.match(prompt, /FALLING KNIFE/);
assert.match(prompt, /sol_ladder/);
console.log('checkPriceHistory ok');
