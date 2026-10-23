import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { advanceSim, binOfU, canOpenSim, openSim, priceOfU, simBinRadius, uOf, valuePosition, type OpenInput, type SimParams, type SimPosition } from '../logic/shadowSim.js';
import { summarizeSim, type SimLine } from '../logic/shadowSimReport.js';
import { appendSimLine, loadOpenSims, readSimLines, saveOpenSims } from '../services/shadowSimStore.js';
import type { ShadowCandle } from '../logic/shadowStrategy.js';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// the code defaults of the bot (env.ts): the sim reuses them, nothing is read from a secret file
const P: SimParams = {
  capitalSol: 1,
  ladderBins: 10,
  targetRangePct: 15,
  minRadius: 5,
  maxRadius: 50,
  slPct: 25,
  exit: { takeProfitPct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeBinsToClose: 10, outOfRangeWaitMinutes: 30, minFeePerTvl24hPct: 7, minAgeBeforeYieldCheckMin: 60 },
  trailingFloorPct: 0,
  flipOorAboveMin: 10,
  flipTvlCollapsePct: 30,
  exitCostPct: 1,
  exitCostGasSol: 0.0005,
  feeFactor: 1,
  maxHours: 48,
};
const T0 = 1_800_000_000;
const STEP = 100;
const ls = Math.log(1 + STEP / 10_000);
const inp = (mode: 'A' | 'B', o: Partial<OpenInput> = {}): OpenInput => ({ id: 'sim:x', decisionId: 'x', mode, pool: 'POOL', name: 'X-SOL', mint: 'M', binStep: STEP, solPriceUsd: 100, entryTs: T0, lastTs: T0 - 300, entryPrice: 1, feeTvl24hPct: null, ...o });
const candle = (i: number, u: number): ShadowCandle => {
  const close = priceOfU(u, 1, STEP);
  return { timestamp: T0 + i * 300, open: close, high: close, low: close, close, volume: 1 };
};
const path = (us: number[], from = 0): ShadowCandle[] => us.map((u, i) => candle(from + i, u));

// geometry: entry sits at the top of bin 0
near(uOf(priceOfU(3.7, 1, STEP), 1, STEP), 3.7);
near(priceOfU(1, 1, STEP), 1);
assert.equal(binOfU(1), 0);
assert.equal(binOfU(0.2), 0); // bin 0 covers (0, 1]
assert.equal(binOfU(-0.2), -1);
assert.equal(binOfU(-9), -10); // exactly on a bin's bottom edge = already the next bin down
assert.equal(simBinRadius(100, P), 12); // 14.05 bins for +-15% is capped by the SDK per-tx limit
assert.equal(simBinRadius(400, P), 5); // 3.56 -> the minimum

// ---- B maths ----
const one = openSim(inp('B'), { ...P, ladderBins: 1 }); // a single bin: closed form
near(valuePosition(one, 1).valueSol, 1); // at entry
near(valuePosition(one, 0).valueSol, Math.exp(-0.5 * ls)); // price at the bottom edge: all converted at the bin middle, valued at the bottom
near(valuePosition(one, 5).valueSol, 1); // above the ladder: untouched SOL
const b = openSim(inp('B'), P);
near(b.solBins.reduce((s, x) => s + x.s, 0), 1);
assert.ok(b.solBins[9]!.s > b.solBins[0]!.s, 'bid-ask: heavier away from the price');
near(valuePosition(b, 1).valueSol, 1);
near(valuePosition(b, 3).valueSol, 1);
let prev = 1;
for (const u of [0.5, -1, -3, -6, -8.9]) {
  const v = valuePosition(b, u).valueSol;
  assert.ok(v < prev, `value must fall as price falls through the ladder (${v} !< ${prev})`);
  prev = v;
}
assert.ok(valuePosition(b, -8.9).valueSol > 0.8, 'a 10-bin (-9%) ladder loses far less than 25%');
// path independence: the value is a function of the price only
near(valuePosition(b, -3).valueSol, valuePosition(b, -3).valueSol);

// ---- A maths ----
const a = openSim(inp('A'), P);
near(a.solBins.reduce((s, x) => s + x.s, 0), 0.5);
assert.equal(a.lo, -12);
assert.equal(a.hi, 13);
near(valuePosition(a, 1).valueSol, 1 - 0.5 * 0.01); // the 50% swap cost
assert.ok(valuePosition(a, 20).valueSol > 1, 'the token half sells higher when price rises');
assert.ok(valuePosition(a, -20).valueSol < 0.95);

// ---- flip (B): only below the lowest bin, once, asks above the OLD bottom ----
let r = advanceSim(b, path([0.5, -2, -5, -8.5]), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.equal(r.exit, null);
assert.equal(r.pos.phase, 'ladder'); // -8.5 is still inside the lowest bin (-9): not 100% token yet
assert.equal(r.flipped, false);
r = advanceSim(r.pos, path([-9.2], 4), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.equal(r.flipped, true);
assert.equal(r.pos.phase, 'flip');
assert.equal(r.pos.solBins.length, 0);
assert.equal(r.pos.tokBins[0]!.k, -8); // old bottom (-9) + 1
assert.equal(r.pos.tokBins.length, 10);
assert.equal(r.pos.lo, -8);
assert.equal(r.pos.hi, 1);
assert.equal(r.pos.flipTvlUsd, 100_000);
near(r.pos.gasPaidSol, 3 * 0.0005); // entry + close + redeposit
near(valuePosition(r.pos, -9.2).valueSol, valuePosition(b, -9.2).valueSol); // the flip does not change the value
// waiting for the bounce: below the range there is NO out-of-range timer, however long
const wait = advanceSim(r.pos, path(Array(60).fill(-9.4), 5), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.equal(wait.exit, null);
// sold out above the range: exit only after 10 minutes above (the third candle), not at once
const up = advanceSim(r.pos, path([3, 3, 3], 5), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.ok(up.exit && up.exit.reason.startsWith('flip sold out above range'), up.exit?.reason);
assert.equal(up.exit!.ts, T0 + (5 + 2) * 300 + 300); // the third candle's close
assert.equal(up.exit!.flipped, true);
assert.equal(advanceSim(r.pos, path([3, 3], 5), { tvlUsd: 100_000, feeTvl24hPct: null }, P).exit, null);
// stop loss on the whole cycle (flip phase)
const crash = advanceSim(r.pos, path([-12, -20, -30, -45], 5), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.ok(crash.exit && crash.exit.reason.startsWith('stop loss'), crash.exit?.reason);
assert.ok(crash.exit!.pnlSol < -0.25);
// pool liquidity collapse (checked on the last candle of the batch)
const col = advanceSim(r.pos, path([-9.4], 5), { tvlUsd: 20_000, feeTvl24hPct: null }, P);
assert.ok(col.exit && col.exit.reason.startsWith('liquidity collapse'), col.exit?.reason);
// no take profit / trailing / low yield in the flip phase: a +10% fee spike does not close it while the price is inside the flip range
const spike = advanceSim(r.pos, path([-4], 5), { tvlUsd: 100_000, feeTvl24hPct: 1 }, { ...P });
assert.equal(spike.exit, null);
const feeFlip = advanceSim({ ...r.pos, feeTvl24hPct: 20_000 }, path([-4], 5), { tvlUsd: 100_000, feeTvl24hPct: 1 }, P);
assert.equal(feeFlip.exit, null, 'fee income above 5% must not close a flip position (no TP in the flip phase)');
assert.ok(feeFlip.pos.feesSol > 0.05);

// ---- meridian rules on the ladder and on A ----
const tpB = advanceSim({ ...b, feeTvl24hPct: 10_000 }, path([0.5]), { tvlUsd: 100_000, feeTvl24hPct: 10_000 }, P);
assert.ok(tpB.exit && tpB.exit.reason.startsWith('take profit'), tpB.exit?.reason);
assert.ok(tpB.exit!.pnlSol > 0.05);
const tpA = advanceSim({ ...a, feeTvl24hPct: 10_000 }, path([1]), { tvlUsd: 100_000, feeTvl24hPct: 10_000 }, P);
assert.ok(tpA.exit && tpA.exit.reason.startsWith('take profit'), tpA.exit?.reason);
const pumped = advanceSim(b, path([12]), { tvlUsd: 100_000, feeTvl24hPct: null }, P); // 11 bins above the top bin
assert.ok(pumped.exit && pumped.exit.reason.startsWith('pumped far above range'), pumped.exit?.reason);
near(pumped.exit!.pnlSol, -0.0005 * 2 - 0, 1e-9); // all SOL: only the entry gas and the exit gas
// A never flips: below the range it waits the 30-minute out-of-range timer, then sells
const aBelow = advanceSim(a, path(Array(7).fill(-13.5)), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.equal(aBelow.flipped, false);
assert.ok(aBelow.exit && aBelow.exit.reason.startsWith('out of range'), aBelow.exit?.reason);
assert.equal(aBelow.exit!.flipped, false);
assert.equal(advanceSim(a, path(Array(5).fill(-13.5)), { tvlUsd: 100_000, feeTvl24hPct: null }, P).exit, null); // 25 minutes: still waiting
// low yield after 60 minutes, only when the pool fee/TVL is known and under 7%
const lowYield = advanceSim(b, path(Array(13).fill(0.5)), { tvlUsd: 100_000, feeTvl24hPct: 3 }, P);
assert.ok(lowYield.exit && lowYield.exit.reason.startsWith('low yield'), lowYield.exit?.reason);
assert.equal(advanceSim(b, path(Array(13).fill(0.5)), { tvlUsd: 100_000, feeTvl24hPct: null }, P).exit, null);
// a time stop only for the simulation (the real bot has none)
const to = advanceSim(b, path([0.5, 0.5]), { tvlUsd: null, feeTvl24hPct: null }, { ...P, maxHours: 0.1 });
assert.ok(to.exit && to.exit.reason.startsWith('sim timeout'), to.exit?.reason);
// candles that already were processed are ignored; the step is deterministic
const again = advanceSim(r.pos, path([-9.4], 0), { tvlUsd: 100_000, feeTvl24hPct: null }, P);
assert.equal(again.exit, null);
assert.equal(again.pos.lastTs, r.pos.lastTs);
// PnL in USD uses the SOL price at the entry
assert.ok(Math.abs(crash.exit!.pnlUsd! - crash.exit!.pnlSol * 100) < 1e-9);

// ---- dedupe / cap ----
const open = [{ pool: 'P1' }, { pool: 'P2' }];
assert.equal(canOpenSim(open, 'P1', 12), false); // already open in that pool
assert.equal(canOpenSim(open, 'P3', 12), true);
assert.equal(canOpenSim(open, 'P3', 2), false); // cap

// ---- report ----
const L: SimLine[] = [
  { type: 'sim_entry', id: 's1', decisionId: 'd1', ts: 't', pool: 'p1', name: 'a', mode: 'A', price: 1, capitalSol: 1 },
  { type: 'sim_entry', id: 's2', decisionId: 'd2', ts: 't', pool: 'p2', name: 'b', mode: 'B', price: 1, capitalSol: 1 },
  { type: 'sim_entry', id: 's3', decisionId: 'd3', ts: 't', pool: 'p3', name: 'c', mode: 'B', price: 1, capitalSol: 1 },
  { type: 'sim_entry', id: 's4', decisionId: 'd4', ts: 't', pool: 'p4', name: 'd', mode: 'B', price: 1, capitalSol: 1 },
  { type: 'sim_exit', id: 's1', ts: 't', pool: 'p1', mode: 'A', price: 1, reason: 'take profit: PnL 5%', pnlSol: 0.05, pnlUsd: 5, pnlPct: 5, minutesHeld: 60, flipped: false },
  { type: 'sim_exit', id: 's2', ts: 't', pool: 'p2', mode: 'B', price: 1, reason: 'stop loss: cycle PnL -26%', pnlSol: -0.26, pnlUsd: -26, pnlPct: -26, minutesHeld: 600, flipped: true },
  { type: 'sim_exit', id: 's3', ts: 't', pool: 'p3', mode: 'B', price: 1, reason: 'flip sold out above range: 10m >= 10m', pnlSol: 0.02, pnlUsd: 2, pnlPct: 2, minutesHeld: 300, flipped: true },
  { type: 'sim_exit', id: 's3', ts: 't', pool: 'p3', mode: 'B', price: 1, reason: 'duplicate line', pnlSol: 9, pnlUsd: 900, pnlPct: 900, minutesHeld: 1, flipped: true },
];
const sum = summarizeSim(L);
assert.equal(sum.A.entries, 1);
assert.equal(sum.A.closed, 1);
assert.equal(sum.A.wins, 1);
near(sum.A.sumPnlSol, 0.05);
assert.equal(sum.B.entries, 3);
assert.equal(sum.B.closed, 2); // the duplicated exit line is not double counted
assert.equal(sum.B.open, 1);
assert.equal(sum.B.wins, 1);
near(sum.B.sumPnlSol, -0.24);
near(sum.B.sumPnlUsd, -24);
assert.equal(sum.B.flipped, 2);
assert.deepEqual(sum.B.reasons, { 'stop loss': 1, 'flip sold out above range': 1 });

// ---- store + orchestration (axios mocked, temp files) ----
const dir = mkdtempSync(join(tmpdir(), 'shadowsim-'));
process.env.SHADOW_SIM_FILE = join(dir, 'sim.jsonl');
process.env.SHADOW_SIM_OPEN_FILE = join(dir, 'open.json');
const realGet = axios.get;
try {
  assert.deepEqual(loadOpenSims(), []);
  const pos = openSim(inp('B'), P);
  assert.equal(saveOpenSims([pos]), true);
  const back = loadOpenSims();
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], JSON.parse(JSON.stringify(pos)) as SimPosition);
  appendSimLine({ type: 'sim_entry', id: 'z' });
  assert.equal(readSimLines().length, 1);
  saveOpenSims([]); // start the orchestration from a clean slate

  const { runSimCycle } = await import('../services/shadowSimRun.js');
  const NOW = (T0 + 7200) * 1000;
  let rows: Record<string, number>[] = [];
  (axios as unknown as { get: unknown }).get = async (url: string) => (url.includes('/ohlcv') ? { data: { data: rows } } : { data: { tvl: 100_000, fee_tvl_ratio: { '24h': 0 } } });
  const mk = (id: string, mode: 'A' | 'B' | 'unknown') => ({
    pool: 'POOLX',
    name: 'X-SOL',
    mint: 'MINTX',
    binStep: STEP,
    solPriceUsd: 100,
    decision: { mode, trend: 'down' as const, score: -3, votes: {}, reasons: [], inputs: { lastClose: 1 } as never, prevDown: false, id, ts: T0 * 1000, lastCandleTs: T0 - 300 },
  });
  // entry: the candle in progress / not closed yet is ignored
  rows = [{ timestamp: Math.floor(NOW / 1000) - 100, open: 1, high: 1, low: 1, close: 5, volume: 1 }];
  const c1 = await runSimCycle([mk('POOLX:1', 'B')], NOW);
  assert.deepEqual(c1, { opened: 1, closed: 0, open: 1 });
  // a second decision for the same pool while its paper position is open: no second entry
  const c2 = await runSimCycle([mk('POOLX:2', 'B')], NOW);
  assert.deepEqual(c2, { opened: 0, closed: 0, open: 1 });
  // an unknown decision opens nothing
  assert.equal((await runSimCycle([{ ...mk('POOLY:1', 'unknown'), pool: 'POOLY' }], NOW)).opened, 0);
  // price pumps 11+ bins above the ladder: exit, logged, and the pool is free again
  rows = [{ timestamp: T0, open: 1, high: 1, low: 1, close: priceOfU(12, 1, STEP), volume: 1 }];
  const c3 = await runSimCycle([], NOW);
  assert.deepEqual(c3, { opened: 0, closed: 1, open: 0 });
  const ls2 = readSimLines().filter((l) => l.type === 'sim_entry' || l.type === 'sim_exit');
  assert.equal(ls2.filter((l) => l.type === 'sim_entry' && l.id === 'sim:POOLX:1').length, 1);
  const ex = ls2.find((l) => l.type === 'sim_exit')!;
  assert.equal(ex.type, 'sim_exit');
  if (ex.type === 'sim_exit') {
    assert.equal(ex.mode, 'B');
    assert.ok(ex.reason.startsWith('pumped far above range'));
    assert.equal(ex.pool, 'POOLX');
    assert.ok(Math.abs(ex.price - priceOfU(12, 1, STEP)) < 1e-12);
  }
  assert.deepEqual(loadOpenSims(), []);
  assert.equal((await runSimCycle([mk('POOLX:3', 'A')], NOW)).opened, 1); // free again
  // a failing fetch keeps the position for the next cycle and never throws
  (axios as unknown as { get: unknown }).get = async () => {
    throw new Error('network down');
  };
  const c4 = await runSimCycle([], NOW);
  assert.equal(c4.open, 1);
  assert.equal(c4.closed, 0);
  assert.equal(readFileSync(process.env.SHADOW_SIM_FILE!, 'utf8').includes('POOLX:3'), true);
} finally {
  (axios as unknown as { get: unknown }).get = realGet;
  rmSync(dir, { recursive: true, force: true });
}

// ---- no signer / no transaction code can be reached from the simulation ----
for (const f of ['../logic/shadowSim.ts', '../logic/shadowSimReport.ts', '../services/shadowSimRun.ts', '../services/shadowSimStore.ts', './shadowRunner.ts']) {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const line of src.split('\n').filter((l) => /^\s*(import|const .* = await import)/.test(l))) assert.doesNotMatch(line, /(solana|jupiterSwap|meteoraDLMM|rebalanceEngine|manualOps|binRange)\.js/, `${f}: ${line}`);
  for (const forbidden of ['sendTransaction', 'Keypair', 'signTransaction']) assert.ok(!src.includes(forbidden), `${f} must not reference ${forbidden}`);
}

console.log('checkShadowSim ok');
