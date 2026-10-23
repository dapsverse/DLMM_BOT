/**
 * Pure helpers of the standalone shadow runner (src/scripts/shadowRunner.ts). The runner scans pools like the entry does and feeds the SHADOW
 * strategy selector, WITHOUT a wallet: no signer, no transactions, no swaps. No imports: loadable by a self-check.
 */
export const SHADOW_RUNNER_DUMMY_KEY = 'SHADOW_RUNNER_NO_KEY';
const WSOL = 'So11111111111111111111111111111111111111112';

/** The runner only starts with this exact placeholder as PRIVATE_KEY, so a real key can never be in its process by accident (env.ts demands the variable to exist). */
export const isRunnerKeySafe = (privateKey: string | undefined): boolean => privateKey === SHADOW_RUNNER_DUMMY_KEY;

export interface RunnerCandidate {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  bin_step: number;
  buyRatio1h?: number;
  tokenX: { priceUsd?: number };
  tokenY: { priceUsd?: number };
}

export interface RunnerTarget {
  pool: string;
  name: string | null;
  mint: string;
  binStep: number;
  buyRatio1h: number | null;
  solPriceUsd: number | null;
  aiStrategy: string;
  aiConviction: null;
}

/** First `top` SOL-quoted candidates (the scanner already ranks them), shaped for shadowDecision. Non-SOL-quoted pools are skipped like the live entry does. */
export function pickRunnerTargets(candidates: RunnerCandidate[], top: number): RunnerTarget[] {
  const out: RunnerTarget[] = [];
  for (const c of candidates) {
    if (out.length >= top) break;
    const xIsSol = c.mint_x === WSOL;
    if (!xIsSol && c.mint_y !== WSOL) continue;
    const solPrice = xIsSol ? c.tokenX.priceUsd : c.tokenY.priceUsd;
    out.push({
      pool: c.address,
      name: c.name ?? null,
      mint: xIsSol ? c.mint_y : c.mint_x,
      binStep: c.bin_step,
      buyRatio1h: c.buyRatio1h ?? null,
      solPriceUsd: typeof solPrice === 'number' && Number.isFinite(solPrice) ? solPrice : null,
      aiStrategy: 'shadow_runner',
      aiConviction: null,
    });
  }
  return out;
}
