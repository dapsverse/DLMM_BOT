import assert from 'node:assert/strict';
import { extractPosts, fetchXNarrative, summarizeX } from '../services/xNarrative.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
// twitter241-like nested shape and twitter-api45-like flat shape in one blob
const nested = { result: { timeline: { instructions: [{ entries: [{ content: { tweet: { legacy: { full_text: 'gm $MUC is the one', favorite_count: 5, retweet_count: 2, reply_count: 1, created_at: '2026-10-19T11:30:00Z', screen_name: 'alice' } } } }] }] } } };
const flat = { timeline: [{ text: 'MUC mint 3A3q... lfg', favorites: 10, retweets: 3, replies: 0, created_at: '2026-10-19T09:00:00Z', screen_name: 'bob' }, { text: 'gm $MUC is the one', favorites: 5, retweets: 2, screen_name: 'alice' }] };
const pn = extractPosts(nested, NOW);
assert.equal(pn.length, 1);
assert.equal(pn[0]!.engagement, 8);
assert.equal(pn[0]!.ageMin, 30);
assert.equal(pn[0]!.author, 'alice');
const s = summarizeX(pn, extractPosts(flat, NOW))!;
assert.equal(s.uniqueAuthors, 2); // duplicate text deduped across the two queries
assert.equal(s.postsByTicker, 1);
assert.equal(s.postsByMint, 2);
assert.equal(s.newestPostMin, 30);
assert.equal(s.oldestPostMin, 180);
assert.match((s.samples as string[])[0]!, /@bob/); // highest engagement first
assert.equal(summarizeX([], []), null);
assert.deepEqual(extractPosts({ random: 'junk', n: 1 }, NOW), []);
assert.deepEqual(extractPosts(null, NOW), []);

async function main(): Promise<void> {
  // no key -> null, fetcher never called
  let calls = 0;
  const ok = async (): Promise<unknown> => { calls++; return flat; };
  assert.equal(await fetchXNarrative('MUC', 'm0', ok, NOW, false), null);
  assert.equal(calls, 0);
  // key + posts -> summary, cashtag and mint both queried, then cached (no extra calls)
  const v = await fetchXNarrative('MUC', 'm1', ok, NOW, true);
  assert.equal(calls, 2);
  assert.ok(v && v.postsByMint === 2);
  await fetchXNarrative('MUC', 'm1', ok, NOW + 1000, true);
  assert.equal(calls, 2);
  // 429 -> null, no throw, then blocked (no more calls) for the cooldown
  let c2 = 0;
  const bad = async (): Promise<unknown> => { c2++; throw Object.assign(new Error('rapidapi 429'), { status: 429 }); };
  assert.equal(await fetchXNarrative('MUC', 'm2', bad, NOW + 2000, true), null);
  const before = c2;
  assert.equal(await fetchXNarrative('MUC', 'm3', ok, NOW + 3000, true), null);
  assert.equal(c2, before);
  assert.equal(calls, 2);
  console.log('checkXNarrative ok');
}
void main();
