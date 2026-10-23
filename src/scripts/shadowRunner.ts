/**
 * Standalone SHADOW strategy runner: scans pools like the entry does (same scanner, same filters from the env) and logs what the shadow selector WOULD pick
 * to state/shadow-strategy.jsonl. NO wallet: it imports only the scanner and the shadow logger, never the wallet module, and refuses to start unless
 * PRIVATE_KEY is the placeholder SHADOW_RUNNER_NO_KEY. It sends no transaction, no swap, no order; it only reads Meteora/DexScreener/RugCheck.
 * Lines carry realIntent.aiStrategy = "shadow_runner" and have no outcome (nothing is opened).
 *
 * Run (as the user systemd unit `dlmm-shadow`, see CLAUDE.md): needs RPC_URL (any public RPC, unused for scanning) and PRIVATE_KEY=SHADOW_RUNNER_NO_KEY;
 * DOTENV_CONFIG_PATH=/nonexistent keeps .env (and its secrets) out of the process.
 */
import { SHADOW_RUNNER_DUMMY_KEY, isRunnerKeySafe, pickRunnerTargets } from '../logic/shadowRunner.js';

if (!isRunnerKeySafe(process.env.PRIVATE_KEY)) {
  console.error(`shadowRunner: refusing to start, PRIVATE_KEY must be exactly ${SHADOW_RUNNER_DUMMY_KEY} (this process must never hold a real key)`);
  process.exit(1);
}

const { scanPools, defaultScannerConfig } = await import('../services/meteoraScanner.js');
const { shadowDecision } = await import('../services/shadowLog.js');
const { env } = await import('../config/env.js');
const { logger } = await import('../utils/logger.js');

const intervalMs = Math.max(env.SHADOW_RUNNER_INTERVAL_MIN, 5) * 60_000; // the scanner itself refuses to be polled more often than that
logger.info('[shadowRunner] started (no wallet, no transactions)', { intervalMin: intervalMs / 60_000, top: env.SHADOW_RUNNER_TOP, mode: env.ENTRY_STRATEGY_MODE });

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; logger.info(`[shadowRunner] ${sig}, stopping`); setTimeout(() => process.exit(0), 200).unref(); });

const blacklist = new Map<string, number>();
while (!stopping) {
  try {
    const candidates = await scanPools(defaultScannerConfig(blacklist), env.INITIAL_LP_CAPITAL_SOL);
    const targets = pickRunnerTargets(candidates, env.SHADOW_RUNNER_TOP);
    let logged = 0;
    for (const t of targets) {
      const d = await shadowDecision(t);
      if (d) {
        logged++;
        logger.info('[shadowRunner] decision', { pool: t.pool, name: t.name, mode: d.mode, trend: d.trend, score: d.score });
      }
    }
    logger.info('[shadowRunner] cycle done', { scanned: candidates.length, targets: targets.length, logged });
  } catch (err) {
    logger.error('[shadowRunner] cycle failed', { error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
