/**
 * Manual operations for the Telegram notifier. Run through scripts/livectl.sh (loads .env.live).
 * Usage: manualOps.ts bid-dry|bid|open-dry|open|openpool-dry|openpool <pool> [sol] | close-dry|close [pct|now] | orders | cancel <n|all> | sell <mint>
 * bid/close place standalone limit orders and return at once; they are tracked in state/manual-orders.json (the bot ignores that file, so it never market-sells a manual order)
 * Mutating commands refuse to run while the live bot process is up (two writers on one wallet = double deploy).
 * Persists state/live-state.json like the bot does, so a later bot boot resumes from it. Prints no secrets.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';

// /open = market entry now (no 30-minute bid ladder); /openpool = exactly the bot's entry path (bid ladder, don't-chase abort, flow re-check, market remainder).
const cmdArg = process.argv[2] ?? '';
const botLike = cmdArg === 'openpool' || cmdArg === 'openpool-dry';
if (!botLike) process.env.ENTRY_LIMIT_BID_PCT = '0';

const { env } = await import('../config/env.js');
const { WSOL_MINT } = await import('../config/constants.js');
const { getWalletPubkey, getWalletSolBalance, getTokenBalance } = await import('../services/solana.js');
const { openPool, getUserPositions, placeLimitOrder, getLimitOrderProgress, cancelLimitOrderFull, supportsLimitOrder } = await import('../services/meteoraDLMM.js');
const { binsForMove } = await import('../logic/limitOrderMath.js');
const { getVolume1hUsd } = await import('../services/meteoraScanner.js');
const { getTransferFeeBps } = await import('../services/tokenFee.js');
const { getDollarVolumeBuyRatio } = await import('../services/flowAnalysis.js');
const { getDrawdownFromHighPct } = await import('../services/candleContext.js');
const { emergencySwapAllToSol } = await import('../services/jupiterSwap.js');
const { loadState, saveState, STATE_VERSION } = await import('../services/stateStore.js');
const { recoverOnBoot } = await import('../logic/bootRecovery.js');
const eng = await import('../logic/rebalanceEngine.js');
const { closeRecordUpdate } = await import('../logic/meridianCooldown.js');
const { pnlBasisSol, strategyLabel } = await import('../logic/flip.js');
const { estimateExitCostSol, realizedPnl } = await import('../logic/realizedPnl.js');
const { recordOutcome } = await import('../services/aiOutcomes.js');

const [cmd = '', arg1 = '', arg2 = ''] = process.argv.slice(2);

function botAlive(): boolean {
  try {
    return execSync('pgrep -f "^node dist/index.js$"', { encoding: 'utf8' }).trim().length > 0;
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

async function solPriceUsdOf(addr: string): Promise<number> {
  const api = (await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${addr}`)).json()) as { token_x?: { address?: string; price?: number }; token_y?: { address?: string; price?: number } };
  const sol = api.token_x?.address === WSOL_MINT ? api.token_x : api.token_y;
  return Number(sol?.price) || 0;
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
  if (!botLike) console.log(`token share ${env.TOKEN_SHARE_PCT}% bought at MARKET via Jupiter, then DLMM position (no limit-bid ladder)`);
  else {
    console.log(`bot-style entry: token share ${env.TOKEN_SHARE_PCT}% as a bid ladder up to ${env.ENTRY_LIMIT_BID_PCT}% below the price, wait up to ${env.ENTRY_LIMIT_WAIT_MIN} min, remainder at market`);
    console.log(`aborts (SOL returned) if <50% filled and the price ran >${env.ENTRY_LIMIT_MAX_CHASE_PCT}% above, or if $ flow turns sell-dominant (<${env.MIN_DOLLAR_BUY_RATIO}) after a <50% fill. Takes up to ~${env.ENTRY_LIMIT_WAIT_MIN + 3} min; I report when done`);
    const flow = await getDollarVolumeBuyRatio(info.reserveSolAccount, await solPriceUsdOf(addr));
    console.log(flow === null ? 'WARNING: $ flow unavailable (the bot would skip this pool: fail-closed)' : `$ buy ratio now ${flow.buyRatioUsd.toFixed(2)} (${flow.txSampled} tx)${flow.buyRatioUsd < env.MIN_DOLLAR_BUY_RATIO ? ` WARNING: below ${env.MIN_DOLLAR_BUY_RATIO}, the bot would skip this pool` : ''}`);
    const dd14 = await getDrawdownFromHighPct(addr, env.DRAWDOWN_WINDOW_DAYS);
    const dd48 = await getDrawdownFromHighPct(addr, 2);
    console.log(`below ${env.DRAWDOWN_WINDOW_DAYS}d high: ${dd14 ?? '?'}% (bot max ${env.MAX_DRAWDOWN_FROM_HIGH_PCT}%), below 48h high: ${dd48 ?? '?'}% (bot max ${env.MAX_BELOW_HIGH_48H_PCT}%)`);
  }
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
  // During a bid-ladder wait keep the pending order in the state file so a killed process leaves a recoverable record (the bot settles it on boot).
  const keep = botLike ? setInterval(() => writeState({ inFlight: true, pendingLimitOrder: eng.getPendingLimitOrder() }), 15_000) : null;
  let ctx;
  try {
    const solPrice = botLike ? await solPriceUsdOf(addr) : 0;
    const recheck = botLike
      ? async () => {
          const again = await getDollarVolumeBuyRatio(info.reserveSolAccount, solPrice);
          return again !== null && again.buyRatioUsd >= env.MIN_DOLLAR_BUY_RATIO;
        }
      : undefined;
    ctx = await eng.openInitialPosition(pool, addr, info.mintX, info.mintY, info.xIsSol, capital, info.binStep, info.reserveSolAccount, recheck);
  } catch (err) {
    writeState({ inFlight: false, pendingSwapBack: eng.getPendingSwapBack(), pendingLimitOrder: eng.getPendingLimitOrder() });
    throw err;
  } finally {
    if (keep) clearInterval(keep);
  }
  ctx.volume1hBaselineUsd = (await getVolume1hUsd(info.otherMint)) ?? 0;
  ctx.volume1hBaselineSetAtMs = Date.now();
  writeState({ position: eng.positionToPersisted(ctx), inFlight: false, currentCapitalSol: capital, lastOtherMint: info.otherMint, pendingSwapBack: eng.getPendingSwapBack(), pendingLimitOrder: eng.getPendingLimitOrder() });
  const snap = await eng.getPositionHealthSnapshot(ctx);
  console.log(`opened ${addr}: value ${snap.currentValueSol.toFixed(4)} SOL (capital ${capital}). Start the bot to manage it, or keep it manual.`);
}


const ORDERS_FILE = 'state/manual-orders.json';
interface ManualOrder { kind: 'entryBid' | 'exitAsk'; pool: string; order: string; xIsSol: boolean; mint: string; amountRaw: string; placedAtMs: number }
const readOrders = (): ManualOrder[] => {
  try {
    return existsSync(ORDERS_FILE) ? (JSON.parse(readFileSync(ORDERS_FILE, 'utf8')) as ManualOrder[]) : [];
  } catch {
    return [];
  }
};
const writeOrders = (o: ManualOrder[]): void => {
  mkdirSync('state', { recursive: true });
  writeFileSync(ORDERS_FILE, JSON.stringify(o));
};
const goalOf = (k: ManualOrder['kind']) => (k === 'entryBid' ? ('buyToken' as const) : ('sellToken' as const));
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
};

async function bidPlan(addr: string, solArg: string) {
  const pool = await openPool(addr);
  const info = poolInfo(pool);
  if (!supportsLimitOrder(pool)) throw new Error('this pool does not support limit orders');
  const want = Number(solArg) > 0 ? Number(solArg) : (env.INITIAL_LP_CAPITAL_SOL * env.TOKEN_SHARE_PCT) / 100;
  const amountSol = Math.min(want, env.INITIAL_LP_CAPITAL_SOL);
  const depthPct = env.ENTRY_LIMIT_BID_PCT > 0 ? env.ENTRY_LIMIT_BID_PCT : 5;
  const binCount = Math.min(12, Math.max(3, binsForMove(depthPct, info.binStep, 'down')));
  const lowPct = (1 - Math.pow(1 + info.binStep / 10000, -binCount)) * 100;
  const highPct = (1 - Math.pow(1 + info.binStep / 10000, -1)) * 100;
  return { pool, info, want, amountSol, binCount, lowPct, highPct };
}

async function bidDry(addr: string, solArg: string): Promise<void> {
  const p = await bidPlan(addr, solArg);
  const api = (await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${addr}`)).json()) as { name?: string; tvl?: number; pool_config?: { base_fee_pct?: number } };
  const feeBps = await getTransferFeeBps(p.info.otherMint);
  const wallet = await getWalletSolBalance();
  console.log(`pool ${api.name ?? addr.slice(0, 6)} (${addr}), bin step ${p.info.binStep}, base fee ${api.pool_config?.base_fee_pct ?? '?'}%, TVL $${Math.round(api.tvl ?? 0).toLocaleString()}`);
  console.log(`LIMIT BUY order: ${p.amountSol} SOL spread over ${p.binCount} bins, about ${p.highPct.toFixed(1)}% to ${p.lowPct.toFixed(1)}% below the current price (asked ${p.want}, cap ${env.INITIAL_LP_CAPITAL_SOL}); wallet ${wallet.toFixed(4)} SOL`);
  console.log('Only the order is placed: no position, no waiting, no monitoring. It fills partly or not at all as sellers hit it. Track it with /orders, cancel with /cancelorder. The bot ignores this order.');
  if (feeBps === null) console.log('WARNING: transfer-fee lookup failed');
  else if (feeBps > 0) console.log(`WARNING: token has a ${feeBps / 100}% transfer fee`);
  if (wallet - eng.computeGasReserveSol(wallet) - 0.01 < p.amountSol) console.log('WARNING: wallet cannot fund this order after the gas reserve');
}

async function bid(addr: string, solArg: string): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  const p = await bidPlan(addr, solArg);
  const wallet = await getWalletSolBalance();
  if (wallet - eng.computeGasReserveSol(wallet) - 0.01 < p.amountSol) throw new Error(`wallet ${wallet.toFixed(4)} SOL cannot fund ${p.amountSol} SOL after the gas reserve`);
  const amount = new BN(Math.round(p.amountSol * 1e9));
  const placed = await placeLimitOrder(p.pool, 'buyToken', p.info.xIsSol, amount, 1, p.binCount);
  writeOrders([...readOrders(), { kind: 'entryBid', pool: addr, order: placed.order.toBase58(), xIsSol: p.info.xIsSol, mint: p.info.otherMint, amountRaw: amount.toString(), placedAtMs: Date.now() }]);
  console.log(`order placed: ${p.amountSol} SOL, ${p.binCount} bins (${p.highPct.toFixed(1)}%..${p.lowPct.toFixed(1)}% below price), order ${placed.order.toBase58().slice(0, 6)}… Track with /orders.`);
}

async function listOrders(): Promise<void> {
  const orders = readOrders();
  if (!orders.length) {
    console.log('no manual limit orders');
    return;
  }
  const pools = new Map<string, Awaited<ReturnType<typeof openPool>>>();
  const keep: ManualOrder[] = [];
  let i = 0;
  for (const o of orders) {
    i++;
    let line = `${i}. ${o.kind === 'entryBid' ? 'BUY' : 'SELL'} ${o.pool.slice(0, 6)}…`;
    try {
      let pool = pools.get(o.pool);
      if (!pool) pools.set(o.pool, (pool = await openPool(o.pool)));
      const prog = await getLimitOrderProgress(pool, new PublicKey(o.order), goalOf(o.kind), o.xIsSol);
      if (!prog) line += ` order gone (cancelled or fully closed), removed from the list`;
      else {
        keep.push(o);
        const amt = o.kind === 'entryBid' ? `${(Number(o.amountRaw) / 1e9).toFixed(3)} SOL` : `${o.amountRaw} raw tokens`;
        line += ` ${(prog.fraction * 100).toFixed(1)}% filled, ${amt}, placed ${ago(o.placedAtMs)} ago`;
      }
    } catch (e) {
      keep.push(o);
      line += ` status unavailable (${e instanceof Error ? e.message.slice(0, 60) : 'error'})`;
    }
    console.log(line);
  }
  if (keep.length !== orders.length) writeOrders(keep);
}

async function cancel(sel: string): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  const orders = readOrders();
  const picks = sel === 'all' ? orders : orders.filter((_, i) => String(i + 1) === sel);
  if (!picks.length) throw new Error('no such order, check /orders');
  const before = await getWalletSolBalance();
  const left = orders.filter((o) => !picks.includes(o));
  for (const o of picks) {
    const pool = await openPool(o.pool);
    const ok = await cancelLimitOrderFull(pool, new PublicKey(o.order), goalOf(o.kind), o.xIsSol);
    console.log(`${o.kind === 'entryBid' ? 'BUY' : 'SELL'} ${o.pool.slice(0, 6)}…: ${ok ? 'cancelled, unfilled deposit and filled proceeds returned to the wallet' : 'order already gone'}`);
  }
  writeOrders(left);
  console.log(`wallet SOL ${before.toFixed(4)} -> ${(await getWalletSolBalance()).toFixed(4)} (filled tokens, if any, are in the wallet: /clean lists them)`);
}

async function closeDry(modeArg: string): Promise<void> {
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
  const pct = closePct(modeArg);
  console.log(pct > 0 ? `will: close, claim fees, then SELL the token side as a limit ask ${pct}% above the price (no waiting, no monitoring; track with /orders, cancel with /cancelorder; the bot ignores it). Fee-sized token portion stays as token.` : 'will: close, claim fees, swap the token side to SOL via Jupiter NOW (fee-sized token portion stays as token)');
}

function closePct(modeArg: string): number {
  if (modeArg === 'now') return 0;
  const n = Number(modeArg);
  return n > 0 ? n : env.DOWNBREAK_ASK_PCT;
}

/**
 * A manual close counts like any other close for the meridian pool-memory cooldowns (3 OOR / 3 fee-earning closes -> 12 h, SL_POOL_COOLDOWN_HOURS after a stop
 * loss) and gets an outcome line. manualOps refuses to run while the bot is up (single writer), so editing state/live-state.json here is safe; the bot
 * reads closeHistory and the blacklist at its next boot. A close made while the position was out of range is recorded as 'oor', anything else as 'other'.
 */
function recordManualClose(ctx: Awaited<ReturnType<typeof recoverOnBoot>>['ctx'] & object, pre: { value: number; fees: number; other: number; oor: boolean } | null): void {
  const now = Date.now();
  const mint = ctx.xIsSol ? ctx.mintY : ctx.mintX;
  const prev = loadState(getWalletPubkey().toBase58());
  const upd = closeRecordUpdate(prev?.closeHistory, prev?.blacklist ?? [], ctx.poolAddress, mint, { kind: pre?.oor ? 'oor' : 'other', feesSol: pre?.fees ?? 0 }, now, env.SL_POOL_COOLDOWN_HOURS);
  writeState({ closeHistory: upd.closeHistory, blacklist: upd.blacklist });
  const init = ctx.initialDepositSol;
  const basis = pre ? pnlBasisSol(pre.value, pre.fees, ctx.bankedSol ?? 0, true, estimateExitCostSol(pre.other, env.EXIT_COST_PCT, env.EXIT_COST_GAS_SOL)) : null;
  const pnlPct = basis !== null && init > 0 ? ((basis - init) / init) * 100 : 0;
  const lc = eng.getLastClose();
  const real = lc && lc.pool === ctx.poolAddress ? realizedPnl(ctx.openSpentSol, lc.receivedSol, ctx.bankedSol ?? 0, init) : null;
  recordOutcome({
    at: new Date(now).toISOString(),
    pool: ctx.poolAddress,
    name: ctx.poolName ?? null,
    tokenMint: mint,
    minutesHeld: ctx.openedAtMs ? Math.round((now - ctx.openedAtMs) / 60_000) : null,
    depositSol: init,
    lastValueSol: pre ? pre.value + (ctx.bankedSol ?? 0) : 0,
    pnlPct: +pnlPct.toFixed(2),
    ...(real ? { realizedPnlPct: +real.pnlPct.toFixed(2), realizedPnlSol: +real.pnlSol.toFixed(5) } : {}),
    peakPct: +ctx.peakProfitPct.toFixed(2),
    exitReason: `MANUAL: close now${pre?.oor ? ' (out of range)' : ''}`,
    entryConviction: ctx.aiEntryConviction ?? null,
    entryReason: ctx.aiEntryReason ?? null,
    strategy: strategyLabel(ctx),
  });
  console.log(`bookkeeping: closeHistory + outcome recorded${upd.blacklist.some(([a]) => a === ctx.poolAddress) ? ', pool is on the cooldown list' : ''}`);
}

async function close(modeArg: string): Promise<void> {
  if (botAlive()) throw new Error('live bot is running, stop it first');
  const rec = await recoverOnBoot();
  if (rec.plan.kind === 'ambiguous') throw new Error('several positions on-chain, resolve manually');
  const ctx = rec.ctx;
  if (!ctx) {
    console.log('no open position');
    return;
  }
  writeState({ inFlight: true, lastOtherMint: ctx.xIsSol ? ctx.mintY : ctx.mintX });
  // snapshot BEFORE the close for the bookkeeping below (best effort: a failed read only costs the pnl/fees fields)
  let pre: { value: number; fees: number; other: number; oor: boolean } | null = null;
  try {
    const sn = await eng.getPositionHealthSnapshot(ctx);
    pre = { value: sn.currentValueSol, fees: sn.unclaimedFeesSol, other: sn.otherPrincipalSol, oor: (await eng.getBinRangeStatus(ctx)).isOutOfRange };
  } catch {
    /* ignore */
  }
  try {
    const next = await eng.executeManualClose(ctx, closePct(modeArg));
    // A manual ask is tracked in manual-orders.json, NOT as the bot's pendingLimitOrder (the bot would cancel/market-sell it after its deadline).
    const ask = eng.getPendingLimitOrder();
    if (ask) {
      writeOrders([...readOrders(), { kind: 'exitAsk', pool: ask.pool, order: ask.order, xIsSol: ask.xIsSol, mint: ask.mint, amountRaw: ask.amountRaw, placedAtMs: Date.now() }]);
      eng.restorePendingLimitOrder(null);
    }
    writeState({ position: null, inFlight: false, currentCapitalSol: next, pendingSwapBack: eng.getPendingSwapBack(), pendingLimitOrder: null });
    recordManualClose(ctx, pre);
    console.log(`closed. wallet SOL ${(await getWalletSolBalance()).toFixed(4)}${ask ? '. Sell ask placed, track with /orders.' : ''}${eng.getPendingSwapBack() ? ' (token swap-back pending, use /clean)' : ''}`);
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
  if (cmd === 'open-dry' || cmd === 'openpool-dry') await openDry(arg1, arg2);
  else if (cmd === 'open' || cmd === 'openpool') await open(arg1, arg2);
  else if (cmd === 'bid-dry') await bidDry(arg1, arg2);
  else if (cmd === 'bid') await bid(arg1, arg2);
  else if (cmd === 'orders') await listOrders();
  else if (cmd === 'cancel') await cancel(arg1);
  else if (cmd === 'close-dry') await closeDry(arg1);
  else if (cmd === 'close') await close(arg1);
  else if (cmd === 'sell') await sell(arg1);
  else throw new Error(`unknown command ${cmd}`);
  process.exit(0);
} catch (err) {
  console.log('ERROR: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
