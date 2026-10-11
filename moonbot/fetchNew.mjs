// Unbiased new-pool universe: ALL SOL-quoted pools created in the last N days (sorted by pool_created_at, not by current volume).
// Usage: node moonbot/fetchNew.mjs [days=13] [--list-only]
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
const API = 'https://dlmm.datapi.meteora.ag', H = { 'User-Agent': 'Mozilla/5.0' };
const days = +(process.argv[2] ?? 13), listOnly = process.argv.includes('--list-only');
const WSOL = 'So11111111111111111111111111111111111111112';
const DIR = new URL('./data_new/', import.meta.url).pathname; mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: H }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch { if (i === tries - 1) return null; await sleep(600 * (i + 1)); }
  }
}
const cutoff = Date.now() - days * 86400e3, pools = new Map();
for (let page = 1; page < 400; page++) {
  const d = await get(`${API}/pools?page=${page}&page_size=100&sort_by=pool_created_at:desc`);
  if (!d?.data?.length) break;
  let old = 0;
  for (const p of d.data) {
    if (p.created_at < cutoff) { old++; continue; }
    const sol = p.token_x.address === WSOL ? p.token_y : p.token_y.address === WSOL ? p.token_x : null;
    if (sol && p.token_x.address !== p.token_y.address) pools.set(p.address, { address: p.address, name: p.name, mint: sol.address, xIsSol: p.token_x.address === WSOL, binStep: p.pool_config.bin_step, baseFeePct: p.pool_config.base_fee_pct, tvl: p.tvl, vol24: p.volume['24h'], created: p.created_at });
  }
  process.stdout.write(`\rpage ${page} sol pools ${pools.size}`);
  if (old >= 90) break;
}
console.log();
if (listOnly) process.exit(0);
const end = Math.floor(Date.now() / 1000), CH = 85 * 3600, have = new Set(readdirSync(DIR)), list = [...pools.values()];
let done = 0;
async function work(p) {
  if (have.has(p.address + '.json')) return;
  const start = Math.max(Math.floor(p.created / 1000), end - days * 86400), cs = [];
  for (let s = start; s < end; s += CH) { const d = await get(`${API}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${s}&end_time=${Math.min(s + CH, end)}`); if (d?.data) cs.push(...d.data); }
  const seen = new Set();
  const c = cs.filter((x) => !seen.has(x.timestamp) && seen.add(x.timestamp)).sort((a, b) => a.timestamp - b.timestamp).map((x) => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]);
  writeFileSync(DIR + p.address + '.json', JSON.stringify({ ...p, candles: c }));
}
const qu = [...list];
await Promise.all(Array.from({ length: 5 }, async () => { while (qu.length) { await work(qu.shift()); process.stdout.write(`\r${++done}/${list.length}`); } }));
console.log('\ndone');
