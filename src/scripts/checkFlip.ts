import assert from 'node:assert/strict';
import { isTokenSide, strategyLabel, shouldFlip, pnlBasisSol, flipExitConfig } from '../logic/flip.js';
import { meridianExitSignal, type MeridianExitConfig, type MeridianExitInput } from '../logic/meridianExit.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';

// labels / geometry side
assert.equal(isTokenSide({}), false);
assert.equal(isTokenSide({ tokenSpot: true }), true);
assert.equal(isTokenSide({ flipPhase: true }), true);
assert.equal(strategyLabel({}), 'sol_ladder');
assert.equal(strategyLabel({ tokenSpot: true }), 'token_spot');
assert.equal(strategyLabel({ flipPhase: true }), 'bid_ask_flip');

// trigger
const on = { enabled: true, thresholdPct: 80, isLadder: true, tokenSpot: false, flipPhase: false };
assert.equal(shouldFlip({ ...on, sharePct: 80 }), true); // boundary flips
assert.equal(shouldFlip({ ...on, sharePct: 79.99 }), false);
assert.equal(shouldFlip({ ...on, sharePct: 100 }), true);
assert.equal(shouldFlip({ ...on, sharePct: NaN }), false);
assert.equal(shouldFlip({ ...on, sharePct: -5 }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, enabled: false }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, isLadder: false }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, tokenSpot: true }), false);
assert.equal(shouldFlip({ ...on, sharePct: 95, flipPhase: true }), false);

// PnL basis: banked SOL counts, fees only when asked
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
near(pnlBasisSol(0.8, 0.02, 0.2, true), 1.02);
near(pnlBasisSol(0.8, 0.02, 0.2, false), 1.0);
near(pnlBasisSol(0.8, 0.02, 0, true), 0.82);

// flip exit rules
const base: MeridianExitConfig = { takeProfitPct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeBinsToClose: 10, outOfRangeWaitMinutes: 30, minFeePerTvl24hPct: 7, minAgeBeforeYieldCheckMin: 60 };
const flipCfg = flipExitConfig(base, 5);
assert.equal(flipCfg.trailingDropPct, 1.5);
assert.equal(flipCfg.outOfRangeBinsToClose, 10);
const inp: MeridianExitInput = { pnlPct: 0, peakPnlPct: 0, binsAbove: 0, isOutOfRange: false, minutesOutOfRange: null, feePerTvl24hPct: 20, ageMinutes: 120 };
const sig = (o: Partial<MeridianExitInput>) => meridianExitSignal({ ...inp, ...o }, flipCfg);
assert.equal(sig({ pnlPct: 9, peakPnlPct: 9 }), null); // no fixed TP
assert.equal(sig({ isOutOfRange: true, minutesOutOfRange: 600 }), null); // no OOR timer
assert.equal(sig({ pnlPct: 4, peakPnlPct: 4.9 }), null); // trailing not armed below 5
assert.equal(sig({ pnlPct: 3.6, peakPnlPct: 5 }), null); // armed, dropped only 1.4
assert.match(sig({ pnlPct: 3.4, peakPnlPct: 5.1 })!, /^trailing TP/); // armed, dropped 1.7
assert.match(sig({ binsAbove: 11 })!, /^pumped far above/);
assert.match(sig({ feePerTvl24hPct: 6 })!, /^low yield/);
// normal config is untouched
assert.match(meridianExitSignal({ ...inp, pnlPct: 5 }, base)!, /^take profit/);

// state files with and without the flip fields both parse
const wallet = 'W';
const pos = { poolAddress: 'p', mintX: 'x', mintY: 'y', reserveSolAccount: 'r', initialDepositSol: 1, lastRebalanceAt: 0, volume1hBaselineUsd: 0, volume1hBaselineSetAtMs: 0, binStep: 80, peakProfitPct: 0, otherMintDecimals: 6, xIsSol: false, rebalanceTimestamps: [], centerBinId: -1, outOfRangeSinceMs: null, inRangeSinceMs: null };
const st = (p: object) => JSON.stringify({ version: STATE_VERSION, savedAtMs: 1, wallet, position: p, inFlight: false, currentCapitalSol: 1, lastOtherMint: null, lastSwitchAtMs: null, blacklist: [], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 } });
assert.ok(parseState(st(pos), wallet));
assert.ok(parseState(st({ ...pos, flipPhase: true, bankedSol: 0.2 }), wallet));

console.log('checkFlip ok');
