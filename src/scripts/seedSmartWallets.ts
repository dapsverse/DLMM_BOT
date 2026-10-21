/**
 * Seeds smart-wallets.json with consistently profitable Meteora DLMM LPers (our stand-in for meridian's hosted top-LPer data).
 * Owners of open positions in the busiest mid-size SOL pools are scored by Meteora's own portfolio PnL.
 * Usage: set -a; . ./.env.live; set +a; npx tsx src/scripts/seedSmartWallets.ts [maxWallets]
 */
import { writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const API = 'https://dlmm.datapi.meteora.ag';
const MIN_CLOSED = 30;
// Above this many closed positions a wallet is a high-frequency bot or market maker, not a selective LPer (those LP almost everywhere, so "present in pool" says nothing).
const MAX_CLOSED = 3000;
const MIN_PNL_SOL = 1;
const maxWallets = Number(process.argv[2] ?? 20);

const getJson = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json() as Promise<any>;

async function main() {
  const conn = new Connection(process.env.RPC_URL!);
  const { data } = await getJson(`${API}/pools?page=1&page_size=60&sort_by=volume_24h:desc`);
  const pools: string[] = data
    .filter((p: any) => p.token_y?.address === 'So11111111111111111111111111111111111111112' && p.tvl > 20_000 && p.tvl < 500_000)
    .slice(0, 15)
    .map((p: any) => p.address);
  const owners = new Set<string>();
  for (const pool of pools) {
    try {
      const accs = await conn.getProgramAccounts(DLMM_PROGRAM, { dataSlice: { offset: 40, length: 32 }, filters: [{ memcmp: { offset: 8, bytes: pool } }] });
      accs.forEach((a) => owners.add(new PublicKey(a.account.data).toBase58()));
    } catch (e) {
      console.log('skip pool', pool.slice(0, 6), (e as Error).message.slice(0, 60));
    }
  }
  console.log(`pools ${pools.length}, unique owners ${owners.size}`);
  const scored: { address: string; pnlSol: number; closed: number; pct: number }[] = [];
  for (const address of owners) {
    try {
      const t = await getJson(`${API}/portfolio/total?user=${address}`);
      const pnlSol = Number(t.totalPnlSol), closed = Number(t.totalClosedPositions), pct = Number(t.totalPnlSolPctChange);
      if (closed >= MIN_CLOSED && closed <= MAX_CLOSED && pnlSol >= MIN_PNL_SOL && pct > 0) scored.push({ address, pnlSol, closed, pct });
    } catch {
      /* ignore wallet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  scored.sort((a, b) => b.pnlSol - a.pnlSol);
  const top = scored.slice(0, maxWallets);
  writeFileSync('smart-wallets.json', JSON.stringify({ wallets: top.map((w, i) => ({ name: `lp-${i + 1} (pnl ${w.pnlSol.toFixed(1)} SOL, ${w.closed} closed)`, address: w.address, category: 'top-lper', type: 'lp' })) }, null, 2));
  console.log(`qualified ${scored.length}, wrote ${top.length} to smart-wallets.json`);
  top.slice(0, 5).forEach((w) => console.log(w.address.slice(0, 6), w.pnlSol.toFixed(1), 'SOL', w.closed, 'closed', (w.pct * 100).toFixed(1) + '%'));
}
main().then(() => process.exit(0));
