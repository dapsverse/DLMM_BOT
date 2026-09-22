/**
 * Prints the latest paper-trade snapshot. Reads logs/paper-trade-state.json
 * (written by paperTrade.ts after every tick) — safe to run anytime while
 * the sim is running, or after it's done.
 * Usage: npm run paper-trade:report
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

const statePath = path.join(env.LOG_DIR, 'paper-trade-state.json');

if (!fs.existsSync(statePath)) {
  console.log('No paper-trade run found yet. Start one with: npm run paper-trade');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

/** N significant figures, plain decimal (no exponential notation) — readable for both $100 and $0.0000136 prices. */
function formatPrice(p: number, sigFigs = 4): string {
  if (!Number.isFinite(p) || p === 0) return '0';
  const decimals = Math.max(0, sigFigs - Math.floor(Math.log10(Math.abs(p))) - 1);
  return p.toFixed(Math.min(decimals, 18));
}

const sign = state.pnlUsd >= 0 ? '+' : '';
console.log(`\nPaper-trade report (${state.finished ? 'FINISHED' : 'running'})`);
console.log(`  Elapsed: ${state.elapsedHours}h / ${state.durationHours}h`);
console.log(`  Starting capital: $${state.startingCapitalUsd?.toFixed(2) ?? 'n/a'}`);
console.log(`  Current value:    $${state.currentValueUsd} (${sign}${state.pnlUsd} / ${sign}${state.pnlPct}%)`);
console.log(`  Pools entered: ${state.poolsEntered}  Rebalances: ${state.rebalances}  Hard exits: ${state.hardExits}`);
if (state.currentPosition) {
  console.log(`  Currently in: ${state.currentPosition.pool} (${state.currentPosition.address})`);
  console.log(`    capital=$${state.currentPosition.capitalUsd}  unclaimed fees=$${state.currentPosition.feesEarnedUsd}`);
  const bin = state.currentPosition.bin;
  if (bin) {
    if (bin.currentBinId === null || bin.centerBinId === null) {
      console.log('    price range: unavailable (RPC read failed this tick)');
    } else if (bin.priceRangeSol) {
      const statusLabel = bin.inRange ? 'IN RANGE' : `OUT OF RANGE (${bin.binsFromCenter > 0 ? '+' : ''}${bin.binsFromCenter} bins from center)`;
      console.log(
        `    range: ${formatPrice(bin.priceRangeSol.low)} SOL - ${formatPrice(bin.priceRangeSol.high)} SOL  (current: ${formatPrice(bin.priceRangeSol.current)} SOL)  ${statusLabel}`,
      );
      console.log(`    (bin ${bin.currentBinId}, range [${bin.rangeMinBinId}, ${bin.rangeMaxBinId}])`);
    }
  }
} else {
  console.log('  Currently: no open position (scanning)');
}

const history = state.poolHistory ?? [];
if (history.length) {
  console.log('\n  Pool history (cross-check these on DexScreener/Meteora):');
  history.forEach((v: any, i: number) => {
    const pnl = v.exitValueUsd !== undefined ? v.exitValueUsd - v.entryCapitalUsd : null;
    const status = v.exitedAtMs
      ? `exited ${v.exitType} @ $${v.exitValueUsd} (${pnl! >= 0 ? '+' : ''}${pnl!.toFixed(2)})`
      : 'still open';
    console.log(`  ${i + 1}. ${v.pool}  (${v.address})`);
    console.log(`     entry=$${v.entryCapitalUsd}  rebalances=${v.rebalanceCount}  ${status}`);
    if (v.exitReasons?.length) console.log(`     exit reason: ${v.exitReasons.join('; ')}`);
  });
}

console.log(`\n  Full event log: ${state.jsonlLog}\n`);
