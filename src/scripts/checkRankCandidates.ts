/**
 * Self-check for rankCandidates (P3 + P4, meteoraScanner.ts) — the
 * 2026-09-24 ranking rewrite that shortlists by volumeSpikeRatio
 * (acceleration) instead of raw priceChange6hPct (cumulative magnitude),
 * tie-broken by buyRatio1h then priceChange24hPct. See SCREEN_RULE.MD.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkRankCandidates.ts`.
 */
import assert from 'node:assert';
import { rankCandidates, type MeteoraPair } from '../services/meteoraScanner.js';

function pair(name: string, overrides: Partial<MeteoraPair>): MeteoraPair {
  return {
    address: name,
    name,
    mint_x: 'MINT',
    mint_y: 'So11111111111111111111111111111111111111112',
    reserve_x: 'FAKE_RESERVE_X',
    reserve_y: 'FAKE_RESERVE_Y',
    liquidity: '100000',
    trade_volume_24h: 500000,
    fees_24h: 0,
    bin_step: 20,
    current_price: 1,
    createdAtMs: Date.now() - 10 * 3_600_000,
    volume1hUsd: 0,
    fees1hUsd: 0,
    baseFeePct: 1,
    feeTvlRatio24h: 1,
    tokenX: { address: 'MINT', priceUsd: 1, marketCapUsd: 0, holders: 500, freezeAuthorityDisabled: true },
    tokenY: { address: 'So11111111111111111111111111111111111111112', priceUsd: 1, marketCapUsd: 0, holders: 0, freezeAuthorityDisabled: true },
    ...overrides,
  };
}

// P3: already-topped-out pool (huge 6h gain, spike ratio cooled to ~1x)
// should rank BELOW an early-stage pool (modest 6h gain, spike ratio 3x).
const alreadyTopped = pair('ALREADY-TOPPED', {
  priceChange6hPct: 40,
  volume1hUsd: 1000, // h1
  volumeH6Usd: 5800, // (5800-1000)/5 = 960 prior pace -> spike ~1.04x, cooled
});
const earlyStage = pair('EARLY-STAGE', {
  priceChange6hPct: 5,
  volume1hUsd: 3000, // h1
  volumeH6Usd: 4000, // (4000-3000)/5 = 200 prior pace -> spike 15x, accelerating
});
const ranked1 = rankCandidates([alreadyTopped, earlyStage]);
assert.strictEqual(ranked1[0]?.name, 'EARLY-STAGE', `expected the accelerating pool to rank first, got: ${ranked1.map((p) => p.name)}`);

// Tie-break 1: same spike ratio, buyRatio1h decides — buy-dominant wins.
const sellDominant = pair('SELL-DOMINANT', { volume1hUsd: 3000, volumeH6Usd: 4000, buyRatio1h: 0.3 });
const buyDominant = pair('BUY-DOMINANT', { volume1hUsd: 3000, volumeH6Usd: 4000, buyRatio1h: 0.8 });
const ranked2 = rankCandidates([sellDominant, buyDominant]);
assert.strictEqual(ranked2[0]?.name, 'BUY-DOMINANT', `expected the buy-dominant pool to win the tie-break, got: ${ranked2.map((p) => p.name)}`);

// Tie-break 2: same spike ratio + same buyRatio1h, priceChange24hPct decides — flatter (fresher) background wins.
const staleRunner = pair('STALE-RUNNER', { volume1hUsd: 3000, volumeH6Usd: 4000, buyRatio1h: 0.6, priceChange24hPct: 300 });
const freshMove = pair('FRESH-MOVE', { volume1hUsd: 3000, volumeH6Usd: 4000, buyRatio1h: 0.6, priceChange24hPct: 8 });
const ranked3 = rankCandidates([staleRunner, freshMove]);
assert.strictEqual(ranked3[0]?.name, 'FRESH-MOVE', `expected the fresher-background pool to win the tie-break, got: ${ranked3.map((p) => p.name)}`);

console.log('OK: rankCandidates prioritizes acceleration, then buy-dominance, then freshness');
