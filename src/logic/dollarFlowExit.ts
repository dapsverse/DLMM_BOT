/** A dollar-flow breach exits only after N qualified reads AND once the breach has lasted confirmMin minutes from its first read (reads overlap 1h windows, so back-to-back reads are one signal). */
export function isDollarFlowBreachConfirmed(count: number, sinceMs: number, nowMs: number, confirmations: number, confirmMin: number): boolean {
  return count >= confirmations && nowMs - sinceMs >= confirmMin * 60_000;
}
