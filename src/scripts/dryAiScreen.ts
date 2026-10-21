/**
 * Dry run of the live AI screener: scan -> audit -> real reactScreen. Opens nothing, writes no decision log or state.
 * Usage: set -a; . ./.env.live; set +a; npx tsx src/scripts/dryAiScreen.ts
 */
import { scanPools, defaultScannerConfig, nonSolToken } from '../services/meteoraScanner.js';
import { getTokenAudit } from '../services/tokenAudit.js';
import { getDrawdownFromHighPct } from '../services/candleContext.js';
import { getTransferFeeBps } from '../services/tokenFee.js';
import { loadOutcomes } from '../services/aiOutcomes.js';
import { outcomeLine, priorFor } from '../logic/aiMemory.js';
import { reactScreen } from '../services/aiReact.js';
import { WSOL_MINT } from '../config/constants.js';
import { env } from '../config/env.js';
import type { AiCandidate } from '../logic/aiPrompts.js';

const found = await scanPools(defaultScannerConfig(new Map()));
console.log(`scan: ${found.length} pools pass the window`);
const out: AiCandidate[] = [];
for (const c of found) {
  const xIsSol = c.mint_x === WSOL_MINT;
  const mint = xIsSol ? c.mint_y : c.mint_x;
  const audit = await getTokenAudit(mint);
  if (!audit) { console.log(`skip ${c.name}: audit unavailable`); continue; }
  const tok = nonSolToken(c);
  const dd = await getDrawdownFromHighPct(c.address, env.DRAWDOWN_WINDOW_DAYS).catch(() => null);
  const feeBps = await getTransferFeeBps(mint).catch(() => null);
  out.push({
    pool: c.address, name: c.name, tokenMint: mint, binStep: c.bin_step, baseFeePct: c.baseFeePct,
    tvlUsd: Math.round(Number(c.liquidity)), vol24hUsd: Math.round(Number(c.trade_volume_24h)), vol1hUsd: Math.round(c.volume1hUsd),
    feeTvl24hPct: c.feeTvlRatio24h ?? null, feeTvl4hScaledTo24hPct: c.feeTvlRatio4h == null ? null : +(c.feeTvlRatio4h * 6).toFixed(2),
    mcapUsd: Math.round(tok?.marketCapUsd ?? 0), holders: tok?.holders ?? 0,
    organicScore: audit.organicScore, topHoldersPct: audit.topHoldersPct, botHoldersPct: audit.botHoldersPct, globalFeesSol: audit.globalFeesSol,
    priceChange1hPct: c.priceChange1hPct ?? null, priceChange6hPct: c.priceChange6hPct ?? null, priceChange24hPct: c.priceChange24hPct ?? null,
    drawdownFrom14dHighPct: dd, transferFeePct: feeBps === null ? null : feeBps / 100,
    freezeAuthorityDisabled: tok?.freezeAuthorityDisabled ?? null, mintAuthorityRevoked: tok?.mintAuthorityRevoked ?? null,
    buyRatio1hByTxCount: c.buyRatio1h ?? null, dollarFlowBuyRatio: null, dollarFlowTxSampled: null,
    poolAgeHours: Math.round((Date.now() - c.createdAtMs) / 3_600_000),
    priorOutcomes: priorFor(loadOutcomes(), c.address, mint).map(outcomeLine),
  });
}
console.log(`eligible for the AI: ${out.length}`);
const r = await reactScreen(out, 1, []);
console.log(JSON.stringify({ decision: r.decision, turns: r.turns, costUsd: r.costUsd, tools: r.toolCalls }, null, 1));
