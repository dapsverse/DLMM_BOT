/**
 * Bounded resend queue for Telegram messages that failed all 3 send attempts (pure, no I/O). Live 2026-11-11: after a WSL reboot the notifier logged
 * 113 getUpdates failures and 3 messages failed 3/3 sends and were dropped. A failed message waits here and is retried on later ticks.
 * Bounded so a long outage never spams on recovery: at most `max` messages (oldest dropped), one attempt per message per `retryEveryMs`,
 * dropped after `maxTries` extra attempts or `maxAgeMs`, identical texts queued once.
 */
export interface QueuedMessage {
  text: string;
  chatId: string;
  kind: string;
  firstFailMs: number;
  lastTryMs: number;
  tries: number;
}

export interface RetryQueueOptions {
  max: number;
  maxTries: number;
  maxAgeMs: number;
  retryEveryMs: number;
}

export const DEFAULT_RETRY_QUEUE: RetryQueueOptions = { max: 20, maxTries: 10, maxAgeMs: 60 * 60_000, retryEveryMs: 60_000 };

export function createRetryQueue(o: RetryQueueOptions = DEFAULT_RETRY_QUEUE) {
  const q: QueuedMessage[] = [];
  let dropped = 0;
  return {
    /** a message that failed its 3 sends; an identical one already queued is not added again */
    push(m: { text: string; chatId: string; kind: string }, nowMs: number): void {
      if (q.some((x) => x.text === m.text && x.chatId === m.chatId)) return;
      q.push({ ...m, firstFailMs: nowMs, lastTryMs: nowMs, tries: 0 });
      while (q.length > o.max) {
        q.shift();
        dropped++;
      }
    },
    /** messages due for one more attempt now, oldest first (at most `n`); expired ones are removed and counted as dropped */
    due(nowMs: number, n = 3): QueuedMessage[] {
      for (let i = q.length - 1; i >= 0; i--) {
        const m = q[i]!;
        if (m.tries >= o.maxTries || nowMs - m.firstFailMs > o.maxAgeMs) {
          q.splice(i, 1);
          dropped++;
        }
      }
      return q.filter((m) => nowMs - m.lastTryMs >= o.retryEveryMs).slice(0, n);
    },
    /** result of one resend attempt */
    result(m: QueuedMessage, ok: boolean, nowMs: number): void {
      const i = q.indexOf(m);
      if (i < 0) return;
      if (ok) q.splice(i, 1);
      else {
        m.tries++;
        m.lastTryMs = nowMs;
      }
    },
    size: () => q.length,
    /** messages given up so far (queue full, too old or too many tries) */
    dropped: () => dropped,
  };
}

/** Prefix of a resent message, so it is clear it is late (time of the first failure, WIB). */
export function delayedPrefix(firstFailMs: number): string {
  const d = new Date(firstFailMs + 7 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `⏳ tertunda (gagal terkirim ${hh}:${mm} WIB)\n`;
}
