import assert from 'node:assert/strict';
import { fallingKnifeReject, distributionReject, lowVolumeSpikeReject, reentryCooldownMs } from '../logic/entryHardSkip.js';
import { buildReactScreenerPrompt } from '../logic/aiPrompts.js';
import { env } from '../config/env.js';

// early buyers sold is a weak supporting signal, not a hard block: off by default (unless the environment turns it on), gone from the prompt's HARD RULE, weighed softly in RISK SIGNALS
if (process.env.ENTRY_HARD_SKIP_DISTRIBUTION === undefined) assert.equal(env.ENTRY_HARD_SKIP_DISTRIBUTION, false);
const screenerPrompt = buildReactScreenerPrompt(0.9, '', []);
const hardRule = screenerPrompt.slice(screenerPrompt.indexOf('HARD RULE'), screenerPrompt.indexOf('RISK SIGNALS'));
assert.ok(hardRule.length > 0 && !/early buyer/i.test(hardRule));
assert.doesNotMatch(screenerPrompt, /early buyer already sold → SKIP/);
assert.match(screenerPrompt, /WEAK supporting signal, never the main reason to skip/);
assert.match(screenerPrompt, /early-buyer wallet addresses/);

const L = { minDrop24hPct: 50, maxSpikeRatio: 0.2 };

// rule 1: the Moustache-SOL entry (24h -67.47%, spike 0.073) is rejected
assert.match(fallingKnifeReject(-67.47, 0.073, L) ?? '', /falling knife/);
// boundary: exactly -50% rejects, -49.9% passes
assert.ok(fallingKnifeReject(-50, 0.1, L));
assert.equal(fallingKnifeReject(-49.9, 0.1, L), null);
// volume accelerating (spike >= 0.2) passes even after a big drop
assert.equal(fallingKnifeReject(-80, 0.2, L), null);
assert.equal(fallingKnifeReject(-80, 1.5, L), null);
// pumping tokens are not this rule's business
assert.equal(fallingKnifeReject(250, 0.05, L), null);
// unknown data never blocks; 0 disables
assert.equal(fallingKnifeReject(null, 0.05, L), null);
assert.equal(fallingKnifeReject(undefined, 0.05, L), null);
assert.equal(fallingKnifeReject(-90, NaN, L), null);
assert.equal(fallingKnifeReject(-90, 0.01, { ...L, minDrop24hPct: 0 }), null);

// rule 2
const intel = (kols: Record<string, unknown>, earlyBuyers: Record<string, unknown>) => ({ kols, earlyBuyers });
const selling = { net_flow_sol: -12.5, selling_kols: 4, buying_kols: 1 };
const allSold = { cohort: 20, still_holding: 0, sold: 20, still_holding_pct: 0 };
assert.match(distributionReject(intel(selling, allSold)) ?? '', /distribution/);
// only one of the two conditions -> pass
assert.equal(distributionReject(intel(selling, { cohort: 20, still_holding: 3, sold: 17, still_holding_pct: 15 })), null);
assert.equal(distributionReject(intel({ net_flow_sol: 5, selling_kols: 1, buying_kols: 3 }, allSold)), null);
// net negative but more buyers than sellers -> not distributing
assert.equal(distributionReject(intel({ net_flow_sol: -1, selling_kols: 1, buying_kols: 3 }, allSold)), null);
// empty early-buyer cohort is not "all sold"
assert.equal(distributionReject(intel(selling, { cohort: 0, still_holding: 0 })), null);
// still_holding missing: fall back to the percentage
assert.ok(distributionReject(intel(selling, { cohort: 8, still_holding_pct: 0 })));
// missing / unavailable intel is neutral
assert.equal(distributionReject(null), null);
assert.equal(distributionReject({}), null);
assert.equal(distributionReject({ kols: {}, earlyBuyers: allSold }), null);

// rule 3: low volume spike hard skip (PURR 2026-10-30 entered at 0.025x)
assert.match(lowVolumeSpikeReject(0.025, 0.15) ?? '', /low volume spike: 0\.03x < 0\.15x/);
assert.ok(lowVolumeSpikeReject(0, 0.15)); // a dead hour is the clearest case
assert.ok(lowVolumeSpikeReject(0.149, 0.15)); // just under
assert.equal(lowVolumeSpikeReject(0.15, 0.15), null); // boundary passes
assert.equal(lowVolumeSpikeReject(1.8, 0.15), null);
assert.equal(lowVolumeSpikeReject(null, 0.15), null); // unknown never blocks
assert.equal(lowVolumeSpikeReject(undefined, 0.15), null);
assert.equal(lowVolumeSpikeReject(Number.NaN, 0.15), null);
assert.equal(lowVolumeSpikeReject(0.01, 0), null); // 0 = off

// re-entry cooldown after an exit above the ladder: blacklist for the minutes, keep a longer existing blacklist, 0/negative = off
const NOW = 1_000_000_000;
assert.equal(reentryCooldownMs(undefined, NOW, 60), 3_600_000);
assert.equal(reentryCooldownMs(NOW - 1, NOW, 60), 3_600_000); // an expired entry is replaced
assert.equal(reentryCooldownMs(NOW + 30 * 60_000, NOW, 60), 3_600_000); // a shorter one is extended
assert.equal(reentryCooldownMs(NOW + 12 * 3_600_000, NOW, 60), 0); // a 12h meridian cooldown stays (never shortened)
assert.equal(reentryCooldownMs(NOW + 3_600_000, NOW, 60), 0); // exactly as long: nothing to add
assert.equal(reentryCooldownMs(undefined, NOW, 0), 0);
assert.equal(reentryCooldownMs(undefined, NOW, -5), 0);
assert.equal(reentryCooldownMs(undefined, NOW, Number.NaN), 0);

// config defaults documented in env.ts (unless the environment overrides them)
if (process.env.ENTRY_MIN_VOLUME_SPIKE_RATIO === undefined) assert.equal(env.ENTRY_MIN_VOLUME_SPIKE_RATIO, 0.15);
if (process.env.REENTRY_COOLDOWN_AFTER_OOR_ABOVE_MIN === undefined) assert.equal(env.REENTRY_COOLDOWN_AFTER_OOR_ABOVE_MIN, 60);

// screener prompt: the weaker yield figure leads, and boost + KOL net sell + no narrative outweighs one smart wallet
assert.match(screenerPrompt, /LOWER of feeTvl24hPct and feeTvl4hScaledTo24hPct/);
assert.match(screenerPrompt, /much stronger negative than one smart wallet in the pool is positive/);
assert.match(screenerPrompt, /dexBoostsActive > 0\) together with KOLs net selling/);

console.log('OK: entry hard skips (falling knife + distribution)');
