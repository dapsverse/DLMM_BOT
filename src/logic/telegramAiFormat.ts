/** Telegram text for the AI screener log lines (pure). The notifier sends one readable message per decision instead of the raw log line. */

const WIB_MS = 7 * 3_600_000;

/** "2026-10-23T13:31:15.445Z ..." -> "20:31 WIB"; '' when the line has no ISO prefix */
export function wibTime(line: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\S+Z)/.exec(line);
  const t = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(t) ? new Date(t + WIB_MS).toISOString().slice(11, 16) + ' WIB' : '';
}

const shortPool = (p: string) => (p.length > 14 ? `${p.slice(0, 6)}…${p.slice(-6)}` : p);

/**
 * `undefined` = not an AI screener line (caller keeps its default formatting); `null` = drop it (the "[index] AI screener: skip" line repeats the
 * "[ai] screener decision" line that is logged just before it); otherwise the message text. ANSI codes must already be stripped.
 */
export function formatAiScreener(line: string): string | null | undefined {
  if (/\[index\] AI screener: skip/.test(line)) return null;
  const at = line.indexOf('[ai] screener decision');
  if (at < 0) return undefined;
  const j = line.indexOf('{', at);
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line.slice(j)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const deploy = d.action === 'deploy';
  const conv = typeof d.conviction === 'number' ? ` (conviction ${d.conviction}/10)` : '';
  const out = [`${deploy ? '🚀' : '🤖'} AI Screener: ${deploy ? 'DEPLOY' : 'SKIP'}${conv}`];
  if (deploy) {
    const bits = [typeof d.pool === 'string' ? `pool ${shortPool(d.pool)}` : '', typeof d.strategy === 'string' ? d.strategy : '', typeof d.bins === 'number' ? `${d.bins} bins` : ''].filter(Boolean);
    if (bits.length) out.push(bits.join(' · '));
  }
  if (typeof d.reason === 'string' && d.reason) out.push(d.reason);
  const meta = [
    typeof d.turns === 'number' ? `turns ${d.turns}` : '',
    Array.isArray(d.tools) ? `${d.tools.length} tool calls` : '',
    typeof d.costUsd === 'number' ? `cost $${d.costUsd.toFixed(3)}` : '',
    wibTime(line),
  ].filter(Boolean);
  if (meta.length) out.push(meta.join(' · '));
  return out.join('\n');
}
