import assert from 'node:assert';
import { missingEntryData, type MeteoraPair } from '../services/meteoraScanner.js';

const full = { priceChange1hPct: 1, priceChange6hPct: 1, priceChange24hPct: 1, volumeM5Usd: 1, volumeH6Usd: 1, txCountM5: 1, buyRatio1h: 0.5 } as MeteoraPair;
assert.deepStrictEqual(missingEntryData(full), []);
assert.deepStrictEqual(missingEntryData({ ...full, txCountM5: undefined } as MeteoraPair), ['txCountM5']);
assert.ok(missingEntryData({ ...full, dexHydrationFailed: true } as MeteoraPair).includes('dexHydrationFailed'));
console.log('OK: missingEntryData fails closed on any unhydrated DexScreener field');
