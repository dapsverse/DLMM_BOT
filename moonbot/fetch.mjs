// Collects 1h OHLCV (14d) for SOL-quoted Meteora DLMM pools, one JSON per pool in moonbot/data/.
// Usage: node moonbot/fetch.mjs [maxPools=2500] [days=14]
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
const API = 'https://dlmm.datapi.meteora.ag';
const H = { 'User-Agent': 'Mozilla/5.0' };
const maxPools = +(process.argv[2] ?? 2500);
const days = +(process.argv[3] ?? 14);
const WSOL = 'So11111111111111111111111111111111111111112';
const DIR = new URL('./data/', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch (e) { if (i === tries - 1) return null; await sleep(500 * (i + 1)); }
  }
}
// 1) universe: top pools by 24h volume, SOL-quoted, best pool per token mint
const byMint = new Map();
for (let page = 1; byMint.size < maxPools && page <= 60; page++) {
  const d = await get(`${API}/pools?page=${page}&page_size=100&sort_by=volume_24h:desc`);
  if (!d?.data?.length) break;
  for (const p of d.data) {
    const sol = p.token_x.address === WSOL ? p.token_y : p.token_y.address === WSOL ? p.token_x : null;
    if (!sol || p.token_x.address === p.token_y.address) continue;
    if (!byMint.has(sol.address)) byMint.set(sol.address, { address: p.address, name: p.name, mint: sol.address, xIsSol: p.token_x.address === WSOL, binStep: p.pool_config.bin_step, baseFeePct: p.pool_config.base_fee_pct, tvl: p.tvl, vol24: p.volume['24h'], created: p.created_at });
  }
  process.stdout.write(`\rpage ${page} mints ${byMint.size}`);
}
console.log();
// 2) candles
const end = Math.floor(Date.now() / 1000), start = end - days * 86400, CHUNK = 85 * 3600;
const pools = [...byMint.values()];
let done = 0;
const have = new Set(readdirSync(DIR));
async function work(p) {
  if (have.has(p.address + '.json')) return;
  const candles = [];
  for (let s = start; s < end; s += CHUNK) {
    const d = await get(`${API}/pools/${p.address}/ohlcv?timeframe=1h&start_time=${s}&end_time=${Math.min(s + CHUNK, end)}`);
    if (d?.data) candles.push(...d.data);
  }
  const seen = new Set();
  const c = candles.filter((x) => !seen.has(x.timestamp) && seen.add(x.timestamp)).sort((a, b) => a.timestamp - b.timestamp)
    .map((x) => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]);
  writeFileSync(DIR + p.address + '.json', JSON.stringify({ ...p, candles: c }));
}
const q = [...pools];
await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { await work(q.shift()); process.stdout.write(`\r${++done}/${pools.length}`); } }));
console.log('\ndone');
