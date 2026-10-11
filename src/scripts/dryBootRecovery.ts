/**
 * Read-only dry run of the boot recovery (src/logic/bootRecovery.ts): prints what the live bot WOULD resume
 * (pool, source, bookkeeping, current value) without starting the loop or touching anything on-chain.
 * Usage: set -a; . ./.env.live; set +a; npx tsx src/scripts/dryBootRecovery.ts
 */
import { recoverOnBoot } from '../logic/bootRecovery.js';
import { getPositionHealthSnapshot } from '../logic/rebalanceEngine.js';

const r = await recoverOnBoot();
console.log('plan:', JSON.stringify(r.plan));
console.log('state file:', r.state ? `saved ${new Date(r.state.savedAtMs).toISOString()}, inFlight=${r.state.inFlight}, capital=${r.state.currentCapitalSol}, blacklist=${r.state.blacklist.length}, chaseGuard=${r.state.chaseGuard.length}` : 'none/invalid');
if (r.ctx) {
  const { pool: _pool, ...rest } = r.ctx;
  console.log('source:', r.source);
  console.log('context:', JSON.stringify(rest));
  const snap = await getPositionHealthSnapshot(r.ctx);
  console.log('health:', JSON.stringify(snap), 'profit vs basis %:', (((snap.currentValueSol - r.ctx.initialDepositSol) / r.ctx.initialDepositSol) * 100).toFixed(2));
}
process.exit(0);
