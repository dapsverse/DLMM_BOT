/**
 * Standalone Telegram companion for the live bot (no Claude session, no bot dependencies).
 * - pushes key events from the newest logs/live-*.log (entries, exits, limit orders, errors) and a "bot stopped" alert
 * - answers /status from YOUR chat id only (everything else is ignored)
 * Run: npx tsx src/scripts/telegramNotify.ts   (reads .env.telegram + RPC_URL from .env.live; prints no secrets)
 */
import { execSync } from 'node:child_process';
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

async function statusText(): Promise<string> {
  const lines: string[] = [`bot: ${botAlive() ? 'RUNNING' : 'STOPPED'}`];
  let wallet: string | null = null;
  let posPool: string | null = null;
  try {
    const s = JSON.parse(readFileSync('state/live-state.json', 'utf8')) as { wallet?: string; position?: { poolAddress: string } | null; pendingLimitOrder?: unknown; pendingSwapBack?: unknown };
    wallet = s.wallet ?? null;
    posPool = s.position?.poolAddress ?? null;
    lines.push(posPool ? `position: ${posPool.slice(0, 6)}…` : 'position: none (flat)');
    if (s.pendingLimitOrder) lines.push('pending limit order: yes');
    if (s.pendingSwapBack) lines.push('pending swap-back: yes');
  } catch {
    lines.push('state file unreadable');
  }
  const sol = wallet ? await walletSol(wallet) : null;
  if (sol !== null) lines.push(`wallet SOL: ${sol.toFixed(4)}`);
  const log = newestLog();
  if (log && posPool) {
    const tail = readFileSync(log, 'utf8').split('\n').reverse().find((l) => l.includes('health check'));
    const m = tail && /^(\S+).*health check (\{.*\})/.exec(tail);
    if (m) {
      try {
        const h = JSON.parse(m[2]!) as { currentValueSol: number; unclaimedFeesSol: number; isOutOfRange: boolean; currentBinId: number };
        lines.push(`pos value ${h.currentValueSol.toFixed(4)} + fees ${h.unclaimedFeesSol.toFixed(4)} SOL, bin ${h.currentBinId}${h.isOutOfRange ? ' OUT OF RANGE' : ''} (as of ${m[1]!.slice(11, 19)} UTC)`);
        if (sol !== null) lines.push(`equity ≈ ${(sol + h.currentValueSol + h.unclaimedFeesSol).toFixed(4)} SOL (excl. refundable rent)`);
      } catch {
        /* ignore */
      }
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  let logPath = newestLog();
  let offset = logPath ? statSync(logPath).size : 0; // start at the end: no backlog spam
  let wasAlive = botAlive();
  let updateOffset = 0;
  const first = (await (await fetch(`${API}/getUpdates?offset=-1`)).json()) as { result?: { update_id: number }[] };
  if (first.result?.length) updateOffset = first.result[first.result.length - 1]!.update_id + 1;
  await send(`telegram notifier online (bot ${wasAlive ? 'running' : 'stopped'}). /status for a snapshot.`);

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
        if (/^\/status\b/.test(u.message?.text ?? '')) await send(await statusText());
      }
    } catch {
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

void main();
