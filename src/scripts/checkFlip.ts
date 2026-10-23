import assert from 'node:assert/strict';
import { isTokenSide, strategyLabel, shouldFlip, pnlBasisSol, flipExitSignal, selectExitSignal, aiExitAllowed, flipAnchorBin, flipPromptInfo, flipCenterFromBounds, type FlipExitInput, type FlipExitConfig } from '../logic/flip.js';
import { ladderBounds, ladderRangeStatus } from '../logic/ladderRange.js';
import { buildReactScreenerPrompt, buildReactManagerPrompt } from '../logic/aiPrompts.js';
import { meridianExitSignal, ExitConfirmer, type MeridianExitConfig, type MeridianExitInput } from '../logic/meridianExit.js';
import { parseState, STATE_VERSION } from '../services/stateStore.js';

// labels / geometry side
assert.equal(isTokenSide({}), false);
assert.equal(isTokenSide({ tokenSpot: true }), true);
assert.equal(isTokenSide({ flipPhase: true }), true);
assert.equal(strategyLabel({}), 'sol_ladder');
assert.equal(strategyLabel({ tokenSpot: true }), 'token_spot');
assert.equal(strategyLabel({ flipPhase: true }), 'bid_ask_flip');

// trigger: ONLY price below the lowest bin (100% token). No token-share threshold any more.
const on = { enabled: true, belowRange: true, isLadder: true, tokenSpot: false, flipPhase: false };
assert.equal(shouldFlip(on), true);
assert.equal(shouldFlip({ ...on, belowRange: false }), false); // even at 95% token share the price is still inside the ladder: keep earning, no flip
assert.equal(shouldFlip({ ...on, enabled: false }), false);
assert.equal(shouldFlip({ ...on, isLadder: false }), false);
assert.equal(shouldFlip({ ...on, tokenSpot: true }), false);
assert.equal(shouldFlip({ ...on, flipPhase: true }), false); // never flips twice
// the real range status feeds the trigger: SOL=Y ladder [-60,-1]; active -1 is the top bin (still partly SOL), active -61 is below the lowest bin
const sol = ladderRangeStatus(-61, -1, 60, false);
assert.equal(sol.tokenBelowRange, true);
assert.equal(ladderRangeStatus(-60, -1, 60, false).isOutOfRange, false); // on the lowest bin: not yet 100% token
assert.equal(ladderRangeStatus(-60, -1, 60, false).tokenBelowRange, false);
assert.equal(ladderRangeStatus(0, -1, 60, false).tokenBelowRange, false); // above the ladder (all SOL) is not a flip
// SOL=X ladder [0,59]: falling price raises the bin id, below the ladder = active 60
assert.equal(ladderRangeStatus(60, 0, 60, true).tokenBelowRange, true);
assert.equal(ladderRangeStatus(59, 0, 60, true).tokenBelowRange, false);

// PnL basis: banked SOL counts, fees only when asked
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
near(pnlBasisSol(0.8, 0.02, 0.2, true), 1.02);
near(pnlBasisSol(0.8, 0.02, 0.2, false), 1.0);
near(pnlBasisSol(0.8, 0.02, 0, true), 0.82);

// flip-phase exits: waiting for the bounce is the strategy
const cfg: FlipExitConfig = { oorAboveExitMin: 10, tvlCollapsePct: 30 };
const inp: FlipExitInput = { isOutOfRange: false, tokenBelowRange: false, minutesOutOfRange: null, tvlUsd: 100_000, flipTvlUsd: 100_000 };
const sig = (o: Partial<FlipExitInput>) => flipExitSignal({ ...inp, ...o }, cfg);
assert.equal(sig({}), null);
assert.equal(sig({ isOutOfRange: true, tokenBelowRange: true, minutesOutOfRange: 6000 }), null); // below the range: no timer, however long
assert.equal(sig({ isOutOfRange: true, tokenBelowRange: false, minutesOutOfRange: 9.9 }), null); // sold out above, not yet 10 min
assert.match(sig({ isOutOfRange: true, tokenBelowRange: false, minutesOutOfRange: 10 })!, /^flip sold out above range: 10m >= 10m/);
// ExitConfirmer compares the text before the first ':' across ticks: it must not change as minutes/TVL move, or the 2-tick confirm never completes
const kind = (s: string | null) => s!.split(':')[0];
assert.equal(kind(sig({ isOutOfRange: true, minutesOutOfRange: 10.2 })), kind(sig({ isOutOfRange: true, minutesOutOfRange: 11.9 })));
assert.equal(kind(sig({ tvlUsd: 20_000 })), kind(sig({ tvlUsd: 19_000 })));
const confirm = new ExitConfirmer();
assert.equal(confirm.hit(sig({ tvlUsd: 20_000 }), 2), false);
assert.equal(confirm.hit(sig({ tvlUsd: 19_000 }), 2), true);
assert.equal(sig({ isOutOfRange: false, tokenBelowRange: false, minutesOutOfRange: 50 }), null); // inside the range is never an exit
assert.equal(sig({ tvlUsd: 30_000 }), null); // exactly 30% is not "under 30%"
assert.match(sig({ tvlUsd: 29_999 })!, /^liquidity collapse/);
assert.equal(sig({ tvlUsd: null }), null); // unknown TVL: skip
assert.equal(sig({ flipTvlUsd: null, tvlUsd: 1 }), null); // no flip-time reference (older state): skip
assert.equal(sig({ flipTvlUsd: 0, tvlUsd: 0 }), null);
assert.match(sig({ tvlUsd: 100, isOutOfRange: true, tokenBelowRange: true, minutesOutOfRange: 1 })!, /^liquidity collapse/); // collapse also exits while waiting below
// none of meridian's other signals exist in the flip phase (this function has no pnl, peak, bins-above or yield inputs); the normal config is untouched
const base: MeridianExitConfig = { takeProfitPct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeBinsToClose: 10, outOfRangeWaitMinutes: 30, minFeePerTvl24hPct: 7, minAgeBeforeYieldCheckMin: 60 };
const minp: MeridianExitInput = { pnlPct: 5, peakPnlPct: 5, binsAbove: 0, isOutOfRange: false, minutesOutOfRange: null, feePerTvl24hPct: 20, ageMinutes: 120 };
assert.match(meridianExitSignal(minp, base)!, /^take profit/);
assert.match(meridianExitSignal({ ...minp, pnlPct: 0, peakPnlPct: 0, binsAbove: 11 }, base)!, /^pumped far above/);

// which exit wins (index.ts uses selectExitSignal): stop loss always; flip phase = only flip-phase signals; a due flip suppresses meridian's rules; AI exit never in flip phase
const pick = (o: Partial<Parameters<typeof selectExitSignal>[0]>) => selectExitSignal({ stopLoss: null, flipPhase: false, flipWanted: false, flipPhaseSignal: null, meridianSignal: null, ...o });
assert.equal(pick({ stopLoss: 'stop loss: x', flipPhase: true, flipPhaseSignal: 'flip sold out above range: 10m >= 10m', meridianSignal: 'take profit: x' }), 'stop loss: x');
assert.equal(pick({ stopLoss: 'stop loss: x', flipWanted: true, meridianSignal: 'low yield: x' }), 'stop loss: x'); // the cycle stop loss beats a pending flip
assert.equal(pick({ flipPhase: true, meridianSignal: 'trailing TP: x' }), null); // flip phase ignores meridian's rules (trailing, TP, low yield, pumped-above, OOR timer)
assert.equal(pick({ flipPhase: true, flipPhaseSignal: 'liquidity collapse: x', meridianSignal: 'take profit: x' }), 'liquidity collapse: x');
assert.equal(pick({ flipWanted: true, meridianSignal: 'low yield: fee/TVL 5%' }), null); // below the range: flip instead of selling the dip
assert.equal(pick({ meridianSignal: 'take profit: x' }), 'take profit: x'); // normal SOL ladder: meridian's rules as before
assert.equal(aiExitAllowed({}), true);
assert.equal(aiExitAllowed({ tokenSpot: true }), true);
assert.equal(aiExitAllowed({ flipPhase: true }), false);

// where the flip ladder starts: above the OLD ladder's bottom, never below it
// token is X (SOL=Y): bin ids rise with price; the old ladder bottom is its lowest bin
assert.equal(flipAnchorBin(-700, -650, true), -650); // price fell 50 bins below the old bottom: asks start at the old bottom, not at -700
assert.equal(flipAnchorBin(-651, -650, true), -650);
assert.equal(flipAnchorBin(-640, -650, true), -640); // price already bounced above the old bottom: anchored at the price
assert.equal(flipAnchorBin(-700, undefined, true), -700); // no old bounds known: the active bin, as before
// token is Y (SOL=X): bin ids fall with price; the old ladder bottom is its highest bin
assert.equal(flipAnchorBin(700, 650, false), 650);
assert.equal(flipAnchorBin(640, 650, false), 640);
assert.equal(flipAnchorBin(700, undefined, false), 700);
// and the old bottom comes from ladderBounds exactly as executeFlip derives it
const oldSolY = ladderBounds(-1, 60, false);
assert.equal(oldSolY.lo, -60);
const oldSolX = ladderBounds(0, 60, true);
assert.equal(oldSolX.hi, 59);

// center of a flip position re-derived from its on-chain bin range (inverse of ladderBounds), both token sides
for (const depositIsX of [true, false]) {
  const b = ladderBounds(-373, 60, depositIsX);
  assert.equal(flipCenterFromBounds(b.lo, b.hi, depositIsX), -373);
}

// state files with and without the flip fields both parse
const wallet = 'W';
const pos = { poolAddress: 'p', mintX: 'x', mintY: 'y', reserveSolAccount: 'r', initialDepositSol: 1, lastRebalanceAt: 0, volume1hBaselineUsd: 0, volume1hBaselineSetAtMs: 0, binStep: 80, peakProfitPct: 0, otherMintDecimals: 6, xIsSol: false, rebalanceTimestamps: [], centerBinId: -1, outOfRangeSinceMs: null, inRangeSinceMs: null };
const st = (p: object) => JSON.stringify({ version: STATE_VERSION, savedAtMs: 1, wallet, position: p, inFlight: false, currentCapitalSol: 1, lastOtherMint: null, lastSwitchAtMs: null, blacklist: [], chaseGuard: [], dollarFlowBreach: { pool: '', count: 0 } });
assert.ok(parseState(st(pos), wallet));
const flipped = parseState(st({ ...pos, flipPhase: true, bankedSol: 0.2, flipTvlUsd: 100_000 }), wallet)!;
assert.equal(flipped.position?.flipPhase, true);
assert.equal(flipped.position?.bankedSol, 0.2);
assert.equal(flipped.position?.flipTvlUsd, 100_000); // survives a restart; cost basis (initialDepositSol) is untouched by the flip fields
assert.equal(flipped.position?.initialDepositSol, 1);

// AI prompts describe the lifecycle only while the flip is enabled, with the new rules
const envOn = { FLIP_ENABLED: true, FLIP_OOR_ABOVE_EXIT_MIN: 10, STOP_LOSS_PCT: 25 };
assert.equal(flipPromptInfo({ ...envOn, FLIP_ENABLED: false }), null);
const info = flipPromptInfo(envOn)!;
assert.equal(info.oorAboveExitMin, 10);
const rules = { stopLossPct: 25, ladderOorExitMin: 30, idleOutOfRangeMin: 60, volumeDropExitPct: 60 };
const scrOn = buildReactScreenerPrompt(0.3, '', [], info);
const scrOff = buildReactScreenerPrompt(0.3, '', [], null);
assert.match(scrOn, /BID-ASK FLIP/);
assert.match(scrOn, /BELOW the lowest bin/);
assert.match(scrOn, /no AI close/);
assert.doesNotMatch(scrOn, /about 80%|trailing stop that arms/);
assert.doesNotMatch(scrOff, /BID-ASK FLIP/);
const manOn = buildReactManagerPrompt(rules, '', [], info);
assert.match(manOn, /bid_ask_flip/);
assert.match(manOn, /AI close is blocked/);
assert.doesNotMatch(manOn, /about 80%|trailing stop that arms/);
assert.doesNotMatch(buildReactManagerPrompt(rules, '', [], null), /bid_ask_flip/);

console.log('checkFlip ok');
