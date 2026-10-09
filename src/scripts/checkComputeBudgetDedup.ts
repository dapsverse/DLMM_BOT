/**
 * Self-check for stripComputeBudgetInstructions (meteoraDLMM.ts) — fixed
 * 2026-10-07 after the real bot's first-ever position-open attempts all
 * failed simulation with "Transaction contains a duplicate instruction
 * that is not allowed". Root cause: @meteora-ag/dlmm's
 * initializePositionAndAddLiquidityByStrategy already embeds its own
 * SetComputeUnitLimit/SetComputeUnitPrice instructions in the Transaction
 * it returns; withPriorityFee used to blindly unshift a SECOND pair on
 * top, producing duplicate ComputeBudget instructions that Solana's
 * runtime rejects outright.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkComputeBudgetDedup.ts`.
 */
import assert from 'node:assert';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { stripComputeBudgetInstructions } from '../services/meteoraDLMM.js';

const otherProgram = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'); // real DLMM program id, arbitrary "not compute budget" stand-in

const sdkComputeLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 123_456 });
const sdkComputePrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
const realIx1 = { programId: otherProgram, keys: [], data: Buffer.from([1]) };
const realIx2 = { programId: otherProgram, keys: [], data: Buffer.from([2]) };

// SDK already embedded its own ComputeBudget instructions, mixed in with real ones.
const mixed = [sdkComputeLimit, sdkComputePrice, realIx1, realIx2];
const stripped = stripComputeBudgetInstructions(mixed);
assert.strictEqual(stripped.length, 2, `expected only the 2 non-ComputeBudget instructions to remain, got ${stripped.length}`);
assert(stripped.every((ix) => ix.programId.equals(otherProgram)), 'expected every remaining instruction to belong to the non-ComputeBudget program');

// No ComputeBudget instructions present at all — passes through unchanged.
const noneToStrip = [realIx1, realIx2];
assert.strictEqual(stripComputeBudgetInstructions(noneToStrip).length, 2, 'expected instructions to pass through untouched when there is nothing to strip');

// ALL instructions are ComputeBudget — strips down to empty, doesn't throw.
const allComputeBudget = [sdkComputeLimit, sdkComputePrice];
assert.strictEqual(stripComputeBudgetInstructions(allComputeBudget).length, 0, 'expected an all-ComputeBudget instruction list to strip down to empty');

console.log('OK: stripComputeBudgetInstructions removes pre-existing ComputeBudget instructions (from the SDK) so re-adding our own never produces a duplicate');
