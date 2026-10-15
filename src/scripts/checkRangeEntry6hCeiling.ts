import assert from 'node:assert/strict';
import { poolRejectReasons, defaultScannerConfig, type MeteoraPair } from '../services/meteoraScanner.js';

// Build a minimal pair via the scanner's own config defaults; only the fields poolRejectReasons reads for volatility matter here.
const cfg = { ...defaultScannerConfig(new Map(), new Map()), entryStrategyMode: 'range' as const, rangeMaxVolatilityPct: 15, rangeEntryMax6hChangePct: 5 };
const base = { address: 'POOL', liquidity: '500000', trade_volume_24h: '2000000', priceChange1hPct: 1, priceChange6hPct: 12, baseFeePct: 0.5 } as unknown as MeteoraPair;

const hasEntryCeiling = (r: string[]) => r.some((x) => x.includes('ENTRY ceiling'));
const hasRangeCeiling = (r: string[]) => r.some((x) => x.includes('range ceiling'));

// entry (no skip): 12% 6h passes the old 15% ceiling but is blocked by the new 5% entry-only ceiling
let r = poolRejectReasons(base, cfg);
assert.ok(hasEntryCeiling(r));
assert.ok(!hasRangeCeiling(r));
// re-screen of a held position (skipSizingChecks): the entry-only ceiling is NOT applied
r = poolRejectReasons(base, cfg, { skipSizingChecks: true });
assert.ok(!hasEntryCeiling(r));
assert.ok(!hasRangeCeiling(r));
// held position beyond the original 15% ceiling is still rejected on re-screen (unchanged behaviour)
r = poolRejectReasons({ ...base, priceChange6hPct: -19.8 } as MeteoraPair, cfg, { skipSizingChecks: true });
assert.ok(hasRangeCeiling(r));
// calm 6h passes the entry ceiling; negative moves count by magnitude
assert.ok(!hasEntryCeiling(poolRejectReasons({ ...base, priceChange6hPct: 3 } as MeteoraPair, cfg)));
assert.ok(hasEntryCeiling(poolRejectReasons({ ...base, priceChange6hPct: -6 } as MeteoraPair, cfg)));
// unknown 6h fails closed at entry
assert.ok(hasEntryCeiling(poolRejectReasons({ ...base, priceChange6hPct: undefined } as MeteoraPair, cfg)));
// unset (default behaviour of old configs) -> no extra restriction
const old = { ...cfg, rangeEntryMax6hChangePct: undefined };
assert.ok(!hasEntryCeiling(poolRejectReasons(base, old)));
console.log('OK: 6h entry ceiling applies to fresh entries only; re-screen of held positions keeps the original 15% ceiling; unset = old behaviour');
