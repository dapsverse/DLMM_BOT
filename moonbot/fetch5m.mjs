// 5m OHLCV (last N days) for pools our live bot entered + top-volume SOL pools. Usage: node moonbot/fetch5m.mjs [days=4] [topN=70]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
const API = 'https://dlmm.datapi.meteora.ag', H = { 'User-Agent': 'Mozilla/5.0' };
const days = +(process.argv[2] ?? 4), topN = +(process.argv[3] ?? 70), WSOL = 'So11111111111111111111111111111111111111112';
const DIR = new URL('./data5m/', import.meta.url).pathname, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, t = 6) { for (let i = 0; i < t; i++) { try { const r = await fetch(u, { headers: H }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) throw 0; return await r.json(); } catch { if (i === t - 1) return null; await sleep(600 * (i + 1)); } } }
const pools = new Map();
const logs = readdirSync(new URL('../logs/', import.meta.url).pathname).filter((f) => f.startsWith('live-'));
for (const f of logs) for (const l of readFileSync(new URL('../logs/' + f, import.meta.url).pathname, 'utf8').split('\n')) { const m = l.match(/entered pool ([1-9A-HJ-NP-Za-km-z]{32,44})/); if (m) pools.set(m[1], { address: m[1], live: true }); }
for (let page = 1; pools.size < topN + 20 && page < 10; page++) {
  const d = await get(`${API}/pools?page=${page}&page_size=100&sort_by=volume_24h:desc`); if (!d?.data) break;
  for (const p of d.data) if ((p.token_x.address === WSOL) !== (p.token_y.address === WSOL) && !pools.has(p.address) && pools.size < topN + 20) pools.set(p.address, { address: p.address, name: p.name, tvl: p.tvl, baseFeePct: p.pool_config.base_fee_pct, binStep: p.pool_config.bin_step, xIsSol: p.token_x.address === WSOL });
}
console.log('pools', pools.size);
const end = Math.floor(Date.now() / 1000), start = end - days * 86400, CH = 96 * 300;
let done = 0; const list = [...pools.values()];
async function work(p) {
  if (existsSync(DIR + p.address + '.json')) return;
  const meta = p.baseFeePct ? p : (await get(`${API}/pools/${p.address}`)) ?? {};
  const info = meta.pool_config ? { name: meta.name, tvl: meta.tvl, baseFeePct: meta.pool_config.base_fee_pct, binStep: meta.pool_config.bin_step, xIsSol: meta.token_x.address === WSOL } : p;
  const cs = [];
  for (let s = start; s < end; s += CH) { const d = await get(`${API}/pools/${p.address}/ohlcv?timeframe=5m&start_time=${s}&end_time=${Math.min(s + CH, end)}`); if (d?.data) cs.push(...d.data); }
  const seen = new Set();
  const c = cs.filter((x) => !seen.has(x.timestamp) && seen.add(x.timestamp)).sort((a, b) => a.timestamp - b.timestamp).map((x) => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]);
  writeFileSync(DIR + p.address + '.json', JSON.stringify({ address: p.address, live: !!p.live, ...info, candles: c }));
}
const q = [...list];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) { await work(q.shift()); process.stdout.write(`\r${++done}/${list.length}`); } }));
console.log('\ndone');
