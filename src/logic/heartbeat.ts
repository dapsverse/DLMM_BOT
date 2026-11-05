/**
 * Telegram heartbeat (pure, no imports): in-memory counters of the entry scan since the last heartbeat. The logger feeds every message to `heartbeat.onLogLine`
 * (utils/logger.ts), so no call site changes; index.ts emits one `[heartbeat] bot heartbeat` line every HEARTBEAT_INTERVAL_MIN; the notifier sends it only when it
 * has sent nothing else for that long (telegramNotify.ts), so a quiet bot says "alive, flat, why nothing passes" and a busy bot is never spammed.
 */

/** "skipping pool X — low yield: fee/TVL 24h 4.9% < 7% (...)" -> "low yield": the reason without its numbers, so counts group. */
export function skipReasonKey(reason: string): string {
  const head = reason.split(':')[0]!;
  return head.replace(/[\d.]+%?x?/g, 'N').replace(/\s+/g, ' ').slice(0, 40).trim() || 'unknown';
}

export interface HeartbeatSnapshot {
  windowMin: number;
  scans: number;
  /** pairs the scanner looked at / pairs that passed its filters, summed over the scans */
  pairs: number;
  passedScanner: number;
  skipped: number;
  /** passed the scanner and none of the entry skips: what reached the AI screener / entry */
  eligible: number;
  topSkips: [string, number][];
}

export function createHeartbeat(startMs: number = Date.now()) {
  let since = startMs;
  let scans = 0;
  let pairs = 0;
  let passedScanner = 0;
  const skips = new Map<string, number>();
  return {
    onLogLine(message: unknown): void {
      if (typeof message !== 'string') return;
      const sc = /^\[scanner\] (\d+)\/(\d+) pairs pass filters/.exec(message);
      if (sc) {
        scans++;
        passedScanner += Number(sc[1]);
        pairs += Number(sc[2]);
        return;
      }
      const sk = /^\[index\] skipping pool \S+ — (.*)$/s.exec(message);
      if (sk) {
        const k = skipReasonKey(sk[1]!);
        skips.set(k, (skips.get(k) ?? 0) + 1);
      }
    },
    /** true when `intervalMin` minutes passed since the last reset (0 or negative = never) */
    due(nowMs: number, intervalMin: number): boolean {
      return intervalMin > 0 && nowMs - since >= intervalMin * 60_000;
    },
    /** the counters of this window; resets them (the next window starts at `nowMs`) */
    take(nowMs: number): HeartbeatSnapshot {
      const skipped = [...skips.values()].reduce((a, b) => a + b, 0);
      const snap: HeartbeatSnapshot = {
        windowMin: Math.round((nowMs - since) / 60_000),
        scans,
        pairs,
        passedScanner,
        skipped,
        eligible: Math.max(passedScanner - skipped, 0),
        topSkips: [...skips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
      since = nowMs;
      scans = 0;
      pairs = 0;
      passedScanner = 0;
      skips.clear();
      return snap;
    },
  };
}

/** Process-wide counter set (the logger feeds it, index.ts drains it). */
export const heartbeat = createHeartbeat();

/** The notifier sends a heartbeat only when it sent nothing for `intervalMin` minutes (`lastSentMs` = its last send of anything). */
export function shouldSendHeartbeat(lastSentMs: number, nowMs: number, intervalMin: number): boolean {
  return intervalMin > 0 && nowMs - lastSentMs >= intervalMin * 60_000;
}

/** Interval (minutes) carried by a heartbeat log line, null when the line is not one. */
export function heartbeatIntervalOf(line: string): number | null {
  if (!/\[heartbeat\]\s+bot heartbeat/.test(line)) return null;
  const m = /"intervalMin":\s*(\d+(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) : 0;
}

const dur = (min: number): string => (min >= 60 ? `${Math.floor(min / 60)}j ${Math.round(min % 60)}m` : `${Math.round(min)}m`);

/** Telegram text of a heartbeat payload (the meta object of the log line). */
export function formatHeartbeat(d: Record<string, unknown>, time: string): string {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const top = Array.isArray(d.topSkips) ? (d.topSkips as unknown[]).filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string').map((x) => `${x[0]} ${n(x[1])}×`) : [];
  const status = typeof d.position === 'string' && d.position ? `ada posisi ${d.position}` : 'flat (tidak ada posisi)';
  return [
    `💓 Heartbeat DLMMBOT · ${dur(n(d.windowMin))} terakhir`,
    `Status: ${status} · uptime ${dur(n(d.uptimeMin))}`,
    `Scan ${n(d.scans)}× · pool dicek ${n(d.pairs)} · lolos filter scanner ${n(d.passedScanner)} · lolos semua gate ${n(d.eligible)}`,
    top.length ? `Skip teratas: ${top.join(' · ')}` : 'Skip teratas: -',
    time,
  ].filter(Boolean).join('\n');
}
