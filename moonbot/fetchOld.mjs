// Older regime: SOL pools created between FROM and TO days ago, first SPAN days of candles after creation. Only pools with lifetime volume >= MINLIFE (a pool below it can never pass a trailing-volume filter, so no bias).
// Usage: node moonbot/fetchOld.mjs [from=14] [to=45] [span=10] [minLife=100000]
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
const API = 'https://dlmm.datapi.meteora.ag', H = { 'User-Agent': 'Mozilla/5.0' };
const FROM = +(process.argv[2] ?? 14), TO = +(process.argv[3] ?? 45), SPAN = +(process.argv[4] ?? 10), MINLIFE = +(process.argv[5] ?? 100000), listOnly = process.argv.includes('--list-only');
const WSOL = 'So11111111111111111111111111111111111111112';
const DIR = new URL('./data_old/', import.meta.url).pathname; mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: H }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch { if (i === tries - 1) return null; await sleep(600 * (i + 1)); }
  }
}
const hi = Date.now() - FROM * 86400e3, lo = Date.now() - TO * 86400e3, pools = new Map();
for (let page = 1; page < 1200; page++) {
  const d = await get(`${API}/pools?page=${page}&page_size=100&sort_by=pool_created_at:desc`);
  if (!d?.data?.length) break;
  let old = 0;
  for (const p of d.data) {
    if (p.created_at < lo) { old++; continue; }
    if (p.created_at > hi || (p.cumulative_metrics?.volume ?? 0) < MINLIFE) continue;
    const sol = p.token_x.address === WSOL ? p.token_y : p.token_y.address === WSOL ? p.token_x : null;
    if (sol && p.token_x.address !== p.token_y.address) pools.set(p.address, { address: p.address, name: p.name, mint: sol.address, xIsSol: p.token_x.address === WSOL, binStep: p.pool_config.bin_step, baseFeePct: p.pool_config.base_fee_pct, tvl: p.tvl, vol24: p.volume['24h'], created: p.created_at });
  }
  process.stdout.write(`\rpage ${page} sol pools ${pools.size}`);
  if (old >= 90) break;
}
console.log();
if (listOnly) process.exit(0);
const CH = 85 * 3600, have = new Set(readdirSync(DIR)), list = [...pools.values()];
let done = 0;
async function work(p) {
  if (have.has(p.address + '.json')) return;
  const start = Math.floor(p.created / 1000), end = Math.min(start + SPAN * 86400, Math.floor(Date.now() / 1000)), cs = [];
  for (let s = start; s < end; s += CH) { const d = await get(`${API}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${s}&end_time=${Math.min(s + CH, end)}`); if (d?.data) cs.push(...d.data); }
  const seen = new Set();
  const c = cs.filter((x) => !seen.has(x.timestamp) && seen.add(x.timestamp)).sort((a, b) => a.timestamp - b.timestamp).map((x) => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]);
  writeFileSync(DIR + p.address + '.json', JSON.stringify({ ...p, candles: c }));
}
const qu = [...list];
await Promise.all(Array.from({ length: 5 }, async () => { while (qu.length) { await work(qu.shift()); process.stdout.write(`\r${++done}/${list.length}`); } }));
console.log('\ndone');
