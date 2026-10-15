import assert from 'node:assert/strict';
import { auditRejectReason, parseTokenAudit } from '../logic/tokenAudit.js';

const L = { maxTopHoldersPct: 60, maxBotHoldersPct: 30, minGlobalFeesSol: 30 };
// Agency-SOL shape (Jupiter datapi, 2026-10-15)
const agency = parseTokenAudit({ fees: 1390.3, audit: { topHoldersPercentage: 26.3, botHoldersPercentage: 9.6 } })!;
assert.deepEqual(agency, { topHoldersPct: 26.3, botHoldersPct: 9.6, globalFeesSol: 1390.3 });
assert.equal(auditRejectReason(agency, L), null);
assert.match(auditRejectReason({ ...agency, topHoldersPct: 75 }, L)!, /top holders/);
assert.match(auditRejectReason({ ...agency, botHoldersPct: 31 }, L)!, /bot holders/);
assert.match(auditRejectReason({ ...agency, globalFeesSol: 12 }, L)!, /global fees/);
assert.equal(auditRejectReason({ ...agency, topHoldersPct: 60, botHoldersPct: 30, globalFeesSol: 30 }, L), null); // boundaries pass
assert.match(auditRejectReason({ ...agency, botHoldersPct: null }, L)!, /unknown \(fail-closed\)/);
assert.equal(auditRejectReason({ topHoldersPct: null, botHoldersPct: null, globalFeesSol: null }, { maxTopHoldersPct: 0, maxBotHoldersPct: 100, minGlobalFeesSol: 0 }), null); // all disabled
assert.equal(parseTokenAudit(null), null);
assert.deepEqual(parseTokenAudit({}), { topHoldersPct: null, botHoldersPct: null, globalFeesSol: null });
console.log('checkTokenAudit ok');
