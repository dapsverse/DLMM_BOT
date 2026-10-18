import { getWalletPubkey } from '../services/solana.js';
import { openPool, getAllPositionPoolAddresses, getUserPositions } from '../services/meteoraDLMM.js';
import { getVolume1hUsd } from '../services/meteoraScanner.js';
import { applyStaleTimers, loadState, reconcileBoot, type BootPlan, type PersistedState } from '../services/stateStore.js';
import { flipCenterFromBounds } from './flip.js';
import { contextFromPersisted, rebuildContextFromChain, type PoolContext } from './rebalanceEngine.js';

export interface BootRecovery {
  plan: BootPlan;
  state: PersistedState | null;
  /** Reattached position context (null when flat or ambiguous). */
  ctx: PoolContext | null;
  /** 'state' = bookkeeping restored from the state file; 'chain' = rebuilt from on-chain alone (deposit basis approximated). */
  source: 'state' | 'chain' | null;
}

/**
 * Boot-time recovery (read-only: never opens, closes or swaps anything). The on-chain position set is
 * the source of truth; the state file only supplies bookkeeping. Shared by index.ts main() and the
 * dry-run script (src/scripts/dryBootRecovery.ts).
 */
export async function recoverOnBoot(nowMs = Date.now()): Promise<BootRecovery> {
  const state = loadState(getWalletPubkey().toBase58());
  const chainPools = await getAllPositionPoolAddresses();
  const plan = reconcileBoot(state?.position?.poolAddress ?? null, chainPools);
  if (plan.kind !== 'resume') return { plan, state, ctx: null, source: null };

  const pool = await openPool(plan.poolAddress);
  if (plan.fromState && state?.position) {
    const pos = applyStaleTimers(state.position, state.savedAtMs, nowMs);
    const ctx = contextFromPersisted(pos, pool);
    if (ctx.flipPhase) {
      // a flip persisted before its redeposit landed may hold a stale anchor: re-derive it from the position on chain
      const [onChain] = await getUserPositions(pool);
      if (onChain) ctx.centerBinId = flipCenterFromBounds(onChain.positionData.lowerBinId, onChain.positionData.upperBinId, !ctx.xIsSol);
    }
    return { plan, state, ctx, source: 'state' };
  }
  const ctx = await rebuildContextFromChain(pool, plan.poolAddress);
  const otherMint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  ctx.volume1hBaselineUsd = (await getVolume1hUsd(otherMint)) ?? 0;
  ctx.volume1hBaselineSetAtMs = nowMs;
  return { plan, state, ctx, source: 'chain' };
}

