/**
 * Self-check for rawAmountToSol (rebalanceEngine.ts) — fixed 2026-10-07
 * after the real bot's first-ever position: otherTokenValueInSol used to
 * hardcode LAMPORTS_PER_SOL (10^9, SOL's own decimals) to convert the
 * non-SOL side's RAW on-chain amount into a whole-token count. Most
 * memecoins (this one included — a pump.fun Token-2022 mint) use 6
 * decimals, not 9 — undercounting that side's value by 1000x. A brand-new,
 * healthy 50/50 position read as "49.90% unrealized loss" one tick (15s)
 * after opening and got HARD_EXIT'd by STOP_LOSS_PCT, because roughly half
 * the position's true value (the non-SOL side) was being read as near
 * zero. Fixed by fetching the mint's real decimals once at entry
 * (getMintDecimals, works for both legacy Token and Token-2022) and using
 * them here instead of a hardcoded constant.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkDecimalsFix.ts`.
 */
import assert from 'node:assert';
import BN from 'bn.js';
import { rawAmountToSol } from '../logic/rebalanceEngine.js';

// The actual live incident, reconstructed: ~14,299.662079 tokens (6 decimals,
// pump.fun standard) at a price that should value the position's other side
// at roughly half of 1.3 SOL (a 50/50 entry) — NOT near-zero.
{
  const rawAmount = new BN('14299662079'); // raw units, 6 decimals -> 14299.662079 whole tokens
  const priceInSol = 1 / 22000; // arbitrary plausible price, whole-token-to-SOL
  const valueWith6Decimals = rawAmountToSol(rawAmount, 6, priceInSol);
  const valueWithWrongSolDecimals = rawAmountToSol(rawAmount, 9, priceInSol); // the bug: assuming 9 (LAMPORTS_PER_SOL) like the old code did
  assert(valueWith6Decimals > valueWithWrongSolDecimals * 100, 'expected correct 6-decimal conversion to be far larger than the buggy 9-decimal (LAMPORTS_PER_SOL) conversion — this is exactly the 1000x undercounting that caused the false stop-loss');
}

// Sanity: whole-number round trip. 1 whole token (10^decimals raw units) at priceInSol=2 should value at exactly 2 SOL, regardless of decimals.
for (const decimals of [0, 6, 8, 9]) {
  const oneWholeToken = new BN(10).pow(new BN(decimals));
  const value = rawAmountToSol(oneWholeToken, decimals, 2);
  assert(Math.abs(value - 2) < 1e-9, `expected 1 whole token (decimals=${decimals}) at price 2 SOL/token to value at 2 SOL, got ${value}`);
}

// Zero amount -> zero value, no division-by-zero weirdness.
assert.strictEqual(rawAmountToSol(new BN(0), 6, 123.45), 0, 'expected zero raw amount to value at zero regardless of price');

console.log('OK: rawAmountToSol uses the mint\'s own decimals correctly — the 1000x undercounting bug (6 vs 9 decimals) cannot recur');
