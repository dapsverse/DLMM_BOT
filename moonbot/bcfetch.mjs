// Blue-chip pool data: 5m OHLCV (N days) + bin liquidity snapshot (+-W bins) for fee-share modelling. Read-only. Usage: node moonbot/bcfetch.mjs [days=7]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const DLMMPkg = require('@meteora-ag/dlmm'); const DLMM = DLMMPkg.default ?? DLMMPkg;
const API = 'https://dlmm.datapi.meteora.ag', H = { 'User-Agent': 'Mozilla/5.0' }, days = +(process.argv[2] ?? 7), W = 120;
const DIR = new URL('./databc/', import.meta.url).pathname, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envTxt = readFileSync(new URL('../.env.live', import.meta.url).pathname, 'utf8'); const RPC = envTxt.split('\n').find((l) => l.startsWith('RPC_URL='))?.slice(8).trim();
const conn = new Connection(RPC, 'confirmed');
async function get(u, t = 6) { for (let i = 0; i < t; i++) { try { const r = await fetch(u, { headers: H }); if (r.status === 429) { await sleep(2000 * (i + 1)); continue; } if (!r.ok) throw 0; return await r.json(); } catch { await sleep(800); } } return null; }
const WANT = /^(SOL-USDC|JUP-SOL|HYPE-SOL|MET-SOL|wNEAR-USDC|cbBTC-SOL|PUMP-SOL|ZEC-SOL|SOL-HYPE|cbBTC-USDC|PENGU-USDC|HYPE-USDC|PUMP-USDC|JitoSOL-SOL|STONK-SOL)$/;
const list = []; for (let page = 1; page <= 2; page++) { const d = await get(`${API}/pools?page=${page}&page_size=100&sort_by=tvl:desc`); for (const p of d?.data ?? []) if (WANT.test(p.name) && p.tvl > 500000 && (p.volume?.['24h'] ?? 0) > 50000) list.push(p); }
console.log('pools', list.length, list.map((p) => `${p.name}(bs${p.pool_config.bin_step})`).join(' '));
const end = Math.floor(Date.now() / 1000), start = end - days * 86400, CH = 96 * 300;
for (const p of list) {
  const f = DIR + p.address + '.json'; if (existsSync(f)) continue;
  const cs = []; for (let s = start; s < end; s += CH) { const d = await get(`${API}/pools/${p.address}/ohlcv?timeframe=5m&start_time=${s}&end_time=${Math.min(s + CH, end)}`); if (d?.data) cs.push(...d.data); }
  const seen = new Set(); const c = cs.filter((x) => !seen.has(x.timestamp) && seen.add(x.timestamp)).sort((a, b) => a.timestamp - b.timestamp).map((x) => [x.timestamp, x.open, x.high, x.low, x.close, x.volume]);
  let bins = null;
  try { const pool = await DLMM.create(conn, new PublicKey(p.address)); const r = await pool.getBinsAroundActiveBin(W, W);
    const dx = p.token_x.decimals, dy = p.token_y.decimals, px = p.token_x.price, py = p.token_y.price;
    bins = { activeId: r.activeBin, list: r.bins.map((b) => ({ id: b.binId, usd: Number(b.xAmount.toString()) / 10 ** dx * px + Number(b.yAmount.toString()) / 10 ** dy * py })) }; } catch (e) { console.log('bins fail', p.name, String(e).slice(0, 80)); }
  writeFileSync(f, JSON.stringify({ address: p.address, name: p.name, tvl: p.tvl, baseFeePct: p.pool_config.base_fee_pct, binStep: p.pool_config.bin_step, vol24: p.volume?.['24h'], fees24: p.fees?.['24h'], xAddr: p.token_x.address, yAddr: p.token_y.address, candles: c, bins }));
  console.log(p.name, 'bs', p.pool_config.bin_step, 'candles', c.length, 'bins', bins?.list.length ?? 'none');
}
