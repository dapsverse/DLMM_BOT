import assert from 'node:assert/strict';
import { fallingKnifeReject, distributionReject } from '../logic/entryHardSkip.js';

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

console.log('OK: entry hard skips (falling knife + distribution)');
