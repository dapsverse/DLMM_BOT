/**
 * Event kind(s) of an outgoing Telegram message, for the "[notify] sent" log line. Derived from the formatted text labels
 * (logic/telegramEventFormat.ts, telegramAiFormat.ts); only the kind is logged, never the content. Pure.
 */
export function notifyKinds(text: string): string {
  const kinds: string[] = [];
  if (text.includes('AI Manager')) kinds.push('ai-manager');
  if (text.includes('AI Screener')) kinds.push('ai-screener');
  return kinds.length ? kinds.join('+') : 'event';
}
