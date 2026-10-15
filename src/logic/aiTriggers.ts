/** Meridian-style hybrid management: the LLM manager runs only when something needs a judgement (or as a slow periodic health check). Pure. */

export interface ManagerTriggerInput {
  isOutOfRange: boolean;
  minutesOutOfRange: number | null;
  profitPct: number;
  volumeVsBaselinePct: number | null;
  tokenSharePct: number;
  minutesSinceLastCall: number;
}

export interface ManagerTriggerLimits {
  /** slow periodic health check, minutes */
  periodicMin: number;
  /** minimum gap between event-triggered calls, minutes */
  cooldownMin: number;
  oorMin: number;
  lossPct: number;
  volumeBelowPct: number;
}

/** Returns why the manager should be called now, or null to skip (the automatic exits keep running either way). */
export function managerTrigger(i: ManagerTriggerInput, l: ManagerTriggerLimits): string | null {
  if (i.minutesSinceLastCall >= l.periodicMin) return 'periodic health check';
  if (i.minutesSinceLastCall < l.cooldownMin) return null;
  if (i.isOutOfRange && (i.minutesOutOfRange ?? 0) >= l.oorMin) return `out of range ${i.minutesOutOfRange}min`;
  if (i.profitPct <= -l.lossPct) return `loss ${i.profitPct.toFixed(1)}%`;
  if (i.volumeVsBaselinePct !== null && i.volumeVsBaselinePct < l.volumeBelowPct) return `volume at ${i.volumeVsBaselinePct}% of baseline`;
  if (i.tokenSharePct > 0 && i.profitPct < 0) return `holding token (${i.tokenSharePct.toFixed(0)}%) at a loss`;
  return null;
}
