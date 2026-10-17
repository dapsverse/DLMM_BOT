/**
 * Standalone Telegram companion for the live bot (no Claude session, no bot dependencies).
 * - pushes key events from the newest logs/live-*.log (entries, exits, limit orders, errors) and a "bot stopped" alert
 * - answers /status from YOUR chat id only (everything else is ignored)
 * Run: npx tsx src/scripts/telegramNotify.ts   (reads .env.telegram + RPC_URL from .env.live; prints no secrets)
 */
import { execFile, execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const run = promisify(execFile);
const tg = loadEnv('.env.telegram');
const TOKEN = tg.TELEGRAM_BOT_TOKEN;
const CHAT = tg.TELEGRAM_CHAT_ID;
const RPC_URL = loadEnv('.env.live').RPC_URL;
if (!TOKEN || !CHAT) {
  console.error('Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.telegram first (see .env.telegram.example).');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const EVENT_RE = /entered pool|closing position|HARD_EXIT|TAKE_PROFIT|FLOW_EXIT|AI_EXIT|\[ai\] |AI screener|AI manager|down-break|limit order (placed|cancelled)|entry bid (placed|settled)|\] error|stop-loss|REBALANCE|skipping pool .*transfer fee/i;

// Defense in depth: logs should never hold secrets, but strip anything that looks like one before it leaves the machine.
const scrub = (s: string) =>
  s
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/api-key=[^&\s"']+/gi, 'api-key=***')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, '***'); // base58 secret-key-length strings (tx signatures are filtered by the same rule on purpose)

async function send(text: string): Promise<void> {
  try {
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: scrub(text).slice(0, 3800) }),
    });
  } catch (e) {
    console.error('send failed', e instanceof Error ? e.message : e);
  }
}

const newestLog = () => {
  const files = readdirSync('logs').filter((f) => /^live-.*\.log$/.test(f));
  return files.length ? 'logs/' + files.sort((a, b) => statSync('logs/' + b).mtimeMs - statSync('logs/' + a).mtimeMs)[0] : null;
};
const botAlive = () => {
  try {
    return execSync('pgrep -f "^node dist/index.js$"', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
};
const readFrom = (path: string, from: number): string => {
  const size = statSync(path).size;
  if (size <= from) return '';
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(Math.min(size - from, 512_000));
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  return buf.toString('utf8');
};

async function walletSol(wallet: string): Promise<number | null> {
  if (!RPC_URL) return null;
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [wallet, { commitment: 'confirmed' }] }) });
    const j = (await r.json()) as { result?: { value?: number } };
    return typeof j.result?.value === 'number' ? j.result.value / 1e9 : null;
  } catch {
    return null;
  }
}

/** Open DLMM positions per Meteora's portfolio API (ground truth, no SDK / private key); null if unreachable. */
async function onChainPositionCount(wallet: string): Promise<number | null> {
  try {
    const j = (await (await fetch(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}`)).json()) as { totalPositions?: number };
    return typeof j.totalPositions === 'number' ? j.totalPositions : null;
  } catch {
    return null;
  }
}

/** Non-SOL token balances in the wallet, priced in SOL via DexScreener (priceNative). Dust below 0.0005 SOL is dropped. */
async function tokenHoldings(wallet: string): Promise<{ mint: string; symbol: string; ui: number; sol: number | null }[]> {
  const out: { mint: string; symbol: string; ui: number; sol: number | null }[] = [];
  if (!RPC_URL) return out;
  for (const program of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    try {
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [wallet, { programId: program }, { encoding: 'jsonParsed' }] }) });
      const j = (await r.json()) as { result?: { value?: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] } };
      for (const a of j.result?.value ?? []) {
        const { mint, tokenAmount } = a.account.data.parsed.info;
        const ui = tokenAmount.uiAmount ?? 0;
        if (ui <= 0) continue;
        let sol: number | null = null;
        let symbol = mint.slice(0, 6);
        try {
          const d = (await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)).json()) as { pairs?: { priceNative?: string; baseToken?: { address?: string; symbol?: string }; quoteToken?: { address?: string }; liquidity?: { usd?: number } }[] };
          // Only a pair where THIS token is the base and SOL the quote prices it in SOL (EMBER/MET came first and was off by ~280x).
          const solPairs = (d.pairs ?? []).filter((p) => p.baseToken?.address === mint && p.quoteToken?.address === 'So11111111111111111111111111111111111111112');
          solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
          const best = solPairs[0];
          symbol = best?.baseToken?.symbol ?? d.pairs?.find((p) => p.baseToken?.address === mint)?.baseToken?.symbol ?? symbol;
          const pr = Number(best?.priceNative);
          if (Number.isFinite(pr) && pr > 0) sol = ui * pr;
        } catch {
          /* unpriced */
        }
        if (sol === null || sol >= 0.005) out.push({ mint, symbol, ui, sol });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

const fmtHold = (h: { mint?: string; symbol: string; ui: number; sol: number | null }) => `${h.symbol} ${h.ui.toLocaleString('en', { maximumFractionDigits: 2 })}${h.sol === null ? ' (unpriced)' : ` ≈ ${h.sol.toFixed(4)} SOL`}`;

// Reference points for /pnl (SOL): reconstructed from on-chain wallet deltas, see session notes 2026-10-14.
const BASELINES: [string, number][] = [
  ['since 03:19 UTC restart 14 Oct', 1.1528],
  ['experiment baseline 12 Oct', 1.1239],
  ['funding', 1.6522],
];

interface Health { ts: string; currentValueSol: number; unclaimedFeesSol: number; isOutOfRange: boolean; currentBinId: number }

function lastHealth(): Health | null {
  const log = newestLog();
  if (!log) return null;
  const line = readFileSync(log, 'utf8').split('\n').reverse().find((l) => l.includes('health check'));
  const m = line && /^(\S+).*health check (\{.*\})/.exec(scrub(line));
  if (!m) return null;
  try {
    return { ...(JSON.parse(m[2]!) as Omit<Health, 'ts'>), ts: m[1]! };
  } catch {
    return null;
  }
}

function readState(): { wallet: string | null; pool: string | null; outSince: number | null; pendingOrder: boolean; pendingSwap: boolean } | null {
  try {
    const s = JSON.parse(readFileSync('state/live-state.json', 'utf8')) as { wallet?: string; position?: { poolAddress: string; outOfRangeSinceMs: number | null } | null; pendingLimitOrder?: unknown; pendingSwapBack?: unknown };
    return { wallet: s.wallet ?? null, pool: s.position?.poolAddress ?? null, outSince: s.position?.outOfRangeSinceMs ?? null, pendingOrder: !!s.pendingLimitOrder, pendingSwap: !!s.pendingSwapBack };
  } catch {
    return null;
  }
}

const hhmm = (iso: string) => iso.slice(11, 16) + ' UTC';
const ageMin = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 60_000);

interface PortfolioPool { poolAddress: string; tokenX: string; tokenY: string; binStep: number; baseFee: number; balancesSol: string; balances: string; unclaimedFees: string; unclaimedFeesSol: string; pnlSol: string; pnlSolPctChange: string; totalDepositSol: string; feePerTvl24h: string; outOfRange: boolean }
interface Portfolio { solPrice: number; pools: PortfolioPool[] }

/** Meteora portfolio API: per-pool value, fees, PnL (PnL includes unclaimed fees); null if unreachable. */
async function portfolio(wallet: string): Promise<Portfolio | null> {
  try {
    const j = (await (await fetch(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}`)).json()) as { solPrice?: string; pools?: PortfolioPool[] };
    return { solPrice: Number(j.solPrice ?? 0), pools: j.pools ?? [] };
  } catch {
    return null;
  }
}
const sg = (n: number, d = 4) => (n >= 0 ? '+' : '') + n.toFixed(d);

function poolLines(p: PortfolioPool, solPrice: number, detail: boolean): string[] {
  const val = Number(p.balancesSol), fee = Number(p.unclaimedFeesSol), dep = Number(p.totalDepositSol), pnl = Number(p.pnlSol), pct = Number(p.pnlSolPctChange);
  const usd = (sol: number) => (solPrice > 0 ? ` ($${(sol * solPrice).toFixed(2)})` : '');
  const out = [`${p.tokenX}-${p.tokenY}: value ${val.toFixed(4)} SOL${usd(val)}, fees ${fee.toFixed(4)} SOL${usd(fee)}, PnL ${sg(pnl)} SOL${usd(pnl)} (${sg(pct, 2)}%)`];
  if (detail) {
    out.push(
      `deposit: ${dep.toFixed(4)} SOL${usd(dep)}`,
      `fees generated (unclaimed): ${fee.toFixed(4)} SOL = $${Number(p.unclaimedFees).toFixed(2)}`,
      `position value now: ${val.toFixed(4)} SOL = $${Number(p.balances).toFixed(2)}`,
      `PnL incl. fees: ${sg(pnl)} SOL = ${sg(pnl * solPrice, 2).replace(/^([+-])/, '$1$')} (${sg(pct, 2)}%)`,
      `pool fee/TVL 24h: ${Number(p.feePerTvl24h).toFixed(2)}%, bin step ${p.binStep}, base fee ${p.baseFee}%`,
      `range: ${p.outOfRange ? 'OUT OF RANGE' : 'in range'}`,
      `SOL price: $${solPrice.toFixed(2)}`,
    );
  }
  return out;
}

async function statusText(): Promise<string> {
  const st = readState();
  const lines: string[] = [`bot: ${botAlive() ? 'RUNNING' : 'STOPPED'}`];
  if (!st?.wallet) return lines.concat('state file unreadable').join('\n');
  const [count, sol, holds] = await Promise.all([onChainPositionCount(st.wallet), walletSol(st.wallet), tokenHoldings(st.wallet)]);
  lines.push(count === null ? `position (state file, unverified): ${st.pool ? st.pool.slice(0, 6) + '…' : 'none'}` : count === 0 ? 'position: none on-chain' + (st.pool ? ' (state file is stale)' : '') : `position: ${count} open on-chain`);
  if (st.pendingOrder) lines.push('pending limit order: yes');
  if (st.pendingSwap) lines.push('pending swap-back: yes');
  if (sol !== null) lines.push(`wallet SOL: ${sol.toFixed(4)}`);
  for (const h of holds) lines.push(`holding: ${fmtHold(h)}`);
  if (existsSync('state/manual-orders.json') && readFileSync('state/manual-orders.json', 'utf8').trim() !== '[]') lines.push('manual orders:\n' + (await ops(['orders'], 90_000)));
  const pf = count ? await portfolio(st.wallet) : null;
  if (pf?.pools.length) for (const p of pf.pools) lines.push(...poolLines(p, pf.solPrice, false));
  const h = count && !pf?.pools.length ? lastHealth() : null;
  if (h) lines.push(`pos ${h.currentValueSol.toFixed(4)} + fees ${h.unclaimedFeesSol.toFixed(4)} SOL, bin ${h.currentBinId}${h.isOutOfRange ? ' OUT OF RANGE' : ''} (${hhmm(h.ts)}, ${ageMin(h.ts)}m ago)`);
  return lines.join('\n');
}

async function pnlText(): Promise<string> {
  const st = readState();
  if (!st?.wallet) return 'state file unreadable';
  const [count, sol, holds] = await Promise.all([onChainPositionCount(st.wallet), walletSol(st.wallet), tokenHoldings(st.wallet)]);
  if (sol === null) return 'wallet balance unavailable';
  const h = count ? lastHealth() : null;
  const posVal = h ? h.currentValueSol + h.unclaimedFeesSol : 0;
  const holdVal = holds.reduce((acc, x) => acc + (x.sol ?? 0), 0);
  const eq = sol + holdVal + posVal;
  const parts = [`wallet ${sol.toFixed(4)}`];
  if (holdVal) parts.push(`tokens ${holdVal.toFixed(4)}`);
  if (posVal) parts.push(`position ${posVal.toFixed(4)}`);
  const lines = [`equity ≈ ${eq.toFixed(4)} SOL (${parts.join(' + ')}; excludes rent refunds and anything locked in limit orders)`];
  for (const [label, base] of BASELINES) lines.push(`${label}: ${(eq - base >= 0 ? '+' : '') + (eq - base).toFixed(4)} SOL (${((eq / base - 1) * 100).toFixed(1)}%)`);
  if (count === null) lines.push('WARNING: could not verify on-chain positions, position value not included');
  else if (h) lines.push(`position value as of ${hhmm(h.ts)} (${ageMin(h.ts)}m ago${botAlive() ? '' : ', bot stopped: stale'})`);
  if (holds.some((x) => x.sol === null)) lines.push('some tokens unpriced, not in equity');
  return lines.join('\n');
}

async function posText(): Promise<string> {
  const st = readState();
  if (!st?.wallet) return 'state file unreadable';
  const count = await onChainPositionCount(st.wallet);
  if (count === 0) return 'no open position on-chain' + (st.pool ? ' (state file still lists one: stale, bot not running or not yet reconciled)' : '');
  if (!st.pool) return count === null ? 'no position in state; on-chain check unavailable' : `${count} position(s) on-chain but none in state`;
  const pf = await portfolio(st.wallet);
  if (pf?.pools.length) {
    const out: string[] = [];
    for (const p of pf.pools) out.push(`pool ${p.poolAddress}`, ...poolLines(p, pf.solPrice, true), '');
    const hh = lastHealth();
    if (hh) out.push(`bot health: bin ${hh.currentBinId}, as of ${hhmm(hh.ts)} (${ageMin(hh.ts)}m ago)`);
    if (st.outSince) out.push(`out of range since ${hhmm(new Date(st.outSince).toISOString())}`);
    return out.join('\n').trim();
  }
  const h = lastHealth();
  const lines = [`pool ${st.pool}`];
  if (h) {
    lines.push(`value ${h.currentValueSol.toFixed(4)} SOL, unclaimed fees ${h.unclaimedFeesSol.toFixed(4)} SOL`, `active bin ${h.currentBinId}, ${h.isOutOfRange ? 'OUT OF RANGE' : 'in range'}`, `as of ${hhmm(h.ts)} (${ageMin(h.ts)}m ago)`);
  }
  if (st.outSince) lines.push(`out of range since ${hhmm(new Date(st.outSince).toISOString())}${botAlive() ? '' : ' (bot stopped: idle timer not running)'}`);
  return lines.join('\n');
}

function logText(arg: string): string {
  const n = Math.min(Math.max(parseInt(arg, 10) || 8, 1), 20);
  const log = newestLog();
  if (!log) return 'no log';
  const hits = readFileSync(log, 'utf8').split('\n').filter((l) => EVENT_RE.test(l)).slice(-n).map((l) => scrub(l).slice(0, 220));
  return hits.length ? hits.join('\n') : 'no events in the current log';
}


/** Env for child processes: .env.live WITHOUT the private key (scan and advice never need the wallet). */
function childEnv(): NodeJS.ProcessEnv {
  const live = loadEnv('.env.live');
  delete live.PRIVATE_KEY;
  return { ...process.env, ...live };
}

let busy = false;
let bgBusy = false; // a detached long operation (openpool) is running
const isBusy = () => busy || bgBusy;

const WSOL = 'So11111111111111111111111111111111111111112';
const TREND_MAX_MCAP = 200_000_000; // keeps majors (HYPE, TRUMP-size caps) and stables out of "trending"

/** Top-N TOKEN/SOL pools by 1h volume straight from Meteora, NO bot filters. */
async function trendingPools(n = 10): Promise<{ addr: string; line: string; symbol: string; mint: string }[]> {
  const d = (await (await fetch('https://dlmm.datapi.meteora.ag/pools?page_size=100&sort_by=volume_1h:desc')).json()) as {
    data: { address: string; name: string; tvl: number; volume: Record<string, number>; token_x: { address: string; symbol: string; market_cap?: number }; token_y: { address: string; symbol: string; market_cap?: number } }[];
  };
  const out: { addr: string; line: string; symbol: string; mint: string }[] = [];
  const seen = new Set<string>();
  for (const p of d.data) {
    const tok = p.token_x.address === WSOL ? p.token_y : p.token_x;
    const other = p.token_x.address === WSOL ? p.token_x : p.token_y;
    if (other.address !== WSOL || seen.has(tok.address) || (tok.market_cap ?? 0) > TREND_MAX_MCAP) continue;
    seen.add(tok.address);
    out.push({
      addr: p.address, symbol: tok.symbol, mint: tok.address,
      line: `${out.length + 1}. ${p.name} pool=${p.address}\n   vol1h=$${Math.round(p.volume['1h'] ?? 0).toLocaleString('en')} vol24h=$${Math.round(p.volume['24h'] ?? 0).toLocaleString('en')} TVL=$${Math.round(p.tvl).toLocaleString('en')} mcap=$${Math.round(tok.market_cap ?? 0).toLocaleString('en')}`,
    });
    if (out.length >= n) break;
  }
  return out;
}

async function scanText(): Promise<string> {
  const t = await trendingPools();
  return t.length ? `Top ${t.length} trending (volume 1h, tanpa filter bot):\n\n` + t.map((x) => x.line).join('\n') : 'tidak ada data trending';
}

/** Compact fact sheet for one pool: Meteora pool API + DexScreener pair stats + token transfer fee. Best-effort, missing parts are skipped. */
async function poolFacts(addr: string): Promise<string> {
  const lines: string[] = [];
  try {
    const d = (await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${addr}`)).json()) as {
      name?: string; tvl?: number; current_price?: number; created_at?: number; launchpad?: string; dynamic_fee_pct?: number;
      pool_config?: { bin_step?: number; base_fee_pct?: number; collect_fee_mode?: number };
      volume?: Record<string, number>; fees?: Record<string, number>; fee_tvl_ratio?: Record<string, number>;
      token_x?: { address?: string; symbol?: string; holders?: number; market_cap?: number };
      token_y?: { address?: string; symbol?: string; holders?: number; market_cap?: number };
    };
    const tok = d.token_x?.address === 'So11111111111111111111111111111111111111112' ? d.token_y : d.token_x;
    const v = d.volume ?? {};
    const rr = (x?: number, mult = 1) => (x && v['24h'] ? ((x * mult) / v['24h']).toFixed(2) : '?');
    lines.push(`POOL ${d.name} ${addr}`);
    lines.push(`bin step ${d.pool_config?.bin_step}, base fee ${d.pool_config?.base_fee_pct}%, dynamic fee ${d.dynamic_fee_pct?.toFixed(2)}%, collect_fee_mode ${d.pool_config?.collect_fee_mode}, launchpad ${d.launchpad ?? '-'}`);
    lines.push(`TVL $${Math.round(d.tvl ?? 0)}, price ${d.current_price}, age ${d.created_at ? Math.round((Date.now() - d.created_at) / 3_600_000) : '?'}h, token ${tok?.symbol} mcap $${Math.round(tok?.market_cap ?? 0)}, holders ${tok?.holders}`);
    lines.push('volume $: ' + ['30m', '1h', '4h', '12h', '24h'].map((w) => `${w}=${Math.round(v[w] ?? 0)}`).join(' '));
    lines.push('fee/TVL %: ' + ['30m', '1h', '4h', '12h', '24h'].map((w) => `${w}=${(d.fee_tvl_ratio?.[w] ?? 0).toFixed(2)}`).join(' '));
    lines.push(`volume run-rate vs 24h total: 30m x48 = ${rr(v['30m'], 48)}, 1h x24 = ${rr(v['1h'], 24)}, 4h x6 = ${rr(v['4h'], 6)} (below 1 = fading)`);
    if (tok?.address) {
      const fee = await getTransferFee(tok.address);
      lines.push(`transfer fee: ${fee === null ? 'unknown' : fee === 0 ? 'none' : fee / 100 + '% (AVOID)'}`);
    }
  } catch {
    lines.push(`POOL ${addr}: Meteora API unavailable`);
  }
  try {
    const dx = (await (await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`)).json()) as {
      pair?: { priceChange?: Record<string, number>; txns?: Record<string, { buys: number; sells: number }>; volume?: Record<string, number> };
    };
    const pc = dx.pair?.priceChange;
    const tx = dx.pair?.txns;
    if (pc) lines.push(`price change %: 5m=${pc.m5} 1h=${pc.h1} 6h=${pc.h6} 24h=${pc.h24}`);
    if (tx) lines.push('tx buys/sells: ' + ['m5', 'h1', 'h6', 'h24'].map((w) => `${w}=${tx[w]?.buys}/${tx[w]?.sells}`).join(' '));
  } catch {
    /* optional */
  }
  return lines.join('\n');
}

async function getTransferFee(mint: string): Promise<number | null> {
  if (!RPC_URL) return null;
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] }) });
    const j = (await r.json()) as { result?: { value?: { data?: { parsed?: { info?: { extensions?: { extension: string; state?: { newerTransferFee?: { transferFeeBasisPoints?: number } } }[] } } } } } };
    const info = j.result?.value?.data?.parsed?.info;
    if (!info) return null;
    return info.extensions?.find((e) => e.extension === 'transferFeeConfig')?.state?.newerTransferFee?.transferFeeBasisPoints ?? 0;
  } catch {
    return null;
  }
}

async function askClaude(prompt: string, web = false): Promise<string> {
  const tools = web ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
  const child = execFile('claude', ['-p', ...tools, '--no-session-persistence'], { cwd: tmpdir(), timeout: web ? 480_000 : 180_000, maxBuffer: 1_000_000 });
  child.stdin?.end(prompt);
  const out = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`claude exited ${code}`))));
  });
  return out.trim() || 'no answer';
}

interface PnlPosition { lowerBinId: number; upperBinId: number; poolActiveBinId: number; unrealizedPnl: { balancesSol: number; balanceTokenX: { amountSol: number; usd: number }; balanceTokenY: { amountSol: number; usd: number } } }

/** Token share of an open position (non-SOL side as % of position value) plus its bin range, from Meteora's per-pool position PnL endpoint; null if unreachable. */
async function tokenShareLine(wallet: string, pool: string, solMint = 'So11111111111111111111111111111111111111112'): Promise<string | null> {
  try {
    const j = (await (await fetch(`https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=open`)).json()) as { tokenX?: string; positions?: PnlPosition[] };
    const pos = j.positions?.[0];
    if (!pos) return null;
    const u = pos.unrealizedPnl;
    const [tok, sol] = j.tokenX === solMint ? [u.balanceTokenY, u.balanceTokenX] : [u.balanceTokenX, u.balanceTokenY];
    const tokSol = Number(tok.amountSol), solSol = Number(sol.amountSol), total = tokSol + solSol; // the API returns numbers as strings
    const pct = total > 0 ? (tokSol / total) * 100 : 0;
    return `token share now: ${pct.toFixed(1)}% (token ${tokSol.toFixed(4)} SOL = $${Number(tok.usd).toFixed(2)}, SOL ${solSol.toFixed(4)}); active bin ${pos.poolActiveBinId}, ladder ${pos.lowerBinId}..${pos.upperBinId}`;
  } catch {
    return null;
  }
}

/** /aireport: the facts (status, position detail, peak, last events, last AI decisions) handed to Claude, which writes the same kind of status read-out the user normally asks for in chat. */
async function aiReportText(): Promise<string> {
  const [status, pos] = await Promise.all([statusText(), posText()]);
  const wallet = readState()?.wallet;
  const pf = wallet ? await portfolio(wallet) : null;
  const names = new Map((pf?.pools ?? []).map((p) => [p.poolAddress, `${p.tokenX}-${p.tokenY}`]));
  const poolsBlock = (await Promise.all((pf?.pools ?? []).map(async (p) => {
    const ts = wallet ? await tokenShareLine(wallet, p.poolAddress) : null;
    return `${p.tokenX}-${p.tokenY} | address ${p.poolAddress} | https://app.meteora.ag/dlmm/${p.poolAddress}${ts ? '\n' + ts : ''}`;
  }))).join('\n') || 'none';
  let peak = 'n/a';
  try {
    const p = (JSON.parse(readFileSync('state/live-state.json', 'utf8')) as { position?: { peakProfitPct?: number } | null }).position;
    if (p?.peakProfitPct !== undefined) peak = `${p.peakProfitPct.toFixed(2)}%`;
  } catch {
    /* peak stays n/a */
  }
  let decisions = 'none';
  try {
    decisions = readFileSync('logs/ai-decisions.jsonl', 'utf8').trim().split('\n').slice(-4).map((l) => {
      const d = JSON.parse(l) as { at?: string; kind?: string; action?: string; pool?: string; strategy?: string; reason?: string };
      return `${d.at} ${d.kind} ${d.action}${d.strategy ? ' ' + d.strategy : ''} ${d.pool ? (names.get(d.pool) ?? d.pool) : ''}: ${(d.reason ?? '').slice(0, 300)}`;
    }).join('\n');
  } catch {
    /* decisions stay none */
  }
  // ponytail: thresholds below are the code defaults (env.ts MERIDIAN_*, STOP_LOSS_PCT); update here if .env.live overrides them
  const prompt = [
    'You report the live state of a Meteora DLMM LP bot (real money) to its owner, in Bahasa Indonesia, terse, no markdown tables, no secrets. Use ONLY the facts below; do not invent numbers.',
    'Cover: bot up/down; the position (pool, value, fees in SOL and $, PnL incl. fees, in/out of range, CURRENT token share from OPEN POOLS); how close it is to each exit rule; what happens next; anything notable or worrying in the recent events/decisions. If there is no position, say what the bot is doing instead. Keep it under 1500 characters. ALWAYS name a pool by its token pair (for example FTR-SOL, never only an address) and print its FULL address plus the Meteora link on its own line, copied exactly from OPEN POOLS; never abbreviate or truncate an address.',
    'Exit rules (defaults): take profit PnL >= 5%; trailing TP arms at peak PnL >= 3% and closes when PnL drops 1.5 points below the peak; stop loss -25%; out of range >= 30 min (token_spot: 15 min until first reach); price > 10 bins above the ladder; low yield (pool fee/TVL 24h < 7% after 60 min). PnL = value + unclaimed fees vs deposit. The AI manager may also close at any time.',
    `Now (UTC): ${new Date().toISOString().slice(0, 16)}`,
    `OPEN POOLS (name | full address | link):\n${poolsBlock}`,
    `STATUS:\n${status}`,
    `POSITION DETAIL:\n${pos}`,
    `PEAK PNL (bot state): ${peak}`,
    `RECENT EVENTS:\n${logText('15')}`,
    `LAST AI DECISIONS:\n${decisions}`,
  ].join('\n\n');
  return askClaude(prompt);
}

async function suggestText(arg: string): Promise<string> {
  let addrs: string[];
  let header: string;
  let symbols: string[] = [];
  if (arg) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(arg)) return 'pakai: /suggest (kandidat scan) atau /suggest <alamat pool>';
    addrs = [arg];
    header = 'Analisis satu pool pilihan user (bukan hasil scan, jadi belum tentu lolos filter bot):';
  } else {
    const t = await trendingPools();
    if (!t.length) return 'tidak ada data trending';
    addrs = t.map((x) => x.addr);
    symbols = t.map((x) => x.symbol);
    header = 'Top 10 pool TOKEN/SOL trending (volume 1h tertinggi, TANPA filter bot, jadi banyak yang tidak akan lolos aturan bot):';
  }
  const facts = await Promise.all(addrs.map(poolFacts));
  let knowledge = '';
  try {
    knowledge = readFileSync('docs/dlmm-analyst-context.md', 'utf8');
  } catch {
    knowledge = 'Kamu analis volume DLMM Meteora profesional. Jawab Bahasa Indonesia, ringkas, jangan mengarang data.';
  }
  const ctx = await statusText();
  const web = symbols.length
    ? [
        '',
        'SENTIMEN X: pakai WebSearch untuk tiap token (' + symbols.join(', ') + ') cari sentimen/narasi di X (Twitter) dan berita 24 jam terakhir. Kalau tidak ketemu data X yang jelas, tulis "sentimen X: tidak ada data", JANGAN mengarang. Sebut tanggal sumber kalau ada.',
        'FORMAT JAWABAN: maksimal 3000 karakter total. Per pool 2-3 baris: verdict (MASUK / PANTAU / HINDARI), alasan volume DLMM, sentimen X. Tutup dengan 1-3 pilihan terbaik dan alasannya. Bahasa Indonesia, tanpa tabel markdown.',
      ].join('\n')
    : '';
  return askClaude([knowledge, '', 'KONDISI BOT SEKARANG:', ctx, '', header, ...facts.map((f) => '\n' + f), web].join('\n'), symbols.length > 0);
}

// ---- Manual controls (bot must be STOPPED for open/close/clean; every mutation needs /ya <code>) ----
const LIVECTL = 'scripts/livectl.sh';
let pending: { desc: string; code: string; expires: number; exec: () => Promise<string> } | null = null;
let lastHoldings: Awaited<ReturnType<typeof tokenHoldings>> = [];

const botPid = (): string | null => {
  try {
    return execSync('pgrep -f "^node dist/index.js$"', { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
};

async function ops(args: string[], timeoutMs: number, keepRe?: RegExp): Promise<string> {
  try {
    const { stdout } = await run(LIVECTL, ['npx', 'tsx', 'src/scripts/manualOps.ts', ...args], { timeout: timeoutMs, maxBuffer: 4_000_000 });
    const lines = scrub(stdout).split('\n').filter((l) => l.trim() && !/\b429\b/.test(l));
    const picked = keepRe ? lines.filter((l) => keepRe.test(l)).slice(-8).map((l) => l.slice(0, 300)) : [];
    return (picked.length ? picked : lines.slice(-12)).join('\n') || '(no output)';
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? '';
    return 'FAILED: ' + (scrub(out).split('\n').filter((l) => l.trim()).slice(-4).join('\n') || (e instanceof Error ? e.message.slice(0, 200) : 'unknown'));
  }
}

const needStopped = (): string | null => (botPid() ? 'Bot sedang jalan. Matikan dulu dengan /stopbot, baru perintah manual bisa dipakai.' : null);

function arm(desc: string, exec: () => Promise<string>): string {
  const code = String(1000 + Math.floor(Math.random() * 9000));
  pending = { desc, code, expires: Date.now() + 120_000, exec };
  return `${desc}\n\nKetik /ya ${code} untuk eksekusi (berlaku 2 menit), atau /batal.`;
}

async function confirmText(arg: string): Promise<string> {
  if (!pending || Date.now() > pending.expires) {
    pending = null;
    return 'tidak ada aksi yang menunggu konfirmasi (atau sudah kedaluwarsa)';
  }
  if (arg !== pending.code) return 'kode salah';
  const { exec } = pending;
  pending = null;
  if (isBusy()) return 'operasi lain masih berjalan';
  busy = true;
  try {
    return await exec();
  } finally {
    busy = false;
  }
}

async function startBot(): Promise<string> {
  if (botPid()) return 'bot sudah jalan';
  if (isBusy()) return 'ada operasi manual yang masih berjalan, tunggu selesai';
  try {
    await run('npm', ['run', 'build'], { timeout: 180_000, maxBuffer: 4_000_000 });
  } catch (e) {
    return 'build gagal: ' + (e instanceof Error ? e.message.slice(0, 200) : 'unknown');
  }
  mkdirSync('logs', { recursive: true });
  const fd = openSync(`logs/live-${Math.floor(Date.now() / 1000)}.log`, 'a');
  const child = spawn(LIVECTL, ['node', 'dist/index.js'], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  await new Promise((r) => setTimeout(r, 15_000));
  return botPid() ? 'bot STARTED (log baru dibuat; event akan masuk lewat notifikasi)' : 'bot mati lagi saat boot, cek /log';
}

async function stopBot(force: boolean): Promise<string> {
  const pid = botPid();
  if (!pid) return 'bot sudah mati';
  const st = readState();
  const inflight = (() => {
    try {
      return (JSON.parse(readFileSync('state/live-state.json', 'utf8')) as { inFlight?: boolean }).inFlight === true;
    } catch {
      return false;
    }
  })();
  if (inflight && !force) return 'bot sedang di tengah operasi on-chain (inFlight). Tunggu selesai, atau /stopbot force kalau yakin.';
  process.kill(Number(pid), 'SIGTERM');
  for (let i = 0; i < 10 && botPid(); i++) await new Promise((r) => setTimeout(r, 1000));
  const count = st?.wallet ? await onChainPositionCount(st.wallet) : null;
  return `${botPid() ? 'bot MASIH jalan (SIGTERM belum berhasil)' : 'bot STOPPED'}. Posisi on-chain: ${count ?? '?'} (stop bot TIDAK menutup posisi, tidak ada yang mengelolanya sampai /startbot).`;
}

async function openCmd(arg: string, mode: 'bid' | 'market' | 'bot' = 'bid'): Promise<string> {
  const botStyle = mode === 'bot';
  const stopped = needStopped();
  if (stopped) return stopped;
  const [pool = '', sol = ''] = arg.split(/\s+/);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) return 'pakai: /open <alamat pool> [jumlah SOL]';
  if (sol && !(Number(sol) > 0)) return 'jumlah SOL tidak valid';
  const summary = await ops([mode === 'bot' ? 'openpool-dry' : mode === 'bid' ? 'bid-dry' : 'open-dry', pool, sol], 180_000);
  if (/^(FAILED|ERROR)/m.test(summary)) return summary;
  return arm((mode === 'bot' ? 'BUKA POSISI GAYA BOT (uang asli, bid ladder dulu)\n' : mode === 'bid' ? 'PASANG LIMIT BUY (uang asli)\n' : 'BUKA POSISI (uang asli, beli market langsung)\n') + summary, async () => {
    const stopped2 = needStopped();
    if (stopped2) return stopped2;
    if (mode === 'bid') return ops(['bid', pool, sol], 300_000);
    if (mode === 'market') {
      await send('membuka posisi… (bisa 1-3 menit)');
      return ops(['open', pool, sol], 600_000);
    }
    // long run (bid wait up to ~30 min): detach from the command loop and report when finished
    bgBusy = true;
    void ops(['openpool', pool, sol], 45 * 60_000, /entry bid|limit order|abort|opened|ERROR|FAILED|re-check/i)
      .then((r) => send('openpool selesai:\n' + r))
      .finally(() => {
        bgBusy = false;
      });
    return 'openpool dimulai. Bid ladder bisa sampai ~33 menit, saya kabari saat selesai. /status tetap bisa dipakai; perintah lain ditolak sampai selesai.';
  });
}

async function closeCmd(arg: string): Promise<string> {
  const stopped = needStopped();
  if (stopped) return stopped;
  if (arg && arg !== 'now' && !(Number(arg) > 0)) return 'pakai: /close (ask default), /close <persen> atau /close now (jual market)';
  const summary = await ops(['close-dry', arg], 120_000);
  if (/^(FAILED|ERROR)/m.test(summary) || /no open position/.test(summary)) return summary;
  return arm('TUTUP POSISI (uang asli)\n' + summary, async () => {
    const stopped2 = needStopped();
    if (stopped2) return stopped2;
    await send('menutup posisi… (bisa 1-3 menit)');
    return ops(['close', arg], 600_000);
  });
}

async function ordersCmd(): Promise<string> {
  return ops(['orders'], 120_000);
}

async function cancelOrderCmd(arg: string): Promise<string> {
  const stopped = needStopped();
  if (stopped) return stopped;
  if (!arg) return 'pakai: /cancelorder <nomor> atau /cancelorder all (nomor dari /orders)';
  const list = await ops(['orders'], 120_000);
  if (/no manual limit orders/.test(list)) return list;
  return arm('BATALKAN LIMIT ORDER (deposit yang belum terisi dan hasil yang sudah terisi kembali ke wallet)\n' + list + `\n\nPilihan: ${arg}`, async () => {
    const stopped2 = needStopped();
    if (stopped2) return stopped2;
    return ops(['cancel', arg], 300_000);
  });
}

async function cleanCmd(arg: string): Promise<string> {
  const stopped = needStopped();
  if (stopped) return stopped;
  const st = readState();
  if (!st?.wallet) return 'state file unreadable';
  if (!arg) {
    lastHoldings = await tokenHoldings(st.wallet);
    if (!lastHoldings.length) return 'tidak ada token nyangkut di wallet (debu di bawah 0,0005 SOL disembunyikan)';
    return lastHoldings.map((h, i) => `${i + 1}. ${fmtHold(h)}`).join('\n') + '\n\nJual: /clean <nomor> atau /clean all';
  }
  const list = lastHoldings;
  if (!list.length) return 'ketik /clean dulu untuk melihat daftar';
  const picks = arg === 'all' ? list : [list[Number(arg) - 1]].filter((x): x is NonNullable<typeof x> => !!x);
  if (!picks.length) return 'nomor tidak valid';
  const desc = 'JUAL TOKEN ke SOL via Jupiter (uang asli, harga market)\n' + picks.map((h) => fmtHold(h)).join('\n') + (picks.some((h) => h.sol === null) ? '\nWARNING: ada token tanpa harga, hasil jual tidak bisa diperkirakan' : '');
  return arm(desc, async () => {
    const stopped2 = needStopped();
    if (stopped2) return stopped2;
    const res: string[] = [];
    for (const h of picks) res.push(`${h.symbol}: ` + (await ops(['sell', h.mint], 300_000)).split('\n').slice(-2).join(' '));
    lastHoldings = [];
    return res.join('\n');
  });
}

const HELP = [
  '/status – bot up/down, position, wallet SOL',
  '/pnl – equity and PnL vs baselines',
  '/posisi – open position detail',
  '/aireport – Claude reads the status, position and recent events and writes a short report (~30 s)',
  '/log [n] – last n events (default 8, max 20)',
  '/scan – top 10 trending TOKEN/SOL pools by 1h volume, no bot filters (~5s)',
  '/suggest [pool] – Claude analyst on the top 10 trending pools incl. X sentiment via web search (~3-6 min), or on one pool',
  '/startbot – build and start the live bot (needs /ya)',
  '/stopbot – stop the live bot, positions stay open (needs /ya)',
  '/open <pool> [sol] – place a limit BUY order only (no waiting, no monitoring), bot stopped only (needs /ya)',
  '/openmarket <pool> [sol] – instant market open of a position, bot stopped only (needs /ya)',
  '/orders – status of your manual limit orders (fill %)',
  '/cancelorder <n|all> – cancel manual limit orders (needs /ya)',
  '/openpool <pool> [sol] – open exactly like the bot: bid ladder, don\'t-chase abort, flow re-check (needs /ya, up to ~33 min)',
  '/close [pct|now] – close position and place a limit SELL ask (default bot pct, or now = market), bot stopped only (needs /ya)',
  '/clean [n|all] – list or sell stuck tokens, only while the bot is stopped (needs /ya)',
  '/ya <code> – confirm the pending action',
  '/batal – cancel the pending action',
  '/help – this list',
].join('\n');

async function reply(text: string): Promise<string> {
  const [cmd = '', arg = ''] = text.trim().split(/\s+/);
  switch (cmd.replace(/@\w+$/, '').toLowerCase()) {
    case '/status': return statusText();
    case '/pnl': return pnlText();
    case '/posisi': case '/position': return posText();
    case '/log': return logText(arg);
    case '/aireport': {
      if (isBusy()) return 'another operation is still running, wait';
      busy = true;
      await send('minta Claude baca status posisi (sekitar 30 detik)…');
      try {
        return await aiReportText();
      } catch (e) {
        return 'failed: ' + (e instanceof Error ? e.message.slice(0, 200) : 'unknown');
      } finally {
        busy = false;
      }
    }
    case '/scan':
    case '/suggest': {
      if (isBusy()) return 'another operation is still running, wait';
      busy = true;
      await send(cmd.startsWith('/scan') ? 'scanning…' : 'ambil top 10 trending, minta Claude analisis + sentimen X (bisa 3-6 menit)…');
      try {
        return cmd.startsWith('/scan') ? await scanText() : await suggestText(arg);
      } catch (e) {
        return 'failed: ' + (e instanceof Error ? e.message.slice(0, 200) : 'unknown');
      } finally {
        busy = false;
      }
    }
    case '/startbot': return botPid() ? 'bot sudah jalan' : arm('NYALAKAN BOT (build ulang lalu start, uang asli; bot akan melanjutkan posisi yang terbuka dan boleh masuk pool sendiri)', startBot);
    case '/stopbot': return botPid() ? arm('MATIKAN BOT (posisi yang terbuka TIDAK ditutup dan tidak dikelola)', () => stopBot(arg === 'force')) : 'bot sudah mati';
    case '/open': return openCmd(text.trim().slice(cmd.length).trim(), 'bid');
    case '/openmarket': return openCmd(text.trim().slice(cmd.length).trim(), 'market');
    case '/openpool': return openCmd(text.trim().slice(cmd.length).trim(), 'bot');
    case '/orders': return ordersCmd();
    case '/cancelorder': return cancelOrderCmd(arg);
    case '/close': return closeCmd(arg);
    case '/clean': return cleanCmd(arg);
    case '/ya': return confirmText(arg);
    case '/batal': pending = null; return 'dibatalkan';
    case '/help': case '/start': return HELP;
    default: return 'unknown command. /help';
  }
}

async function main(): Promise<void> {
  let logPath = newestLog();
  let offset = logPath ? statSync(logPath).size : 0; // start at the end: no backlog spam
  let wasAlive = botAlive();
  let updateOffset = 0;
  const first = (await (await fetch(`${API}/getUpdates?offset=-1`)).json()) as { result?: { update_id: number }[] };
  if (first.result?.length) updateOffset = first.result[first.result.length - 1]!.update_id + 1;
  await fetch(`${API}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: HELP.split('\n').map((l) => ({ command: l.slice(1, l.indexOf(' ')).replace('[n]', ''), description: l.slice(l.indexOf('–') + 2) })) }),
  }).catch(() => undefined);
  await send(`telegram notifier online (bot ${wasAlive ? 'running' : 'stopped'}). /help for commands.`);

  setInterval(async () => {
    try {
      const cur = newestLog();
      if (cur && cur !== logPath) {
        logPath = cur;
        offset = 0;
      }
      if (logPath) {
        const chunk = readFrom(logPath, offset);
        offset += Buffer.byteLength(chunk);
        const hits = chunk.split('\n').filter((l) => EVENT_RE.test(l)).map((l) => scrub(l).slice(0, 300));
        if (hits.length) await send(hits.slice(0, 8).join('\n') + (hits.length > 8 ? `\n…+${hits.length - 8} more` : ''));
      }
      const alive = botAlive();
      if (alive !== wasAlive) await send(alive ? 'bot STARTED' : 'bot STOPPED');
      wasAlive = alive;
    } catch (e) {
      console.error('tick failed', e instanceof Error ? e.message : e);
    }
  }, 10_000);

  for (;;) {
    try {
      const r = (await (await fetch(`${API}/getUpdates?timeout=25&offset=${updateOffset}`)).json()) as { result?: { update_id: number; message?: { chat?: { id: number }; text?: string } }[] };
      for (const u of r.result ?? []) {
        updateOffset = u.update_id + 1;
        if (String(u.message?.chat?.id) !== CHAT) continue; // only the owner is ever answered
        if ((u.message?.text ?? '').startsWith('/')) await send(await reply(u.message!.text!));
      }
    } catch {
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

void main();
