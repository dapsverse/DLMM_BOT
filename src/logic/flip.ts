import type { MeridianExitConfig } from './meridianExit.js';

/**
 * Bid-ask flip (yunus-0x/meridian strategy 1, meridian mode): a SOL-only bid-ask ladder (DCA-in) whose token share reaches
 * FLIP_TOKEN_SHARE_PCT is closed and redeposited token-only as a bid-ask ABOVE the price (DCA-out). Pure decisions only; the
 * on-chain steps live in rebalanceEngine.executeFlip. Kept import-free of the wallet so self-checks can load it.
 */
export interface SideFlags {
  tokenSpot?: boolean;
  flipPhase?: boolean;
}

/** Token-only position above the price: geometry/range status use the token-side bounds (same as token_spot). */
export const isTokenSide = (c: SideFlags): boolean => !!c.tokenSpot || !!c.flipPhase;

export function strategyLabel(c: SideFlags): 'sol_ladder' | 'token_spot' | 'bid_ask_flip' {
  return c.flipPhase ? 'bid_ask_flip' : c.tokenSpot ? 'token_spot' : 'sol_ladder';
}

export interface ShouldFlipInput {
  enabled: boolean;
  /** non-SOL principal / position value * 100 */
  sharePct: number;
  thresholdPct: number;
  isLadder: boolean;
  tokenSpot: boolean;
  flipPhase: boolean;
}

export function shouldFlip(i: ShouldFlipInput): boolean {
  return i.enabled && i.isLadder && !i.tokenSpot && !i.flipPhase && Number.isFinite(i.sharePct) && i.sharePct >= i.thresholdPct;
}

/** SOL value the PnL is measured on: position value (+ unclaimed fees in meridian mode) + the SOL banked at the flip - the estimated cost of selling the token side. */
export function pnlBasisSol(valueSol: number, feesSol: number, bankedSol: number, includeFees: boolean, exitCostSol = 0): number {
  return valueSol + (includeFees ? feesSol : 0) + bankedSol - exitCostSol;
}

/**
 * Exit rules of the flip phase: no fixed TP (the final TP is the "pumped far above range" close), trailing arms at
 * `trailingTriggerPct`, no OOR timer while the price is BELOW the range (`waitForBounce`: wait for the bounce; SL is handled by
 * the caller). Above the range (token sold out, all SOL, earning nothing) the standard OOR wait still applies. Everything else is meridian's.
 */
export function flipExitConfig(base: MeridianExitConfig, trailingTriggerPct: number, waitForBounce: boolean): MeridianExitConfig {
  return { ...base, takeProfitPct: Infinity, trailingTriggerPct, outOfRangeWaitMinutes: waitForBounce ? Infinity : base.outOfRangeWaitMinutes };
}

/** Inverse of ladderBounds: the anchor edge (`centerBinId`) of a token-only position from its on-chain bin range. depositIsX = the deposited token is X. */
export function flipCenterFromBounds(lowerBinId: number, upperBinId: number, depositIsX: boolean): number {
  return depositIsX ? lowerBinId : upperBinId;
}

/** What the AI prompts need to describe the flip; null when the flip is off (never describe behaviour that is disabled). */
export interface FlipPromptInfo {
  tokenSharePct: number;
  trailingTriggerPct: number;
  trailingDropPct: number;
  stopLossPct: number;
}

export function flipPromptInfo(e: { FLIP_ENABLED: boolean; FLIP_TOKEN_SHARE_PCT: number; FLIP_TRAILING_TRIGGER_PCT: number; MERIDIAN_TRAILING_DROP_PCT: number; STOP_LOSS_PCT: number }): FlipPromptInfo | null {
  if (!e.FLIP_ENABLED) return null;
  return { tokenSharePct: e.FLIP_TOKEN_SHARE_PCT, trailingTriggerPct: e.FLIP_TRAILING_TRIGGER_PCT, trailingDropPct: e.MERIDIAN_TRAILING_DROP_PCT, stopLossPct: e.STOP_LOSS_PCT };
}
