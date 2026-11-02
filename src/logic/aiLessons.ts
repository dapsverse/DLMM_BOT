/**
 * Standing lessons for the AI MANAGER (hold vs close). Our own, trusted text kept in git: the outcome memory (state/ai-outcomes.jsonl) is local and only shows
 * the latest lines, so a lesson worth keeping on every call lives here. Add a lesson only from a real loss, with the facts and how to apply it.
 */
export const STANDING_LESSONS: readonly string[] = [
  `Anakin-SOL 2026-11-02, sol_ladder closed by the stop loss at -25.8% (realized -26.07%, 358 min held, peak +2.4%):
- Entry: 1h -6.5%, price 17% under its 4h high, volume spike 0.22x (volume fading), 1h buyRatio 0.39 (sells ahead of buys), DexScreener boost 500 with no real website and no X account. RugCheck: 226 insiders, dev balance 0: not an LP rug, a dead-hype dump.
- Smart LP presence (3 of 35 tracked) and KOL net buying (+148 SOL) did NOT hold the price. Smart-money and social signals are not protection once the volume is gone.
- Path: you held at -5% and -9% as "the expected DCA-in mark-down" while the token share rose 58% -> 80%. The price then broke under the lowest bin, the bot flipped to 100% token, and in the flip phase you cannot close: the cycle went -9% -> -26% (stop loss) in about 3 minutes.
- How to apply: the hold-vs-close decision is made BEFORE the flip. For a sol_ladder with a rising token share (above about 60%), weigh closing early at a small loss when several of these stack: volume far under the entry baseline or spike under 0.3x, sells ahead of buys, new 1h/4h lows, price already deep under its 4h high, and an entry thesis built on hype (boost, KOL or smart-money narrative) rather than organic volume. A -5% to -10% close beats the forced flip. Do not close for tiny moves, or while volume and buys are healthy and the price is holding; say why in the reason.`,
];

/** Prompt section for the manager prompts; empty string when there are no lessons. */
export function standingLessonsBlock(): string {
  return STANDING_LESSONS.length ? `STANDING LESSONS (ours, from real losses; weigh them with the data, they are not rules):\n${STANDING_LESSONS.join('\n\n')}` : '';
}
