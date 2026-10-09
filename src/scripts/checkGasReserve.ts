/**
 * Self-check for reserveGasFromSolSide + computeGasReserveSol
 * (rebalanceEngine.ts).
 *
 * reserveGasFromSolSide: fixed 2026-10-07 after the real bot's first-ever
 * live run: openInitialPosition deposited the FULL on-chain SOL balance
 * (including the gas reserve) into a brand-new DLMM position, leaving
 * nothing for rent/tx fees and failing simulation with "insufficient
 * lamports". compoundCycle already reserved correctly; openInitialPosition
 * didn't, and this gap was never exercised until a real first-time entry
 * happened (paper-trade doesn't touch this code path at all — it has its
 * own simulation). Both call sites now share this one function instead of
 * two independent copies.
 *
 * computeGasReserveSol: added 2026-10-08, idea borrowed from comparing
 * against CryptoGnome/dlmmbot's reserveSol() — a flat reserve value goes
 * stale as the wallet's actual balance drifts (this project manually
 * re-tuned MIN_GAS_RESERVE_SOL by hand after nearly every restart the
 * night real money went live). Reserve now scales with equity
 * (MIN_GAS_RESERVE_PCT), with MIN_GAS_RESERVE_SOL as an absolute floor for
 * small balances.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkGasReserve.ts`.
 */
import assert from 'node:assert';
import BN from 'bn.js';
import { reserveGasFromSolSide, computeGasReserveSol } from '../logic/rebalanceEngine.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const FLOOR = Number(process.env.MIN_GAS_RESERVE_SOL ?? 0.05);
const PCT = Number(process.env.MIN_GAS_RESERVE_PCT ?? 5);

// computeGasReserveSol: at small equity, the floor wins.
{
  const tinyEquity = 0.1; // pct component (0.1 * pct/100) is far below the floor
  const reserve = computeGasReserveSol(tinyEquity);
  assert.strictEqual(reserve, FLOOR, `expected the floor (${FLOOR}) to win at tiny equity, got ${reserve}`);
}

// computeGasReserveSol: at large equity, the percentage wins.
{
  const bigEquity = 1000; // pct component (1000 * pct/100) is far above the floor
  const reserve = computeGasReserveSol(bigEquity);
  const expectedPct = bigEquity * (PCT / 100);
  assert.strictEqual(reserve, expectedPct, `expected the pct component (${expectedPct}) to win at large equity, got ${reserve}`);
  assert(reserve > FLOOR, 'expected the scaled reserve to exceed the flat floor at large equity — the whole point of this feature');
}

// computeGasReserveSol: scales up as equity grows (not frozen at one historical value, the bug this fixes).
{
  const reserveAt1 = computeGasReserveSol(1);
  const reserveAt10 = computeGasReserveSol(10);
  assert(reserveAt10 > reserveAt1, 'expected the reserve to scale up as equity grows, not stay frozen at one flat value');
}

// mintX is SOL: balX should have the (equity-scaled) reserve subtracted, balY untouched.
{
  const balX = new BN(1.3 * LAMPORTS_PER_SOL); // SOL side
  const balY = new BN(500_000_000_000); // memecoin side, arbitrary raw units
  const { depositX, depositY } = reserveGasFromSolSide(balX, balY, true);
  assert(!depositX.eq(balX), 'expected SOL side (X) to have the gas reserve subtracted, got the untouched full balance back (the exact bug this fixes)');
  assert(depositY.eq(balY), 'expected non-SOL side (Y) to pass through untouched when X is the SOL side');
}

// mintY is SOL: balY should have the reserve subtracted, balX untouched.
{
  const balX = new BN(500_000_000_000);
  const balY = new BN(1.3 * LAMPORTS_PER_SOL);
  const { depositX, depositY } = reserveGasFromSolSide(balX, balY, false);
  assert(depositX.eq(balX), 'expected non-SOL side (X) to pass through untouched when Y is the SOL side');
  assert(!depositY.eq(balY), 'expected SOL side (Y) to have the gas reserve subtracted');
}

// Never goes negative: a SOL balance smaller than the reserve clamps to zero, doesn't throw/underflow.
{
  const tiny = new BN(1); // 1 lamport, far below any real reserve
  const other = new BN(1000);
  const { depositX } = reserveGasFromSolSide(tiny, other, true);
  assert(depositX.gten(0), 'expected deposit amount to clamp at zero, not go negative, when balance is below the reserve');
}

console.log('OK: computeGasReserveSol scales with equity (floor at small balances, pct at large ones); reserveGasFromSolSide subtracts it from the correct side only, clamps at zero');
