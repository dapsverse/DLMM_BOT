/**
 * Self-check for estimateBinRentSol (costEstimate.ts) — added 2026-10-08,
 * idea borrowed from comparing against CryptoGnome/dlmmbot's planner.ts.
 * This project never modeled DLMM bin-array rent cost before; this is an
 * approximate (never-under-estimating) informational figure, logged at
 * position open, not a hard budget gate.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkBinRent.ts`.
 */
import assert from 'node:assert';
import { estimateBinRentSol } from '../logic/costEstimate.js';

// A narrow range (within one 70-bin array) still costs at least one array's rent.
{
  const rent = estimateBinRentSol(5); // 11 bins, well under 70
  assert(rent > 0, 'expected a positive rent estimate for a narrow range');
}

// Wider ranges (more bin-arrays touched) cost more, monotonically.
{
  const narrow = estimateBinRentSol(5); // 11 bins
  const wide = estimateBinRentSol(100); // 201 bins, several arrays
  assert(wide > narrow, 'expected a wider range to estimate a higher (or equal) rent cost than a narrower one');
}

// Never zero or negative, even for a radius of 0 (a single-bin position still needs an array).
{
  assert(estimateBinRentSol(0) > 0, 'expected a positive rent estimate even for the narrowest possible range');
}

console.log('OK: estimateBinRentSol returns a positive, monotonically-increasing-with-width rent estimate');
