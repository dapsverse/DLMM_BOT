/**
 * Emergency swap-back slippage escalation (pure). Live 2026-11-11 STANK-SOL: the exit swap of a dumping token failed 4x with Jupiter 6001 (0x1771, slippage
 * exceeded) at a fixed JUPITER_EXIT_SLIPPAGE_BPS and only landed on a later retry. Each retry attempt now widens the tolerance by `stepBps`, capped at `maxBps`.
 */
export function escalatedSlippageBps(baseBps: number, attempt: number, stepBps: number, maxBps: number): number {
  const cap = Math.max(baseBps, maxBps); // a cap below the base never lowers the base
  if (!(stepBps > 0) || !(attempt > 0)) return Math.min(baseBps, cap);
  return Math.min(baseBps + attempt * stepBps, cap);
}
