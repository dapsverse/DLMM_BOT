import assert from 'node:assert/strict';
import { rankRangeCandidates, rangeYieldScore, recentFeeTvl30mEq, type MeteoraPair } from '../services/meteoraScanner.js';

const pool = (address: string, o: Record<string, unknown>): MeteoraPair =>
  ({ address, feeTvlRatio24h: 10, feeTvlRatio4h: undefined, feeTvlRatio30m: undefined, trade_volume_24h: '1000', liquidity: '1000', ...o }) as unknown as MeteoraPair;

// 30m x 48 is the "now" yield; missing / non-finite / negative = unknown (null), 0 is a real dead pool
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: 0.5 })), 24);
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: 0 })), 0);
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: undefined })), null);
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: Number.NaN })), null);
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: -1 })), null);
assert.equal(recentFeeTvl30mEq(pool('a', { feeTvlRatio30m: '0.5' as unknown as number })), 24); // datapi may send numbers as strings

// score = min(24h, 4h x 6, 30m x 48); missing parts are skipped, so the old formula is the fallback
assert.equal(rangeYieldScore(pool('a', { feeTvlRatio24h: 10 })), 10); // nothing recent: 24h
assert.equal(rangeYieldScore(pool('a', { feeTvlRatio24h: 10, feeTvlRatio4h: 1 })), 6); // old formula: min(10, 6)
assert.ok(Math.abs(rangeYieldScore(pool('a', { feeTvlRatio24h: 10, feeTvlRatio4h: 1, feeTvlRatio30m: 0.05 })) - 2.4) < 1e-9); // 30m x 48 = 2.4 is the lowest
assert.equal(rangeYieldScore(pool('a', { feeTvlRatio24h: 10, feeTvlRatio4h: 1, feeTvlRatio30m: 1 })), 6); // 30m x 48 = 48 does not raise it
assert.equal(rangeYieldScore(pool('a', { feeTvlRatio24h: 10, feeTvlRatio30m: 0 })), 0); // volume dead right now
assert.equal(rangeYieldScore(pool('a', { feeTvlRatio24h: undefined as unknown as number, trade_volume_24h: '500', liquidity: '1000' })), 0.5); // old turnover fallback

// ranking: a pool whose last 30 min died drops below a steady one with a lower 24h number
const dying = pool('DYING', { feeTvlRatio24h: 20, feeTvlRatio4h: 3, feeTvlRatio30m: 0.02 }); // score 0.96
const steady = pool('STEADY', { feeTvlRatio24h: 8, feeTvlRatio4h: 1.2, feeTvlRatio30m: 0.2 }); // min(8, 7.2, 9.6) = 7.2
assert.deepEqual(rankRangeCandidates([dying, steady]).map((p) => p.address), ['STEADY', 'DYING']);
// without the 30m field the old order stands: DYING 18 (min(20, 18)) > STEADY 7.2
const dying0 = pool('DYING', { feeTvlRatio24h: 20, feeTvlRatio4h: 3 });
const steady0 = pool('STEADY', { feeTvlRatio24h: 8, feeTvlRatio4h: 1.2 });
assert.deepEqual(rankRangeCandidates([steady0, dying0]).map((p) => p.address), ['DYING', 'STEADY']);
// ranking only: it never removes a candidate
assert.equal(rankRangeCandidates([dying, steady, pool('Z', { feeTvlRatio30m: 0 })]).length, 3);
console.log('OK: yield ranking with the 30m x 48 component');
