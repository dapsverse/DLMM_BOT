import assert from 'node:assert/strict';
import { summarizeToken, fetchTokenIntel } from '../services/madeonSol.js';

const raw = { token: { mint: 'M', deployer: { wallet: 'W', tier: 'cold', total_deployed: 1371, total_bonded: 6, bonding_rate: 0.0044, recent_bond_rate: 0, history_status: 'established', junk: 1 }, early_buyer_exit: { cohort: 20, still_holding: 0, sold: 20, still_holding_pct: 0 }, launch_cohort_sol: 33.4, kol_activity: { buying_kols: 19, selling_kols: 18, net_flow_sol: -155.1, signal: 'distributing', top_buyers: [{ name: 'cap', sol_amount: 53.8 }] }, twitter_reuse: { handle: 'polymarket', mints_same_handle: 6316, mints_same_url: 49 }, is_blacklisted: false, mev_volume_pct: { '1h': 0 }, age_seconds: 411882 } };
const s = summarizeToken(raw)!;
assert.equal((s.deployer as Record<string, unknown>).total_deployed, 1371);
assert.equal((s.deployer as Record<string, unknown>).junk, undefined);
assert.equal((s.kols as Record<string, unknown>).signal, 'distributing');
assert.deepEqual(s.topKolBuyers, ['cap:54SOL']);
assert.equal(s.blacklisted, false);
assert.equal(summarizeToken({}), null);
assert.equal(summarizeToken(null), null);

let calls = 0;
const ok = async () => { calls++; return raw; };
(async () => {
  assert.equal(await fetchTokenIntel('A', ok, 1, false), null); // no key
  assert.equal(calls, 0);
  assert.ok(await fetchTokenIntel('A', ok, 1_000_000, true));
  await fetchTokenIntel('A', ok, 1_000_500, true); // cached
  assert.equal(calls, 1);
  const bad = async () => { throw Object.assign(new Error('x'), { status: 429 }); };
  assert.equal(await fetchTokenIntel('B', bad, 2_000_000, true), null);
  await fetchTokenIntel('C', ok, 2_000_100, true); // blocked after 429
  assert.equal(calls, 1);
  console.log('checkMadeonSol ok');
})();
