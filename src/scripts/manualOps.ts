/**
 * Manual operations for the Telegram notifier. Run through scripts/livectl.sh (loads .env.live).
 * Usage: manualOps.ts open-dry|open <pool> [sol] | close-dry | close | sell <mint>
 * Mutating commands refuse to run while the live bot process is up (two writers on one wallet = double deploy).
 * Persists state/live-state.json like the bot does, so a later bot boot resumes from it. Prints no secrets.
 */
import { execSync } from 'node:child_process';

process.env.ENTRY_LIMIT_BID_PCT = '0'; // manual open = market entry now, not a 30-minute bid ladder

const { env } = await import('../config/env.js');
const { WSOL_MINT } = await import('../config/constants.js');
const { getWalletPubkey, getWalletSolBalance, getTokenBalance } = await import('../services/solana.js');
const { openPool, getUserPositions } = await import('../services/meteoraDLMM.js');
const { getVolume1hUsd } = await import('../services/meteoraScanner.js');
const { getTransferFeeBps } = await import('../services/tokenFee.js');
const { emergencySwapAllToSol } = await import('../services/jupiterSwap.js');
const { loadState, saveState, STATE_VERSION } = await import('../services/stateStore.js');
const { recoverOnBoot } = await import('../logic/bootRecovery.js');
const eng = await import('../logic/rebalanceEngine.js');

const [cmd = '', arg1 = '', arg2 = ''] = process.argv.slice(2);

function botAlive(): boolean {
  try {
    return execSync('pgrep -f "node dist/index.js"', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

function writeState(patch: Record<string, unknown>): void {
  const wallet = getWalletPubkey().toBase58();
  const prev = loadState(wallet);
  saveState({
    version: STATE_VERSION,
    wallet,
    position: null,
    inFlight: false,
    currentCapitalSol: env.INITIAL_LP_CAPITAL_SOL,
    lastOtherMint: null,
    lastSwitchAtMs: null,
    blacklist: [],
    chaseGuard: [],
    dollarFlowBreach: { pool: '', count: 0 },
    ...prev,
    ...patch,
    savedAtMs: Date.now(),
  } as Parameters<typeof saveState>[0]);
}

function poolInfo(pool: Awaited<ReturnType<typeof openPool>>) {
  const mintX = pool.lbPair.tokenXMint.toBase58();
  const mintY = pool.lbPair.tokenYMint.toBase58();
  const xIsSol = mintX === WSOL_MINT;
  if (!xIsSol && mintY !== WSOL_MINT) throw new Error('pool has no SOL side');
  return { mintX, mintY, xIsSol, otherMint: xIsSol ? mintY : mintX, binStep: pool.lbPair.binStep, reserveSolAccount: (xIsSol ? pool.lbPair.reserveX : pool.lbPair.reserveY).toBase58() };
}

async function openDry(addr: string, solArg: string): Promise<void> {
  const rec = await recoverOnBoot();
  if (rec.plan.kind !== 'flat') throw new Error('wallet already has an open position, close it first');
  if (rec.state?.pendingLimitOrder || rec.state?.pendingSwapBack) throw new Error('state has a pending limit order / swap-back, resolve it first');
  const pool = await openPool(addr);
  const info = poolInfo(pool);
  const api = (await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${addr}`)).json()) as { name?: string; tvl?: number; volume?: Record<string, number>; pool_config?: { base_fee_pct?: number } };
  const feeBps = await getTransferFeeBps(info.otherMint);
  const wallet = await getWalletSolBalance();
  const fundable = Math.max(wallet - eng.computeGasReserveSol(wallet) - eng.POSITION_RENT_BUFFER_SOL, 0);
  const want = Number(solArg) > 0 ? Number(solArg) : env.INITIAL_LP_CAPITAL_SOL;
  const capital = Math.min(want, env.INITIAL_LP_CAPITAL_SOL, fundable);
  console.log(`pool ${api.name ?? addr.slice(0, 6)} (${addr})`);
  console.log(`bin step ${info.binStep}, base fee ${api.pool_config?.base_fee_pct ?? '?'}%, TVL $${Math.round(api.tvl ?? 0).toLocaleString()}, vol24h $${Math.round(api.volume?.['24h'] ?? 0).toLocaleString()}`);
  console.log(`capital: ${capital.toFixed(4)} SOL (asked ${want}, cap ${env.INITIAL_LP_CAPITAL_SOL}, wallet can fund ${fundable.toFixed(4)})`);
  console.log(`token share ${env.TOKEN_SHARE_PCT}% bought at MARKET via Jupiter, then DLMM position (no limit-bid ladder)`);
  if (feeBps === null) console.log('WARNING: transfer-fee lookup failed');
  else if (feeBps > 0) console.log(`WARNING: token has a ${feeBps / 100}% transfer fee, every swap/deposit/withdraw loses it`);
  if (capital < want * 0.9) console.log('WARNING: capital reduced below what you asked');
}

async function open(addr: string, solArg: string): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  const rec = await recoverOnBoot();
  if (rec.plan.kind !== 'flat') throw new Error('wallet already has an open position');
  if (rec.state?.pendingLimitOrder || rec.state?.pendingSwapBack) throw new Error('pending limit order / swap-back in state');
  const pool = await openPool(addr);
  const info = poolInfo(pool);
  const want = Number(solArg) > 0 ? Number(solArg) : env.INITIAL_LP_CAPITAL_SOL;
  const capital = Math.min(want, env.INITIAL_LP_CAPITAL_SOL);
  writeState({ inFlight: true, lastOtherMint: info.otherMint });
  let ctx;
  try {
    ctx = await eng.openInitialPosition(pool, addr, info.mintX, info.mintY, info.xIsSol, capital, info.binStep, info.reserveSolAccount);
  } catch (err) {
    writeState({ inFlight: false, pendingSwapBack: eng.getPendingSwapBack() });
    throw err;
  }
  ctx.volume1hBaselineUsd = (await getVolume1hUsd(info.otherMint)) ?? 0;
  ctx.volume1hBaselineSetAtMs = Date.now();
  writeState({ position: eng.positionToPersisted(ctx), inFlight: false, currentCapitalSol: capital, lastOtherMint: info.otherMint, pendingSwapBack: eng.getPendingSwapBack(), pendingLimitOrder: eng.getPendingLimitOrder() });
  const snap = await eng.getPositionHealthSnapshot(ctx);
  console.log(`opened ${addr}: value ${snap.currentValueSol.toFixed(4)} SOL (capital ${capital}). Start the bot to manage it, or keep it manual.`);
}

async function closeDry(): Promise<void> {
  const rec = await recoverOnBoot();
  if (rec.plan.kind === 'ambiguous') throw new Error('several positions on-chain, resolve manually');
  if (!rec.ctx) {
    console.log('no open position');
    return;
  }
  const snap = await eng.getPositionHealthSnapshot(rec.ctx);
  const range = await eng.getBinRangeStatus(rec.ctx);
  console.log(`position ${rec.ctx.poolAddress}`);
  console.log(`value ${snap.currentValueSol.toFixed(4)} SOL + unclaimed fees ${snap.unclaimedFeesSol.toFixed(4)} SOL (token side ${snap.otherPrincipalSol.toFixed(4)} SOL)`);
  console.log(range.isOutOfRange ? 'OUT OF RANGE' : 'in range');
  console.log('will: close, claim fees, swap the token side to SOL via Jupiter (fee-sized token portion stays as token)');
}

async function close(): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  const rec = await recoverOnBoot();
  if (rec.plan.kind === 'ambiguous') throw new Error('several positions on-chain, resolve manually');
  const ctx = rec.ctx;
  if (!ctx) {
    console.log('no open position');
    return;
  }
  writeState({ inFlight: true, lastOtherMint: ctx.xIsSol ? ctx.mintY : ctx.mintX });
  try {
    const next = await eng.executeManualClose(ctx);
    writeState({ position: null, inFlight: false, currentCapitalSol: next, pendingSwapBack: eng.getPendingSwapBack(), pendingLimitOrder: eng.getPendingLimitOrder() });
    console.log(`closed. wallet SOL ${(await getWalletSolBalance()).toFixed(4)}${eng.getPendingSwapBack() ? ' (token swap-back pending, use /clean)' : ''}`);
  } catch (err) {
    const still = (await getUserPositions(ctx.pool)).length > 0;
    writeState({ position: still ? eng.positionToPersisted(ctx) : null, inFlight: false, pendingSwapBack: eng.getPendingSwapBack() });
    throw new Error(`${err instanceof Error ? err.message : String(err)} (position ${still ? 'still open' : 'closed on-chain'})`);
  }
}

async function sell(mint: string): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  if (!mint || mint === WSOL_MINT) throw new Error('bad mint');
  const bal = await getTokenBalance(mint);
  if (bal.lten(0)) {
    console.log('nothing to sell');
    return;
  }
  const before = await getWalletSolBalance();
  const res = await emergencySwapAllToSol(mint, bal);
  const after = await getWalletSolBalance();
  console.log(`sold ${mint.slice(0, 6)}…: wallet SOL ${before.toFixed(4)} -> ${after.toFixed(4)} (+${(after - before).toFixed(4)})${res ? '' : ' (no swap executed)'}`);
}

try {
  if (cmd === 'open-dry') await openDry(arg1, arg2);
  else if (cmd === 'open') await open(arg1, arg2);
  else if (cmd === 'close-dry') await closeDry();
  else if (cmd === 'close') await close();
  else if (cmd === 'sell') await sell(arg1);
  else throw new Error(`unknown command ${cmd}`);
  process.exit(0);
} catch (err) {
  console.log('ERROR: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
