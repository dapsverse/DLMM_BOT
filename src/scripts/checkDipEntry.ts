import assert from 'node:assert/strict';
import { dipEntryReject } from '../logic/dipEntry.js';
import { drawdownFromRecentHighPct, type Candle } from '../services/candleContext.js';
import { buildSmartWalletSnapshot, smartWalletLogFile, shouldLogSmartWallets } from '../logic/smartWalletLookup.js';
import { env } from '../config/env.js';

// gate: 10..30% below the 4h high passes, everything else is rejected with a reason, unknown data fails closed
assert.equal(dipEntryReject(-10, 10, 30), null); // boundary
assert.equal(dipEntryReject(-30, 10, 30), null); // boundary
assert.equal(dipEntryReject(-17.5, 10, 30), null);
assert.match(dipEntryReject(-9.9, 10, 30) ?? '', /no dip: 9\.9% below the 4h high, need 10-30%/);
assert.match(dipEntryReject(0, 10, 30) ?? '', /no dip/); // at the high
assert.match(dipEntryReject(-30.1, 10, 30) ?? '', /too deep: 30\.1% below the 4h high, max 30%/);
assert.match(dipEntryReject(-75, 10, 30) ?? '', /too deep/);
assert.match(dipEntryReject(null, 10, 30) ?? '', /4h high unavailable/);
assert.match(dipEntryReject(Number.NaN, 10, 30) ?? '', /4h high unavailable/);
assert.ok(env.DIP_ENTRY_MIN_PCT === 10 || process.env.DIP_ENTRY_MIN_PCT !== undefined);
assert.ok(env.DIP_ENTRY_MAX_PCT === 30 || process.env.DIP_ENTRY_MAX_PCT !== undefined);

// drawdown from the highest high of the LAST n 5m candles (n = 48 = 4h), last close vs that high
const mk = (highs: number[], close: number): Candle[] => highs.map((h, i) => ({ timestamp: i * 300, open: h, high: h, low: h * 0.9, close: i === highs.length - 1 ? close : h }));
const flat = Array.from({ length: 60 }, () => 100);
assert.equal(drawdownFromRecentHighPct(mk(flat, 80), 48, 24), -20);
// a spike OLDER than 4h (index 5 of 60) must not count
const old = flat.map((h, i) => (i === 5 ? 200 : h));
assert.equal(drawdownFromRecentHighPct(mk(old, 90), 48, 24), -10);
// a spike inside the last 4h counts
const recent = flat.map((h, i) => (i === 40 ? 200 : h));
assert.equal(drawdownFromRecentHighPct(mk(recent, 150), 48, 24), -25);
// too few candles (< minCandles) or empty: null, never a number
assert.equal(drawdownFromRecentHighPct(mk(flat.slice(0, 10), 80), 48, 24), null);
assert.equal(drawdownFromRecentHighPct([], 48, 24), null);

// smart-wallet snapshot line: pool -> wallet names, failed lookups counted, never as "holds nothing"
const snap = buildSmartWalletSnapshot(
  [
    { name: 'lp-1', pools: ['P1', 'P2'] },
    { name: 'lp-2', pools: ['P2'] },
    { name: 'lp-3', pools: null },
    { name: 'lp-4', pools: [] },
  ],
  Date.UTC(2026, 10, 1, 12, 0, 0),
);
assert.equal(snap.ts, '2026-11-01T12:00:00.000Z');
assert.equal(snap.wallets, 4);
assert.equal(snap.failed, 1);
assert.deepEqual(snap.byPool, { P1: ['lp-1'], P2: ['lp-1', 'lp-2'] });
assert.equal(smartWalletLogFile(Date.UTC(2026, 10, 1, 23, 59, 0)), 'logs/smart-wallets-2026-11-01.jsonl');
// interval: 0 = off, due only after the interval since the last snapshot
assert.equal(shouldLogSmartWallets(1_000_000, null, 30), true);
assert.equal(shouldLogSmartWallets(1_000_000, 1_000_000 - 29 * 60_000, 30), false);
assert.equal(shouldLogSmartWallets(1_000_000, 1_000_000 - 30 * 60_000, 30), true);
assert.equal(shouldLogSmartWallets(1_000_000, null, 0), false);
assert.equal(shouldLogSmartWallets(1_000_000, null, Number.NaN), false);
console.log('OK: dip entry gate, 4h-high drawdown, smart wallet snapshot');
