/**
 * Bid-ask flip (yunus-0x/meridian strategy 1, meridian mode): a SOL-only bid-ask ladder (DCA-in) whose price fell BELOW its lowest bin
 * (the SOL side is 100% token) is closed and redeposited token-only as a bid-ask ABOVE the old ladder's lower boundary (DCA-out).
 * Once flipped the position waits: no AI exit, no recenter, no out-of-range-below timer. The only exits are the cycle stop loss, a pool
 * liquidity collapse, and the ladder sold out above the range for FLIP_OOR_ABOVE_EXIT_MIN minutes. Pure decisions only; the on-chain steps
 * live in rebalanceEngine.executeFlip. Kept import-free of the wallet so self-checks can load it.
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
  /** price is below the lowest bin of the SOL ladder: the SOL side is 100% converted to the token (BinRangeStatus.tokenBelowRange of a ladder) */
  belowRange: boolean;
  isLadder: boolean;
  tokenSpot: boolean;
  flipPhase: boolean;
}

/** Flip only when the whole SOL side has become token (no share threshold: 80% used to flip too early and sold the dip's bounce). */
export function shouldFlip(i: ShouldFlipInput): boolean {
  return i.enabled && i.isLadder && !i.tokenSpot && !i.flipPhase && i.belowRange === true;
}

/** SOL value the PnL is measured on: position value (+ unclaimed fees in meridian mode) + the SOL banked at the flip - the estimated cost of selling the token side. */
export function pnlBasisSol(valueSol: number, feesSol: number, bankedSol: number, includeFees: boolean, exitCostSol = 0): number {
  return valueSol + (includeFees ? feesSol : 0) + bankedSol - exitCostSol;
}

export interface FlipExitInput {
  isOutOfRange: boolean;
  /** token-side range status: out of range BELOW = still all token (waiting for the bounce) */
  tokenBelowRange: boolean;
  minutesOutOfRange: number | null;
  /** pool TVL now / when the flip happened (USD); null = unknown, the liquidity check is skipped */
  tvlUsd: number | null;
  flipTvlUsd: number | null;
}

export interface FlipExitConfig {
  /** profit-taking close: ladder sold out and price above the range for this many minutes */
  oorAboveExitMin: number;
  /** liquidity collapse: pool TVL under this % of its TVL at the flip */
  tvlCollapsePct: number;
}

/**
 * Exit signals of the flip phase, besides the cycle stop loss (the caller handles that first). Everything else is OFF here on purpose:
 * no AI close, no trailing/take-profit, no low-yield, no pumped-above, no out-of-range-below timer, no recenter. Waiting for the bounce is the strategy.
 */
export function flipExitSignal(i: FlipExitInput, c: FlipExitConfig): string | null {
  if (i.tvlUsd !== null && i.flipTvlUsd !== null && i.flipTvlUsd > 0 && i.tvlUsd < (i.flipTvlUsd * c.tvlCollapsePct) / 100) {
    return `liquidity collapse: pool TVL $${i.tvlUsd.toFixed(0)} < ${c.tvlCollapsePct}% of $${i.flipTvlUsd.toFixed(0)} at flip`;
  }
  if (i.isOutOfRange && !i.tokenBelowRange && (i.minutesOutOfRange ?? 0) >= c.oorAboveExitMin) {
    // the text before the first ':' is the signal kind ExitConfirmer compares across ticks: keep it free of changing numbers
    return `flip sold out above range: ${Math.floor(i.minutesOutOfRange ?? 0)}m >= ${c.oorAboveExitMin}m`;
  }
  return null;
}

export interface ExitSignalInput {
  stopLoss: string | null;
  flipPhase: boolean;
  /** the SOL ladder is below its lowest bin and a flip is due */
  flipWanted: boolean;
  flipPhaseSignal: string | null;
  /** meridian's own rules (take profit, trailing, pumped-above, out-of-range wait, low yield) */
  meridianSignal: string | null;
}

/**
 * Which exit signal wins. The cycle stop loss always does. In the flip phase ONLY the flip-phase signals count (meridian's rules are off);
 * a due flip suppresses meridian's rules on the SOL ladder (a low-yield or TP close must not sell the dip the flip is about to hold).
 */
export function selectExitSignal(i: ExitSignalInput): string | null {
  if (i.stopLoss !== null) return i.stopLoss;
  if (i.flipPhase) return i.flipPhaseSignal;
  if (i.flipWanted) return null;
  return i.meridianSignal;
}

/** An AI manager close is never carried out in the flip phase (waiting for the bounce); the manager is not even consulted there. */
export const aiExitAllowed = (c: SideFlags): boolean => !c.flipPhase;

/**
 * Bin the flip ladder is anchored to. The old SOL ladder's price-bottom bin (the last bin the DCA-in reached) is `ladderBottomBinId`;
 * the token-only ladder starts above it (never below, even if price fell further), on the deposited side. `depositIsX` = the deposited token is X
 * (bin ids rise with price when the token is X: start above max(active, bottom); when the token is Y they fall with price: start below min(active, bottom)).
 */
export function flipAnchorBin(activeBinId: number, ladderBottomBinId: number | undefined, depositIsX: boolean): number {
  if (ladderBottomBinId === undefined) return activeBinId;
  return depositIsX ? Math.max(activeBinId, ladderBottomBinId) : Math.min(activeBinId, ladderBottomBinId);
}

/** Inverse of ladderBounds: the anchor edge (`centerBinId`) of a token-only position from its on-chain bin range. depositIsX = the deposited token is X. */
export function flipCenterFromBounds(lowerBinId: number, upperBinId: number, depositIsX: boolean): number {
  return depositIsX ? lowerBinId : upperBinId;
}

/** What the AI prompts need to describe the flip; null when the flip is off (never describe behaviour that is disabled). */
export interface FlipPromptInfo {
  oorAboveExitMin: number;
  stopLossPct: number;
}

export function flipPromptInfo(e: { FLIP_ENABLED: boolean; FLIP_OOR_ABOVE_EXIT_MIN: number; STOP_LOSS_PCT: number }): FlipPromptInfo | null {
  if (!e.FLIP_ENABLED) return null;
  return { oorAboveExitMin: e.FLIP_OOR_ABOVE_EXIT_MIN, stopLossPct: e.STOP_LOSS_PCT };
}
