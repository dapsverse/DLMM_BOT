/**
 * Self-check for splitFeeFromOtherBalance (rebalanceEngine.ts) — added
 * 2026-10-07/08 per user's call: on any close, keep the fee-sized portion
 * of the non-SOL side as raw token (their own decision when to sell)
 * instead of auto-swapping everything to SOL. Only the principal portion
 * keeps recompounding through currentCapitalSol.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkFeeTokenSplit.ts`.
 */
import assert from 'node:assert';
import BN from 'bn.js';
import { splitFeeFromOtherBalance } from '../logic/rebalanceEngine.js';

// "Closed upward" case (DARK-SOL incident): bin mechanics already swept
// nearly all principal into SOL, so the leftover non-SOL balance is almost
// entirely fee — expect almost everything kept as token, almost nothing swapped.
{
  const feeOtherRaw = new BN(1_000_000);
  const totalOtherRaw = new BN(1_050_000); // small residual principal on top of the fee
  const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(feeOtherRaw, totalOtherRaw);
  assert(toKeepAsToken.eq(feeOtherRaw), 'expected toKeepAsToken to equal the fee amount exactly');
  assert(toSwap.eq(new BN(50_000)), 'expected toSwap to be only the small residual principal above the fee');
}

// "Closed downward" case: principal is still mostly in token form — only the fee-sized sliver should be kept, the large principal still gets swapped.
{
  const feeOtherRaw = new BN(1_000);
  const totalOtherRaw = new BN(50_000_000); // large principal, price dropped
  const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(feeOtherRaw, totalOtherRaw);
  assert(toKeepAsToken.eq(feeOtherRaw), 'expected toKeepAsToken to still equal just the fee amount');
  assert(toSwap.eq(new BN(49_999_000)), 'expected toSwap to be nearly the entire balance (principal), unchanged behavior from before this feature');
}

// Safety clamp: fee amount read moments before close must never exceed the
// actual post-close balance (e.g. a stale/slightly-off read) — never swap a negative amount.
{
  const feeOtherRaw = new BN(100);
  const totalOtherRaw = new BN(40); // less than the "fee" we thought we'd see
  const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(feeOtherRaw, totalOtherRaw);
  assert(toKeepAsToken.eq(new BN(40)), 'expected toKeepAsToken clamped to the actual available balance, never more');
  assert(toSwap.eq(new BN(0)), 'expected toSwap to be zero, never negative, when fee estimate exceeds actual balance');
}

// Zero fee (e.g. a brand-new position with no accrued fee yet) -> everything swapped, same as the old behavior.
{
  const { toSwap, toKeepAsToken } = splitFeeFromOtherBalance(new BN(0), new BN(12_345));
  assert(toKeepAsToken.eq(new BN(0)), 'expected nothing kept as token when there is no fee');
  assert(toSwap.eq(new BN(12_345)), 'expected the full balance to be swapped when there is no fee');
}

console.log('OK: splitFeeFromOtherBalance keeps exactly the fee-sized portion as token (clamped, never negative) and swaps the rest, regardless of whether the close happened upward or downward');
