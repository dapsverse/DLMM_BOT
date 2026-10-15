import assert from 'node:assert/strict';
import { meridianPoolReject, type MeridianLimits } from '../logic/meridianFilter.js';

const L: MeridianLimits = { minMcapUsd: 150_000, maxMcapUsd: 10_000_000, minTvlUsd: 10_000, maxTvlUsd: 150_000, minBinStep: 80, maxBinStep: 125, minHolders: 500 };
const ok = { tvlUsd: 80_000, binStep: 100, mcapUsd: 2_000_000, holders: 900 };
assert.equal(meridianPoolReject(ok, L), null);
assert.equal(meridianPoolReject({ ...ok, tvlUsd: 10_000, mcapUsd: 150_000, binStep: 80, holders: 500 }, L), null); // lower boundaries pass
assert.equal(meridianPoolReject({ ...ok, tvlUsd: 150_000, mcapUsd: 10_000_000, binStep: 125 }, L), null); // upper boundaries pass
assert.match(meridianPoolReject({ ...ok, mcapUsd: 50_000 }, L)!, /mcap/);
assert.match(meridianPoolReject({ ...ok, mcapUsd: 20_000_000 }, L)!, /mcap/);
assert.match(meridianPoolReject({ ...ok, tvlUsd: 695_000 }, L)!, /TVL/); // SI-SOL size: too deep for this mode
assert.match(meridianPoolReject({ ...ok, tvlUsd: 5_000 }, L)!, /TVL/);
assert.match(meridianPoolReject({ ...ok, binStep: 50 }, L)!, /bin step/);
assert.match(meridianPoolReject({ ...ok, binStep: 200 }, L)!, /bin step/);
assert.match(meridianPoolReject({ ...ok, holders: 499 }, L)!, /holders/);
assert.match(meridianPoolReject({ ...ok, holders: NaN }, L)!, /fail-closed/);
console.log('checkMeridianFilter ok');
