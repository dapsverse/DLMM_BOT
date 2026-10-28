/** Telegram text for the other bot log events (pure): entered pool, AI manager, close/complete, warnings/errors and a compact generic form for the rest. */
import { formatAiScreener, wibTime } from './telegramAiFormat.js';

const shortPool = (p: string) => (p.length > 14 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** +5.0% / -18.5% / +410% (no decimals from 100 up) */
const pct = (v: number) => `${v >= 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
const sol = (v: number) => `${v.toFixed(3)} SOL`;

/** realized PnL line of a finished exit: SOL and % of the deploy, the numbers state/ai-outcomes.jsonl records; null inputs = the exit legs were not measured reliably */
function realizedLine(pnlSol: number | null, pnlPct: number | null, deposit: number | null): string {
  if (pnlSol === null || pnlPct === null) return 'PnL realized: tidak terukur';
  const sg = (v: number, d: number) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  return `PnL realized ${sg(pnlSol, 4)} SOL (${sg(pnlPct, 2)}% dari modal deploy${deposit !== null ? ` ${sol(deposit)}` : ''})`;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

function enteredPool(pool: string, d: Obj, time: string): string {
  const cap = num(d.capitalSol);
  const out = [`✅ Masuk pool ${shortPool(pool)}${cap !== null ? ` | modal ${sol(cap)}` : ''}`];
  const buy = num(d.buyRatio1h);
  const l2 = [
    num(d.priceChange1hPct) !== null ? `1h ${pct(d.priceChange1hPct as number)}` : '',
    num(d.priceChange6hPct) !== null ? `6h ${pct(d.priceChange6hPct as number)}` : '',
    num(d.priceChange24hPct) !== null ? `24h ${pct(d.priceChange24hPct as number)}` : '',
    num(d.volumeSpikeRatio) !== null ? `vol spike ${(d.volumeSpikeRatio as number).toFixed(2)}x` : '',
    buy !== null ? `buy ${(buy * 100).toFixed(0)}%` : '',
  ].filter(Boolean);
  if (l2.length) out.push(l2.join(' · '));
  const pc = obj(d.priceContext);
  const fy = obj(d.feeYield);
  const low = num(pc?.aboveLow48hPct);
  const high = num(pc?.belowHigh48hPct);
  const l3 = [
    low !== null || high !== null ? `48h: ${[low !== null ? `${pct(low)} dari low` : '', high !== null ? `${pct(high)} dari high` : ''].filter(Boolean).join(', ')}` : '',
    typeof pc?.higherLow === 'boolean' ? `higher low ${pc.higherLow ? '✓' : '✗'}` : '',
    num(fy?.r24h) !== null ? `fee yield 24h ${(fy!.r24h as number).toFixed(1)}%` : '',
  ].filter(Boolean);
  if (l3.length) out.push(l3.join(' · '));
  if (time) out.push(time);
  return out.join('\n');
}

function aiManager(msg: string, d: Obj, time: string): string | undefined {
  const pool = typeof d.pool === 'string' ? shortPool(d.pool) : '';
  if (msg === 'manager triggered') return [`🧠 AI Manager dipicu${pool ? ` · pool ${pool}` : ''}`, typeof d.trigger === 'string' ? d.trigger : '', time].filter(Boolean).join('\n');
  if (msg !== 'manager decision') return undefined;
  const close = d.action === 'close';
  const meta = [num(d.turns) !== null ? `turns ${d.turns}` : '', Array.isArray(d.tools) ? `${d.tools.length} tool calls` : '', num(d.costUsd) !== null ? `cost $${(d.costUsd as number).toFixed(3)}` : '', time].filter(Boolean);
  return [`${close ? '🔴' : '⏸'} AI Manager: ${String(d.action ?? '?').toUpperCase()}${pool ? ` · pool ${pool}` : ''}`, typeof d.reason === 'string' ? d.reason : '', meta.join(' · ')].filter(Boolean).join('\n');
}

/** one value of the generic form: long ids shortened, arrays counted (string arrays joined), signatures dropped by the caller */
function show(v: unknown): string {
  if (typeof v === 'number') return String(Number(v.toPrecision(5)));
  if (typeof v === 'string') return /^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v.slice(0, 200);
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? v.join('; ').slice(0, 300) : `[${v.length}]`;
  const o = obj(v);
  return o ? `(${Object.entries(o).slice(0, 8).map(([k, x]) => `${k} ${show(x)}`).join(', ')})` : String(v);
}

function generic(level: string, mod: string, msg: string, d: Obj | null, time: string): string {
  const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const kv = d ? Object.entries(d).filter(([k, v]) => !/^signatures?$/.test(k) && v !== null && v !== undefined).map(([k, v]) => `${k} ${show(v)}`).join(' · ') : '';
  return [`${icon} ${msg}`.trim(), kv.slice(0, 600), `${mod}${time ? ` · ${time}` : ''}`].filter(Boolean).join('\n');
}

/**
 * Text for one (ANSI-free) log line. `undefined` = not parsable, the caller keeps the raw line; `null` = drop (a duplicate of an earlier line);
 * AI screener lines go through formatAiScreener (PR #13).
 */
export function formatEvent(line: string): string | null | undefined {
  const s = formatAiScreener(line);
  if (s !== undefined) return s;
  const m = /^(?:\S+Z\s+)?\[(\w+)\]\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
  if (!m) return undefined;
  const [, level, mod, rest] = m as unknown as [string, string, string, string];
  const at = rest.indexOf(' {');
  const msg = (at < 0 ? rest : rest.slice(0, at)).trim();
  let d: Obj | null = null;
  if (at >= 0) {
    try {
      d = obj(JSON.parse(rest.slice(at + 1)));
    } catch {
      return undefined;
    }
    if (!d) return undefined;
  }
  const time = wibTime(line);
  if (mod === 'index' && msg.startsWith('AI manager: closing position')) return null; // repeats the "[ai] manager decision" close line logged just before
  const ep = /^entered pool (\S+)$/.exec(msg);
  if (ep && d) return enteredPool(ep[1]!, d, time);
  if (mod === 'ai' && d) {
    const r = aiManager(msg, d, time);
    if (r) return r;
  }
  const cl = /^(\w+)(: closing position| complete)$/.exec(msg);
  if (mod === 'rebalanceEngine' && cl && d) {
    const pool = typeof d.pool === 'string' ? shortPool(d.pool) : '';
    // realized PnL only exists once the close and the token swap are done, so the closing message just announces it
    // why the bot closed (the exit kinds share the TAKE_PROFIT execution path, so the prefix alone does not say); old log lines have no reason
    const why = typeof d.reason === 'string' && d.reason.trim() ? `Alasan: ${d.reason.trim().slice(0, 200)}` : '';
    if (cl[2] === ': closing position') return [`🔻 ${cl[1]}: menutup posisi${pool ? ` ${pool}` : ''}`, why, 'PnL realized menyusul', time].filter(Boolean).join('\n');
    const bal = num(d.solBalance);
    const next = num(d.nextCapital);
    // old log lines (no realizedPnlSol key at all) keep the old format
    const pnl = 'realizedPnlSol' in d ? realizedLine(num(d.realizedPnlSol), num(d.realizedPnlPct), num(d.depositSol)) : '';
    return [`✅ ${cl[1]} selesai${pool ? ` · pool ${pool}` : ''}`, [bal !== null ? `saldo wallet ${sol(bal)}` : '', next !== null ? `modal berikut ${sol(next)}` : ''].filter(Boolean).join(' · '), pnl, why, time].filter(Boolean).join('\n');
  }
  return generic(level, mod, msg, d, time);
}

/** Drops a message identical to one seen within `windowMs` (the WIB time line is ignored), so a line the bot repeats every tick is sent once per window. */
export function createDeduper(windowMs: number): (msg: string, nowMs?: number) => boolean {
  const seen = new Map<string, number>();
  return (msg, nowMs = Date.now()) => {
    for (const [k, t] of seen) if (nowMs - t >= windowMs) seen.delete(k);
    const key = msg.replace(/\d{2}:\d{2} WIB/g, '');
    if (seen.has(key)) return true;
    seen.set(key, nowMs);
    return false;
  };
}
