import assert from 'node:assert/strict';
import { createWalletPoolLookup, fetchPoolsViaApi, smartWalletSignal, SMART_WALLET_CACHE_TTL_MS, SMART_WALLET_CONCURRENCY } from '../logic/smartWalletLookup.js';

const A = 'A'.repeat(44);
const wallets = Array.from({ length: 10 }, (_, i) => `W${i}`);
const tick = () => new Promise((r) => setTimeout(r, 5));

// --- API paging: page_size 100, follow hasNext, stop at the page cap, reject a malformed body (never "no positions")
{
  const urls: string[] = [];
  const pages = [{ pools: [{ poolAddress: 'P1' }], hasNext: true }, { pools: [{ poolAddress: 'P2' }, { poolAddress: 'P3' }], hasNext: false }];
  const pools = await fetchPoolsViaApi(A, async (u) => { urls.push(u); return pages[urls.length - 1]; });
  assert.deepEqual(pools, ['P1', 'P2', 'P3']);
  assert.match(urls[0]!, /portfolio\/open\?user=A+&page=1&page_size=100/);
  assert.match(urls[1]!, /page=2/);
  let calls = 0;
  await fetchPoolsViaApi(A, async () => { calls++; return { pools: [{ poolAddress: 'P' + calls }], hasNext: true }; }, 3);
  assert.equal(calls, 3, 'page cap');
  await assert.rejects(fetchPoolsViaApi(A, async () => ({ nope: 1 })), /malformed/);
  await assert.rejects(fetchPoolsViaApi(A, async () => { throw new Error('http 429'); }), /429/);
}

// --- lookup: API first, RPC only as fallback
{
  let api = 0, rpc = 0;
  const l = createWalletPoolLookup({ fetchApi: async () => { api++; return ['P1']; }, fetchRpc: async () => { rpc++; return ['PX']; }, now: () => 0 });
  assert.deepEqual(await l.lookup('W0'), ['P1']);
  assert.equal(api, 1); assert.equal(rpc, 0);
}
// API down -> RPC fallback result
{
  let rpc = 0;
  const l = createWalletPoolLookup({ fetchApi: async () => { throw new Error('api down'); }, fetchRpc: async () => { rpc++; return ['PX']; }, now: () => 0 });
  assert.deepEqual(await l.lookup('W0'), ['PX']);
  assert.equal(rpc, 1);
}
// both fail -> null (unknown), NOT cached as empty: the next call retries
{
  let calls = 0;
  const l = createWalletPoolLookup({ fetchApi: async () => { calls++; throw new Error('x'); }, fetchRpc: async () => { calls++; throw new Error('429'); }, now: () => 0 });
  assert.equal(await l.lookup('W0'), null);
  assert.equal(await l.lookup('W0'), null);
  assert.equal(calls, 4, 'failed lookups are retried, never cached');
}
// a genuine empty list IS cached; TTL 30 min
{
  assert.equal(SMART_WALLET_CACHE_TTL_MS, 30 * 60_000);
  let t = 0, api = 0;
  const l = createWalletPoolLookup({ fetchApi: async () => { api++; return []; }, fetchRpc: async () => [], now: () => t });
  assert.deepEqual(await l.lookup('W0'), []);
  t = SMART_WALLET_CACHE_TTL_MS - 1; await l.lookup('W0'); assert.equal(api, 1, 'still cached');
  t = SMART_WALLET_CACHE_TTL_MS; await l.lookup('W0'); assert.equal(api, 2, 'expired');
}
// concurrency cap, one batch for many wallets, order kept, one failure does not poison the rest
{
  let inflight = 0, peak = 0;
  const l = createWalletPoolLookup({
    fetchApi: async (addr) => { inflight++; peak = Math.max(peak, inflight); await tick(); inflight--; if (addr === 'W3') throw new Error('x'); return [addr]; },
    fetchRpc: async () => { throw new Error('rpc down'); },
    now: () => 0,
  });
  const res = await l.lookupMany(wallets);
  assert.ok(SMART_WALLET_CONCURRENCY >= 3 && SMART_WALLET_CONCURRENCY <= 5);
  assert.ok(peak <= SMART_WALLET_CONCURRENCY && peak > 1, `peak ${peak}`);
  assert.deepEqual(res.map((r) => r.pools), wallets.map((w) => (w === 'W3' ? null : [w])));
}
// concurrent callers for the same wallet share one in-flight lookup
{
  let api = 0;
  const l = createWalletPoolLookup({ fetchApi: async () => { api++; await tick(); return ['P']; }, fetchRpc: async () => [], now: () => 0 });
  await Promise.all([l.lookup('W0'), l.lookup('W0'), l.lookup('W0')]);
  assert.equal(api, 1);
}

// --- signal text: unknown lookups are never counted as "not in pool"
{
  assert.match(smartWalletSignal(35, 2, 0, ['a', 'b']), /2\/35 smart wallet\(s\) are in this pool: a, b — STRONG signal/);
  assert.match(smartWalletSignal(35, 0, 0, []), /^0\/35 smart wallets in this pool — neutral/);
  const partial = smartWalletSignal(35, 0, 4, []);
  assert.match(partial, /4 of 35 lookups failed/);
  assert.match(partial, /unknown/);
  assert.doesNotMatch(partial, /^0\/35 smart wallets in this pool — neutral, rely/);
}
console.log('OK: smart wallet lookup (API first, bounded concurrency, no false-empty cache)');
