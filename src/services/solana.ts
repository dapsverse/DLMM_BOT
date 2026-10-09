import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import { env } from '../config/env.js';
import { RPC_MAX_RETRIES, RPC_RETRY_BASE_DELAY_MS, WSOL_MINT } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

export { connection, getDynamicPriorityFeeMicroLamports } from './rpc.js';
import { connection } from './rpc.js';

/**
 * Wallet keypair, decoded once at boot. `env.PRIVATE_KEY` itself is never
 * logged (see logger.ts redaction) and this decoded Keypair is never
 * serialized back out anywhere in the codebase — treat it as write-only.
 *
 * ponytail: this decode is eager (module load time), so anything that
 * imports solana.ts needs a real 64-byte secret key. Read-only tooling
 * (dry-run scans, mint-authority checks) must import from ./rpc.js instead
 * — that module has no wallet dependency at all.
 */
export const wallet: Keypair = Keypair.fromSecretKey(bs58.decode(env.PRIVATE_KEY));

export function getWalletPubkey(): PublicKey {
  return wallet.publicKey;
}

export async function getWalletSolBalance(): Promise<number> {
  const lamports = await withRetry(() => connection.getBalance(wallet.publicKey), {
    maxRetries: RPC_MAX_RETRIES,
    baseDelayMs: RPC_RETRY_BASE_DELAY_MS,
    label: 'getBalance',
  });
  return lamports / 1e9;
}

/**
 * Raw on-chain balance for any mint, native SOL or SPL (legacy Token or
 * Token-2022 — getParsedTokenAccountsByOwner's {mint} filter handles both
 * transparently). Shared by rebalanceEngine.ts and jupiterSwap.ts (moved
 * here 2026-10-07 to avoid a circular import between them — see
 * waitForTokenBalance below for why jupiterSwap.ts needs this too).
 */
export async function getTokenBalance(mint: string): Promise<BN> {
  if (mint === WSOL_MINT) {
    const lamports = await connection.getBalance(wallet.publicKey);
    return new BN(lamports);
  }
  const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  return resp.value.reduce((sum, acc) => {
    const amount = acc.account.data.parsed.info.tokenAmount.amount as string;
    return sum.add(new BN(amount));
  }, new BN(0));
}

/**
 * Polls getTokenBalance until it reflects at least `expectedMinimum`, or
 * gives up after a few tries. Found live 2026-10-07 (real bot's first
 * position): a swap's confirmTransaction resolving at 'confirmed'
 * commitment doesn't guarantee the VERY NEXT RPC call (on a load-balanced
 * provider) lands on a backend that has caught up yet — reading the
 * post-swap balance immediately afterward can still return stale
 * (pre-swap) state. Confirmed live via the actual on-chain transaction: the
 * memecoin token balance was IDENTICAL before and after the "AddLiquidity"
 * instruction that was supposed to deposit it — the deposit amount passed
 * in was 0 because the balance read moments earlier came back empty/stale,
 * not because the swap itself failed (it had already landed, tokens were
 * sitting in the wallet the whole time). Used by both openInitialPosition
 * (first entry) and balanceTokenRatio (compound/rebalance swaps) — same
 * race, same fix, one shared function instead of two copies.
 */
export async function waitForTokenBalance(mint: string, expectedMinimum: BN, maxAttempts = 5, delayMs = 800): Promise<BN> {
  let last = new BN(0);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await getTokenBalance(mint);
    if (last.gte(expectedMinimum)) return last;
    logger.warn('[solana] balance read below expected, retrying', {
      mint,
      got: last.toString(),
      expectedMinimum: expectedMinimum.toString(),
      attempt: attempt + 1,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `[solana] balance for mint ${mint} still reads ${last.toString()} after ${maxAttempts} retries, expected at least ${expectedMinimum.toString()} — refusing to proceed on a stale/short balance`,
  );
}
