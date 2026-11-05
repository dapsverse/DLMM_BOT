/**
 * Wallet-free PAPER runner for one strategy of logic/paperStrategies.ts (env PAPER_STRATEGY = dipladder | calm | scalp).
 * Scans pools with the normal scanner (no wallet, no transaction), opens simulated 1-SOL positions when the strategy's entry rule passes, steps them over closed 5m
 * candles and logs NET PnL (+ hold-SOL / hold-token comparators) to state/paper-strategies/<name>.jsonl (open ones: <name>-open.json). Report: reportPaperStrategies.ts.
 * Refuses to start unless PRIVATE_KEY is the placeholder SHADOW_RUNNER_NO_KEY. Run as systemd user unit dlmm-paper-<name> (see the report).
 */
import fs from 'node:fs';
import { SHADOW_RUNNER_DUMMY_KEY, isRunnerKeySafe } from '../logic/shadowRunner.js';
import { PAPER_STRATEGIES, advancePaper, belowHighPct, entryReject, openPaper, type PaperCandidate } from '../logic/paperStrategies.js';

if (!isRunnerKeySafe(process.env.PRIVATE_KEY)) {
  console.error(`paperStrategies: refusing to start, PRIVATE_KEY must be exactly ${SHADOW_RUNNER_DUMMY_KEY}`);
  process.exit(1);
}
const strat = PAPER_STRATEGIES[process.env.PAPER_STRATEGY ?? ''];
if (!strat) {
  console.error(`paperStrategies: PAPER_STRATEGY must be one of ${Object.keys(PAPER_STRATEGIES).join(', ')}`);
  process.exit(1);
}

const { scanPools, defaultScannerConfig, volumeSpikeRatio } = await import('../services/meteoraScanner.js');
const { fetchCandles5m } = await import('../services/shadowLog.js');
const { appendSimLine, loadOpenSims, saveOpenSims } = await import('../services/shadowSimStore.js');
const { env } = await import('../config/env.js');
const { logger } = await import('../utils/logger.js');
type SimPosition = import('../logic/shadowSim.js').SimPosition;

const WSOL = 'So11111111111111111111111111111111111111112';
const dir = 'state/paper-strategies';
fs.mkdirSync(dir, { recursive: true });
const logFile = `${dir}/${strat.name}.jsonl`;
const openFile = `${dir}/${strat.name}-open.json`;
const costs = { exitCostPct: env.EXIT_COST_PCT, gasSol: env.EXIT_COST_GAS_SOL, feeFactor: env.SHADOW_SIM_FEE_FACTOR };
const iso = (ms: number) => new Date(ms).toISOString();
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

logger.info('[paper] started (no wallet, no transactions)', { strategy: strat.name });
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 200).unref(); });

const lastExitMs = new Map<string, number>();
while (!stopping) {
  try {
    const nowMs = Date.now();
    let open: SimPosition[] = loadOpenSims(openFile);
    // ---- entries
    const pairs = await scanPools(defaultScannerConfig(new Map()), env.INITIAL_LP_CAPITAL_SOL);
    for (const p of pairs) {
      if (open.length >= strat.maxOpen) break;
      if (p.mint_y !== WSOL) continue; // price orientation: token (x) priced in SOL (y)
      if (open.some((o) => o.pool === p.address)) continue;
      if (nowMs - (lastExitMs.get(p.address) ?? 0) < strat.cooldownMin * 60_000) continue;
      const feeTvl24hPct = fin(p.feeTvlRatio24h);
      const cand: PaperCandidate = { feeTvl24hPct, tvlUsd: fin(Number(p.liquidity)), mcapUsd: fin(p.tokenX.marketCapUsd), holders: fin(p.tokenX.holders), spike: p.volumeH6Usd === undefined ? null : volumeSpikeRatio(p), change1hPct: fin(p.priceChange1hPct), change6hPct: fin(p.priceChange6hPct), change24hPct: fin(p.priceChange24hPct), belowHigh4hPct: null };
      const pre = entryReject({ ...strat.entry, belowHigh4hMinPct: undefined, belowHigh4hMaxPct: undefined }, cand);
      if (pre) continue;
      let candles: Awaited<ReturnType<typeof fetchCandles5m>> = [];
      try { candles = (await fetchCandles5m(p.address, env.SHADOW_FETCH_TIMEOUT_MS, 5)).filter((c) => c.timestamp + 300 <= nowMs / 1000); } catch { continue; }
      cand.belowHigh4hPct = belowHighPct(candles);
      const why = entryReject(strat.entry, cand);
      if (why) { logger.info('[paper] skip', { pool: p.address, name: p.name, why }); continue; }
      const last = [...candles].sort((a, b) => a.timestamp - b.timestamp).pop();
      if (!last || !(last.close > 0)) continue;
      const pos = openPaper(strat, { id: `${strat.name}:${p.address}:${nowMs}`, pool: p.address, name: p.name ?? null, mint: p.mint_x, binStep: p.bin_step, entryTs: Math.floor(nowMs / 1000), lastTs: last.timestamp, entryPrice: last.close, feeTvl24hPct }, costs);
      open.push(pos);
      appendSimLine({ type: 'paper_entry', strategy: strat.name, id: pos.id, ts: iso(nowMs), pool: p.address, name: p.name, price: last.close, binStep: p.bin_step, rangeBins: [pos.lo, pos.hi], capitalSol: strat.capitalSol, feeTvl24hPct, cand }, logFile);
    }
    // ---- step every open position
    const still: SimPosition[] = [];
    let closed = 0;
    for (const pos of open) {
      try {
        const hours = Math.ceil((nowMs / 1000 - pos.lastTs) / 3600) + 1;
        const candles = (await fetchCandles5m(pos.pool, env.SHADOW_FETCH_TIMEOUT_MS, hours)).filter((c) => c.timestamp + 300 <= nowMs / 1000);
        const r = advancePaper(pos, candles, strat, costs);
        if (r.exit) {
          const e = r.exit;
          closed++;
          lastExitMs.set(pos.pool, nowMs);
          appendSimLine({ type: 'paper_exit', strategy: strat.name, id: pos.id, ts: iso(e.ts * 1000), pool: pos.pool, name: pos.name, reason: e.reason, price: e.price, minutesHeld: Math.round(e.minutesHeld), netSol: +e.netSol.toFixed(5), netPct: +e.netPct.toFixed(2), feesSol: +e.feesSol.toFixed(5), valueChangeSol: +e.valueChangeSol.toFixed(5), exitCostSol: +e.exitCostSol.toFixed(5), gasSol: +e.gasSol.toFixed(5), holdSolSol: 0, holdTokenSol: +e.holdTokenSol.toFixed(5), tokenMovePct: +e.tokenMovePct.toFixed(2) }, logFile);
        } else still.push(r.pos);
      } catch (err) {
        still.push(pos);
        logger.warn('[paper] step skipped', { pool: pos.pool, error: err instanceof Error ? err.message : String(err) });
      }
    }
    saveOpenSims(still, openFile);
    logger.info('[paper] cycle done', { strategy: strat.name, scanned: pairs.length, open: still.length, closed });
  } catch (err) {
    logger.error('[paper] cycle failed', { error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, 5 * 60_000));
}
