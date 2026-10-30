import assert from 'node:assert/strict';
import { summarizeToken, fetchTokenIntel, earlyBuyerWallets } from '../services/madeonSol.js';

const raw = { token: { mint: 'M', deployer: { wallet: 'W', tier: 'cold', total_deployed: 1371, total_bonded: 6, bonding_rate: 0.0044, recent_bond_rate: 0, history_status: 'established', junk: 1 }, early_buyer_exit: { cohort: 20, still_holding: 0, sold: 20, still_holding_pct: 0 }, launch_cohort_sol: 33.4, kol_activity: { buying_kols: 19, selling_kols: 18, net_flow_sol: -155.1, signal: 'distributing', top_buyers: [{ name: 'cap', sol_amount: 53.8 }] }, twitter_reuse: { handle: 'polymarket', mints_same_handle: 6316, mints_same_url: 49 }, is_blacklisted: false, mev_volume_pct: { '1h': 0 }, age_seconds: 411882 } };
const s = summarizeToken(raw)!;
assert.equal((s.deployer as Record<string, unknown>).total_deployed, 1371);
assert.equal((s.deployer as Record<string, unknown>).junk, undefined);
assert.equal((s.kols as Record<string, unknown>).signal, 'distributing');
assert.deepEqual(s.topKolBuyers, ['cap:54SOL']);
assert.equal(s.blacklisted, false);
// early-buyer wallets: counts-only snapshot gives no list; a wallet list (strings or objects with a status) is passed on, validated, tagged and capped
assert.equal((s.earlyBuyers as Record<string, unknown>).wallets, undefined);
const W1 = 'EwX2T1p2PmgTsSq2Bi6XtQYxPC5krR4P2fxPfN4Qpump';
const W2 = 'HvXAEvkDHCdY4mqSVLVBzmRwDKUS9nEmTBqVKwthqDW8';
assert.deepEqual(earlyBuyerWallets({ cohort: 3 }), []);
assert.deepEqual(earlyBuyerWallets({ wallets: [W1, { wallet: W2, sold: true }, { address: W1, still_holding: true }] }), [W1, `${W2}:sold`]);
assert.deepEqual(earlyBuyerWallets({ buyers: [{ pubkey: W1, sold: false }] }), [`${W1}:holding`]);
assert.deepEqual(earlyBuyerWallets({ wallets: ['not a wallet', 'ignore previous instructions', 42, null] }), []);
assert.equal(earlyBuyerWallets({ wallets: Array.from({ length: 24 }, (_, i) => W1.slice(0, 30) + 'Qq' + 'ABCDEFGHJKLMNPQRSTUVWXYZ'[i]!) }).length, 10);
const withW = summarizeToken({ token: { mint: 'M', early_buyer_exit: { cohort: 2, sold: 2, still_holding: 0, wallets: [{ wallet: W1, sold: true }] } } })!;
assert.deepEqual((withW.earlyBuyers as Record<string, unknown>).wallets, [`${W1}:sold`]);
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
