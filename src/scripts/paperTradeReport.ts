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

/** True if a process with this pid is actually still alive (signal 0 = liveness probe, doesn't kill it). */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false; // state file predates the `pid` field, or malformed — treat as not verifiable/dead
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (no such process) or EPERM — either way, not a live run we own
  }
}

function printRun(state: any): void {
  const sign = state.pnlUsd >= 0 ? '+' : '';
  const status = state.finished ? 'FINISHED' : isProcessAlive(state.pid) ? 'running' : 'DEAD (stale)';
  console.log(`\n═══ ${state.label ?? 'unlabeled'} (${status}) ═══`);
  console.log(`  Elapsed: ${state.elapsedHours}h / ${state.durationHours}h`);
  console.log(`  Starting capital: $${state.startingCapitalUsd?.toFixed(2) ?? 'n/a'} (${state.startingCapitalSol ?? 'n/a'} SOL)`);
  console.log(`  Current value:    $${state.currentValueUsd} [${state.currentValueSol ?? 'n/a'} SOL]`);
  console.log(`  Total PNL (with fees): ${sign}$${state.pnlUsd} (${sign}${state.pnlPct}%)`);
  console.log(`  Fees only:             $${state.totalFeesEarnedUsd?.toFixed(2) ?? 'n/a'} (${state.totalFeesEarnedSol ?? 'n/a'} SOL)`);
  console.log(`  Pools entered: ${state.poolsEntered}  Rebalances: ${state.rebalances}  Hard exits: ${state.hardExits}`);
  if (state.currentPosition) {
    console.log(`  Currently in: ${state.currentPosition.pool} (${state.currentPosition.address})`);
    const bin = state.currentPosition.bin;
    if (bin) {
      // DLMM only: state.currentPosition.capitalUsd is the entry/last-compound
      // deposit — frozen, NOT live mark-to-market (only reassigned on
      // compound, see paperTrade.ts). The live LP principal (price/IL since
      // then, excluding fees) is recoverable from fields already written by
      // the running process, no writer change needed: currentValueUsd
      // already = livePrincipal + feesEarnedUsd + harvestedFeesUsd (past
      // positions' realized fees, 0 for a still-first position). Spot has no
      // equivalent split — its capitalUsd IS already live (see
      // spotExecutor.ts's writeState), so this branch is DLMM-specific
      // (detected via the `bin` field, which spot never writes).
      const entryCapitalUsd = state.currentPosition.capitalUsd;
      const unclaimedFeesUsd = state.currentPosition.feesEarnedUsd ?? 0;
      const harvestedFeesUsd = state.harvestedFeesUsd ?? 0;
      const liveLpPrincipalUsd = +(state.currentValueUsd - unclaimedFeesUsd - harvestedFeesUsd).toFixed(2);
      const solPriceUsd = state.currentValueSol ? state.currentValueUsd / state.currentValueSol : null;
      const liveLpPrincipalSol = solPriceUsd ? +(liveLpPrincipalUsd / solPriceUsd).toFixed(4) : null;
      const priceIlPct = entryCapitalUsd ? +(((liveLpPrincipalUsd - entryCapitalUsd) / entryCapitalUsd) * 100).toFixed(2) : null;
      console.log(`    entry capital=$${entryCapitalUsd} (${state.currentPosition.capitalSol ?? 'n/a'} SOL) — frozen at last entry/compound, not live`);
      console.log(
        `    live LP principal=$${liveLpPrincipalUsd} (${liveLpPrincipalSol ?? 'n/a'} SOL)${priceIlPct !== null ? `  [price/IL since entry: ${priceIlPct >= 0 ? '+' : ''}${priceIlPct}%]` : ''}`,
      );
      console.log(`    unclaimed fees=$${unclaimedFeesUsd}  →  position total (principal+fees)=$${(liveLpPrincipalUsd + unclaimedFeesUsd).toFixed(2)}`);
      if (bin.currentBinId === null || bin.centerBinId === null) {
        console.log('    price range: unavailable (RPC read failed this tick)');
      } else if (bin.priceRangeSol) {
        const statusLabel = bin.inRange ? 'IN RANGE' : `OUT OF RANGE (${bin.binsFromCenter > 0 ? '+' : ''}${bin.binsFromCenter} bins from center)`;
        console.log(
          `    range: ${formatPrice(bin.priceRangeSol.low)} SOL - ${formatPrice(bin.priceRangeSol.high)} SOL  (current: ${formatPrice(bin.priceRangeSol.current)} SOL)  ${statusLabel}`,
        );
        console.log(`    (bin ${bin.currentBinId}, range [${bin.rangeMinBinId}, ${bin.rangeMaxBinId}])`);
      }
    } else {
      // Spot: capitalUsd is already the live mark-to-market value and
      // feesEarnedUsd is always 0 (no LP fees) — no breakdown needed.
      console.log(`    capital=$${state.currentPosition.capitalUsd} (${state.currentPosition.capitalSol ?? 'n/a'} SOL)  unclaimed fees=$${state.currentPosition.feesEarnedUsd}`);
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

// Auto-clean orphaned state files: a run that was killed (not stopped via its
// own DURATION_HOURS elapsing) leaves its state-<label>.json behind forever,
// showing "running" indefinitely since nothing ever marks it finished.
// process.kill(pid, 0) is a liveness probe here, not an actual kill.
const runs: any[] = [];
for (const f of files) {
  const filePath = path.join(env.LOG_DIR, f);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!state.finished && !isProcessAlive(state.pid)) {
    fs.rmSync(filePath, { force: true });
    const label = state.label && state.label !== 'default' ? state.label : undefined;
    const stdoutLog = path.join(env.LOG_DIR, label ? `paper-trade-${label}-stdout.log` : 'paper-trade-stdout.log');
    fs.rmSync(stdoutLog, { force: true });
    console.log(`(removed stale state for "${state.label ?? 'unlabeled'}" — process ${state.pid ?? '?'} not running)`);
    continue;
  }
  runs.push(state);
}
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
