/**
 * Read-only report: who is LPing the pools our screener looks at, and how good are they overall?
 * Owners of OPEN positions come from the chain (getProgramAccounts filtered by pool); each owner's all-time record comes from Meteora's
 * /portfolio/total. Prints the distribution and writes every owner to logs/lper-report.json. Writes NOTHING to smart-wallets.json:
 * the "smart" thresholds are picked after looking at this output. Usage: set -a; . ./.env.live; set +a; npx tsx src/scripts/findSmartLpers.ts [poolCount]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchTopPools } from '../services/meteoraScanner.js';

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const API = 'https://dlmm.datapi.meteora.ag';
const WSOL = 'So11111111111111111111111111111111111111112';
const POOL_COUNT = Number(process.argv[2] ?? 40);
const MIN_TVL_USD = 20_000;
const CONCURRENCY = 6; // ~12 req/s, well under Meteora's 30 RPS

interface Total {
  totalPnlSol: number;
  totalPnlSolPctChange: number;
  totalClosedPositions: number;
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};
const fmt = (n: number) => (Number.isFinite(n) ? +n.toFixed(2) : n);

async function ownersOfPool(conn: Connection, pool: string): Promise<string[]> {
  const accts = await conn.getProgramAccounts(DLMM_PROGRAM, { filters: [{ memcmp: { offset: 8, bytes: pool } }], dataSlice: { offset: 8, length: 64 } });
  const owners: string[] = [];
  for (const a of accts) {
    const d = a.account.data;
    if (d.length < 64 || new PublicKey(d.subarray(0, 32)).toBase58() !== pool) continue; // lb_pair check: ignore other account types
    owners.push(new PublicKey(d.subarray(32, 64)).toBase58());
  }
  return owners;
}

async function totalOf(owner: string): Promise<Total | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${API}/portfolio/total?user=${owner}`);
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, unknown>;
      // Meteora sends numbers as strings
      return { totalPnlSol: Number(j.totalPnlSol), totalPnlSolPctChange: Number(j.totalPnlSolPctChange), totalClosedPositions: Number(j.totalClosedPositions) };
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  return null;
}

async function main(): Promise<void> {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error('RPC_URL missing (load .env.live first)');
  const conn = new Connection(rpc, 'confirmed');
  const pools = (await fetchTopPools())
    .filter((p) => (p.mint_x === WSOL || p.mint_y === WSOL) && Number(p.liquidity) >= MIN_TVL_USD)
    .sort((a, b) => b.feeTvlRatio24h - a.feeTvlRatio24h)
    .slice(0, POOL_COUNT);
  console.log(`pools: ${pools.length} (SOL quote, TVL >= $${MIN_TVL_USD}, top by fee/TVL 24h)`);

  const poolsOfOwner = new Map<string, Set<string>>();
  for (const p of pools) {
    try {
      for (const o of await ownersOfPool(conn, p.address)) {
        if (!poolsOfOwner.has(o)) poolsOfOwner.set(o, new Set());
        poolsOfOwner.get(o)!.add(p.name);
      }
    } catch (e) {
      console.log(`  skip ${p.name}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }
  const owners = [...poolsOfOwner.keys()];
  console.log(`unique owners with an open position: ${owners.length}`);

  const rows: { owner: string; pools: string[]; total: Total }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < owners.length) {
        const owner = owners[next++]!;
        const total = await totalOf(owner);
        if (total && Number.isFinite(total.totalPnlSol) && Number.isFinite(total.totalPnlSolPctChange)) rows.push({ owner, pools: [...poolsOfOwner.get(owner)!], total });
      }
    }),
  );
  console.log(`owners with a readable record: ${rows.length}`);

  mkdirSync('logs', { recursive: true });
  writeFileSync('logs/lper-report.json', JSON.stringify(rows, null, 1));

  const closed = rows.map((r) => r.total.totalClosedPositions);
  const pnl = rows.map((r) => r.total.totalPnlSol);
  const pct = rows.map((r) => r.total.totalPnlSolPctChange);
  for (const [name, xs] of [['closed positions', closed], ['total PnL SOL', pnl], ['PnL % of deposits (SOL)', pct]] as const) {
    console.log(`${name}: p10 ${fmt(quantile(xs, 0.1))} | p25 ${fmt(quantile(xs, 0.25))} | median ${fmt(quantile(xs, 0.5))} | p75 ${fmt(quantile(xs, 0.75))} | p90 ${fmt(quantile(xs, 0.9))} | p99 ${fmt(quantile(xs, 0.99))}`);
  }
  console.log(`profitable (PnL SOL > 0): ${pnl.filter((x) => x > 0).length} of ${rows.length}`);
  console.log('candidates by threshold (closed >= N AND PnL SOL > X AND PnL% > Y):');
  for (const [n, x, y] of [[30, 0, 0], [30, 1, 1], [50, 2, 2], [100, 5, 3], [100, 10, 5], [200, 10, 5]] as const) {
    console.log(`  closed>=${n} pnl>${x}SOL pct>${y}%: ${rows.filter((r) => r.total.totalClosedPositions >= n && r.total.totalPnlSol > x && r.total.totalPnlSolPctChange > y).length}`);
  }
  console.log('top 10 by PnL% with closed >= 50:');
  rows
    .filter((r) => r.total.totalClosedPositions >= 50)
    .sort((a, b) => b.total.totalPnlSolPctChange - a.total.totalPnlSolPctChange)
    .slice(0, 10)
    .forEach((r) => console.log(`  ${r.owner.slice(0, 6)}…  pnl ${fmt(r.total.totalPnlSol)} SOL  ${fmt(r.total.totalPnlSolPctChange)}%  closed ${r.total.totalClosedPositions}  seen in ${r.pools.slice(0, 3).join(', ')}`));
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
