/**
 * Standalone Telegram companion for the live bot (no Claude session, no bot dependencies).
 * - pushes key events from the newest logs/live-*.log (entries, exits, limit orders, errors) and a "bot stopped" alert
 * - answers /status from YOUR chat id only (everything else is ignored)
 * Run: npx tsx src/scripts/telegramNotify.ts   (reads .env.telegram + RPC_URL from .env.live; prints no secrets)
 */
import { execFile, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';

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
const EVENT_RE = /entered pool|closing position|HARD_EXIT|TAKE_PROFIT|down-break|limit order (placed|cancelled)|entry bid (placed|settled)|\] error|stop-loss|REBALANCE|skipping pool .*transfer fee/i;

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
    return execSync('pgrep -f "node dist/index.js"', { encoding: 'utf8' }).trim().length > 0;
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
async function tokenHoldings(wallet: string): Promise<{ symbol: string; ui: number; sol: number | null }[]> {
  const out: { symbol: string; ui: number; sol: number | null }[] = [];
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
          const d = (await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)).json()) as { pairs?: { priceNative?: string; baseToken?: { symbol?: string } }[] };
          const pr = Number(d.pairs?.[0]?.priceNative);
          symbol = d.pairs?.[0]?.baseToken?.symbol ?? symbol;
          if (Number.isFinite(pr) && pr > 0) sol = ui * pr;
        } catch {
          /* unpriced */
        }
        if (sol === null || sol >= 0.0005) out.push({ symbol, ui, sol });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

const fmtHold = (h: { symbol: string; ui: number; sol: number | null }) => `${h.symbol} ${h.ui.toLocaleString('en', { maximumFractionDigits: 2 })}${h.sol === null ? ' (unpriced)' : ` ≈ ${h.sol.toFixed(4)} SOL`}`;

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
  const h = count ? lastHealth() : null;
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

async function scanText(): Promise<string> {
  const { stdout } = await run('npx', ['tsx', 'src/scripts/scanOnce.ts'], { env: childEnv(), timeout: 120_000, maxBuffer: 4_000_000 });
  return scrub(stdout).trim() || 'scan returned nothing';
}

async function suggestText(): Promise<string> {
  const scan = await scanText();
  if (/No pool passes/.test(scan)) return 'Tidak ada pool yang lolos filter bot sekarang, jadi tidak ada saran masuk. Tunggu scan berikutnya.\n\n' + scan.split('\n').slice(-2).join('\n');
  const ctx = await statusText();
  const prompt = [
    'Kamu penasihat untuk bot Meteora DLMM (mode range, modal ~1 SOL, uang asli). Jawab Bahasa Indonesia, maksimal 150 kata, tanpa tabel.',
    'Dari kandidat hasil scan di bawah, beri: (1) pool mana yang paling layak dimasuki atau "tidak ada" beserta alasan singkat berbasis data, (2) satu risiko utama per pool yang kamu sebut.',
    'Aturan bot: range ±6% pada bin step 50, bid limit 5% di bawah harga, stop-loss 25%, jangan token dengan transfer fee, hindari token yang sudah naik tajam (pump) atau dominan jual. Jangan mengarang data yang tidak ada di bawah; sebut jika datanya kurang. Ini saran, bukan kepastian.',
    '', 'KONDISI BOT:', ctx, '', 'HASIL SCAN:', scan.slice(0, 6000),
  ].join('\n');
  const child = execFile('claude', ['-p', '--tools', '', '--no-session-persistence'], { cwd: tmpdir(), timeout: 120_000, maxBuffer: 1_000_000 });
  child.stdin?.end(prompt);
  const out = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`claude exited ${code}`))));
  });
  return out.trim() || 'no answer';
}

const HELP = [
  '/status – bot up/down, position, wallet SOL',
  '/pnl – equity and PnL vs baselines',
  '/posisi – open position detail',
  '/log [n] – last n events (default 8, max 20)',
  '/scan – pools passing the bot filters right now (~20s)',
  '/suggest – Claude advice on the scan result (~40s)',
  '/help – this list',
].join('\n');

async function reply(text: string): Promise<string> {
  const [cmd = '', arg = ''] = text.trim().split(/\s+/);
  switch (cmd.replace(/@\w+$/, '').toLowerCase()) {
    case '/status': return statusText();
    case '/pnl': return pnlText();
    case '/posisi': case '/position': return posText();
    case '/log': return logText(arg);
    case '/scan':
    case '/suggest': {
      if (busy) return 'another scan/suggest is still running, wait';
      busy = true;
      await send(cmd.startsWith('/scan') ? 'scanning…' : 'scanning and asking Claude…');
      try {
        return cmd.startsWith('/scan') ? await scanText() : await suggestText();
      } catch (e) {
        return 'failed: ' + (e instanceof Error ? e.message.slice(0, 200) : 'unknown');
      } finally {
        busy = false;
      }
    }
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
