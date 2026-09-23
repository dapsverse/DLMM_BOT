/**
 * Prints every paper-trade snapshot found in LOG_DIR (paper-trade-state.json
 * = legacy/unlabeled run, paper-trade-state-<label>.json = a labeled run
 * started with PAPER_TRADE_LABEL=<label>). Safe to run anytime — reads
 * whatever paperTrade.ts last wrote, running or finished.
 * Usage: npm run paper-trade:report
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

/** N significant figures, plain decimal (no exponential notation) — readable for both $100 and $0.0000136 prices. */
function formatPrice(p: number, sigFigs = 4): string {
  if (!Number.isFinite(p) || p === 0) return '0';
  const decimals = Math.max(0, sigFigs - Math.floor(Math.log10(Math.abs(p))) - 1);
  return p.toFixed(Math.min(decimals, 18));
}

function printRun(state: any): void {
  const sign = state.pnlUsd >= 0 ? '+' : '';
  console.log(`\n═══ ${state.label ?? 'unlabeled'} (${state.finished ? 'FINISHED' : 'running'}) ═══`);
  console.log(`  Elapsed: ${state.elapsedHours}h / ${state.durationHours}h`);
  console.log(`  Starting capital: $${state.startingCapitalUsd?.toFixed(2) ?? 'n/a'} (${state.startingCapitalSol ?? 'n/a'} SOL)`);
  console.log(`  Current value:    $${state.currentValueUsd} (${sign}${state.pnlUsd} / ${sign}${state.pnlPct}%)  [${state.currentValueSol ?? 'n/a'} SOL]`);
  console.log(`  Pools entered: ${state.poolsEntered}  Rebalances: ${state.rebalances}  Hard exits: ${state.hardExits}`);
  if (state.currentPosition) {
    console.log(`  Currently in: ${state.currentPosition.pool} (${state.currentPosition.address})`);
    console.log(`    capital=$${state.currentPosition.capitalUsd} (${state.currentPosition.capitalSol ?? 'n/a'} SOL)  unclaimed fees=$${state.currentPosition.feesEarnedUsd}`);
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
    console.log('  Pool history (cross-check these on DexScreener/Meteora):');
    history.forEach((v: any, i: number) => {
      const pnl = v.exitValueUsd !== undefined ? v.exitValueUsd - v.entryCapitalUsd : null;
      const solPart = v.exitValueSol !== undefined ? `, ${v.exitValueSol} SOL` : '';
      const status = v.exitedAtMs ? `exited ${v.exitType} @ $${v.exitValueUsd}${solPart} (${pnl! >= 0 ? '+' : ''}${pnl!.toFixed(2)})` : 'still open';
      console.log(`    ${i + 1}. ${v.pool}  (${v.address})`);
      console.log(`       entry=$${v.entryCapitalUsd} (${v.entryCapitalSol ?? 'n/a'} SOL)  rebalances=${v.rebalanceCount}  ${status}`);
      if (v.exitReasons?.length) console.log(`       exit reason: ${v.exitReasons.join('; ')}`);
    });
  }

  console.log(`  Full event log: ${state.jsonlLog}`);
}

const files = fs
  .readdirSync(env.LOG_DIR)
  .filter((f) => f === 'paper-trade-state.json' || (f.startsWith('paper-trade-state-') && f.endsWith('.json')))
  .sort();

if (!files.length) {
  console.log('No paper-trade run found yet. Start one with: npm run paper-trade');
  process.exit(1);
}

const runs = files.map((f) => JSON.parse(fs.readFileSync(path.join(env.LOG_DIR, f), 'utf8')));
runs.forEach(printRun);

if (runs.length > 1) {
  console.log('\n═══ Comparison ═══');
  runs
    .slice()
    .sort((a, b) => b.pnlPct - a.pnlPct)
    .forEach((r, i) => {
      const sign = r.pnlPct >= 0 ? '+' : '';
      console.log(`  ${i + 1}. ${r.label ?? 'unlabeled'}: ${sign}${r.pnlPct}%  ($${r.currentValueUsd}, ${r.elapsedHours}h elapsed)`);
    });
}
console.log('');
