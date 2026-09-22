import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { env } from '../config/env.js';
import { RPC_MAX_RETRIES, RPC_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { withRetry } from '../utils/retry.js';

export { connection, isMintAuthorityRevoked, getDynamicPriorityFeeMicroLamports } from './rpc.js';
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
