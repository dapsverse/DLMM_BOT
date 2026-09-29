import axios from 'axios';
import { env } from '../config/env.js';
import {
  METEORA_POOLS_URL,
  METEORA_POOLS_PAGE_SIZE,
  DEXSCREENER_TOKEN_URL,
  DEXSCREENER_TOKENS_BATCH_URL,
  DEXSCREENER_BATCH_MAX_ADDRESSES,
  SOLANA_CHAIN_ID,
  WSOL_MINT,
  MIN_SCAN_INTERVAL_MS,
  PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT,
  TREND_SHORTLIST_SIZE,
  HTTP_MAX_RETRIES,
  HTTP_RETRY_BASE_DELAY_MS,
} from '../config/constants.js';
import { isRateLimitError, withRetry, mapWithConcurrency } from '../utils/retry.js';
import { isMintAuthorityRevokedViaRugCheck } from './rugcheck.js';
import { logger } from '../utils/logger.js';

// ponytail: flat concurrency cap for RPC hydration, not a real rate limiter —
// good enough to keep public/free-tier RPC from 429-storming on every scan;
// tune down if running against a free-tier RPC, up if on a paid one.
const RPC_HYDRATION_CONCURRENCY = 4;

// ponytail: first-cut wash-trading heuristic, hardcoded not env-configurable
// — no calibration data yet to justify exposing knobs. Revisit if false
// positives/negatives show up in practice.
const WASH_TRADE_VOL_TVL_RATIO_THRESHOLD = 30;
const WASH_TRADE_FLAT_PRICE_BAND_PCT = 2;

// ENTRY_MIN_BUY_RATIO_1H / ENTRY_MIN_SPIKE_RATIO moved to ScannerConfig
// (config.entryMinBuyRatio1h / config.entryMinSpikeRatio, env-tunable) —
// see env.ts doc comments for full rationale. Confirmed live 2026-09-24 via
// src/scripts/diagnoseRejections.ts: at their original defaults (0.5 / 1.0)
// these two checks alone were rejecting 53%/80% of all real candidates,
// stacked on top of an already-tight pre-existing screen — 0/123 pools
// survived. Needed to be tunable, not hardcoded, to A/B different values.

/**
 * This hour's volume vs. the preceding 5h's average pace (via DexScreener's
 * 6h volume figure) — a ratio well above 1 means volume just surged above
 * its own recent baseline, not just "the pool has been busy over the last
 * 24h" (which a static vol/TVL ratio can't distinguish from stale/decaying
 * activity). Returns 0 (never wins a tie-break) when 6h data never
 * hydrated; caps at a large-but-finite number instead of Infinity when the
 * prior baseline is ~0 so sorting stays well-defined.
 */
export function volumeSpikeRatio(p: MeteoraPair): number {
  const h6 = p.volumeH6Usd;
  const h1 = p.volume1hUsd;
  if (h6 === undefined) return 0;
  const priorPace = (h6 - h1) / 5;
  if (priorPace <= 0) return h1 > 0 ? 1_000 : 0;
  return h1 / priorPace;
}

/** Metadata used only for the memecoin screen (not needed once a pool is picked). */
export interface TokenMeta {
  address: string;
  priceUsd: number;
  marketCapUsd: number;
  holders: number;
  freezeAuthorityDisabled: boolean;
  /** Hydrated on-chain (not in the Meteora API) — undefined until checked, null if the RPC lookup failed. */
  mintAuthorityRevoked?: boolean | null;
}

/** Normalized pool shape this bot works with internally (flat, independent of upstream API shape). */
export interface MeteoraPair {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  liquidity: string; // TVL in USD, stringified number
  trade_volume_24h: number;
  fees_24h: number;
  bin_step: number;
  current_price: number;
  createdAtMs: number;
  volume1hUsd: number;
  fees1hUsd: number;
  tokenX: TokenMeta;
  tokenY: TokenMeta;
  /** Not part of the raw API — hydrated from DexScreener if available. */
  priceChange1hPct?: number;
  /** Longer trend window than 1h — memecoin 1h moves are noisy, 6h is a steadier uptrend/downtrend signal. */
  priceChange6hPct?: number;
  priceChange24hPct?: number;
  /** DexScreener's 5-minute volume — catches a pool whose 24h number looks fine but has basically gone dead right now. */
  volumeM5Usd?: number;
  /** DexScreener's 6h volume — baseline window for volume-spike detection (see volumeSpikeRatio). */
  volumeH6Usd?: number;
  /** DexScreener's 5-minute buy+sell count — $ volume can look fine while literally 0 trades happened just now; this catches that directly. */
  txCountM5?: number;
  /** DexScreener's 1h buys / (buys+sells) — a volume spike can be genuine buying pressure OR a sell-off/dump; this distinguishes them. Used to gate the opportunistic-switch candidate (see evaluateSwitchOpportunity) so a "spike" that's actually distribution doesn't trigger a switch. */
  buyRatio1h?: number;
  /**
   * True when this pool's whole DexScreener batch call failed (429/timeout/etc) —
   * distinct from a pool that DexScreener simply has no data for. Every
   * unknown-tolerant check above ("unknown, don't block") stays permissive for a
   * genuinely-missing field, but a hydration FAILURE means we don't actually know
   * whether this pool would pass those checks — fresh entries treat it as a reject
   * (see filterAndRankPools) rather than silently letting bad data slip through as
   * "unknown". See STONK10 incident: batch hydration failed, txCountM5 stayed
   * undefined, pool entered with real 5m tx count of 4 (min is 20).
   */
  dexHydrationFailed?: boolean;
}

/**
 * Raw shape of `dlmm.datapi.meteora.ag/pools` (nested, paginated) — replaced
 * the old flat `dlmm-api.meteora.ag/pair/all` (single array, 404s as of
 * Sept 2026). Only the fields we read are declared here.
 */
interface RawTokenMeta {
  address: string;
  price: number;
  market_cap: number;
  holders: number;
  freeze_authority_disabled: boolean;
}

interface RawMeteoraPool {
  address: string;
  name: string;
  token_x: RawTokenMeta;
  token_y: RawTokenMeta;
  tvl: number;
  current_price: number;
  pool_config: { bin_step: number };
  volume: { '1h': number; '24h': number };
  fees: { '1h': number; '24h': number };
  created_at: number; // epoch ms
}

interface RawMeteoraPoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  data: RawMeteoraPool[];
}

function normalizeTokenMeta(raw: RawTokenMeta): TokenMeta {
  return {
    address: raw.address,
    priceUsd: raw.price,
    marketCapUsd: raw.market_cap,
    holders: raw.holders,
    freezeAuthorityDisabled: raw.freeze_authority_disabled,
  };
}

function normalizePool(raw: RawMeteoraPool): MeteoraPair {
  return {
    address: raw.address,
    name: raw.name,
    mint_x: raw.token_x.address,
    mint_y: raw.token_y.address,
    liquidity: String(raw.tvl),
    trade_volume_24h: raw.volume['24h'],
    fees_24h: raw.fees['24h'],
    bin_step: raw.pool_config.bin_step,
    current_price: raw.current_price,
    createdAtMs: raw.created_at,
    volume1hUsd: raw.volume['1h'],
    fees1hUsd: raw.fees['1h'],
    tokenX: normalizeTokenMeta(raw.token_x),
    tokenY: normalizeTokenMeta(raw.token_y),
  };
}

/** Whichever side of the pool is WSOL. */
export function solToken(pair: MeteoraPair): TokenMeta | null {
  if (pair.mint_x === WSOL_MINT) return pair.tokenX;
  if (pair.mint_y === WSOL_MINT) return pair.tokenY;
  return null;
}

/** Whichever side of the pool isn't WSOL — the "memecoin" side the screen evaluates. */
export function nonSolToken(pair: MeteoraPair): TokenMeta | null {
  if (pair.mint_x === WSOL_MINT) return pair.tokenY;
  if (pair.mint_y === WSOL_MINT) return pair.tokenX;
  return null; // neither side is SOL — this bot's engine only handles SOL-quoted pools
}

export interface ScannerConfig {
  minTvlUsd: number;
  minVolume24hUsd: number;
  minVolTvlRatio: number;
  maxMemecoinMarketCapUsd: number;
  minTokenHolders: number;
  requireFreezeAuthorityDisabled: boolean;
  requireMintAuthorityDisabled: boolean;
  minBinStep: number;
  minPoolAgeHours: number;
  requireUptrend: boolean;
  minPriceChange6hPct: number;
  minRecentActivityRatio: number;
  /** Absolute floor on 5-minute buy+sell count — a relative-to-24h-average ratio can still pass with 0 real trades if the pool's own baseline is already weak; this is a hard, non-relative "is anyone actually trading right now" check. */
  minTxCountM5: number;
  /** Entry-only ceiling on 1h price change — a pool already up more than this in the last hour is more likely near/past a local top than early in a move. See the overextension-ceiling check in filterAndRankPools. */
  maxPriceChange1hPumpPct: number;
  /** Entry-only ceiling on 24h price change — catches a pool whose whole move already happened over the last day and has since decelerated under the 1h ceiling above. See MAX_PRICE_CHANGE_24H_PUMP_PCT doc comment (env.ts) for the GO-SOL/familiars-SOL incidents that motivated this. */
  maxPriceChange24hPumpPct: number;
  /** Floor on 1h buyRatio (buys/(buys+sells)) — below this, activity is treated as sell-dominant, not a genuine pump signal. Applies in both entry and re-screen modes. */
  entryMinBuyRatio1h: number;
  /** Entry-only floor on volumeSpikeRatio — below this, a pool isn't accelerating at all, regardless of how it ranks against other candidates. Only enforced in 'momentum' entryStrategyMode. */
  entryMinSpikeRatio: number;
  /** Which entry track to use — see ENTRY_STRATEGY_MODE (env.ts) for the full rationale. 'momentum' (default) chases acceleration (entryMinSpikeRatio + rankCandidates). 'trend' requires a large SUSTAINED move (trendMinSustainedPct on both 6h and 24h) and ranks by TVL (rankTrendCandidates). 'range' is the opposite of both — requires LOW volatility (rangeMaxVolatilityPct) and ranks by vol/TVL turnover (rankRangeCandidates), for the DLMM/LP execution path specifically (fee yield with minimal IL). */
  entryStrategyMode: 'momentum' | 'trend' | 'range';
  /** Entry-only floor (both 6h AND 24h price change must clear this) for 'trend' entryStrategyMode — unknown data fails closed, unlike the rest of the screen's permissive-unknown policy, since verifying a sustained trend is the entire point of this mode. */
  trendMinSustainedPct: number;
  /** Ceiling on |1h| and |6h| price change for 'range' entryStrategyMode — unlike every other sizing check, NOT skipped on re-screen (see RANGE_MAX_VOLATILITY_PCT, env.ts): a held range-bound position that starts trending broke its own investment thesis. */
  rangeMaxVolatilityPct: number;
  /**
   * Entry-only ceiling on (capital about to enter this pool) / (pool TVL),
   * as a percent — e.g. 5 means our deposit can't exceed 5% of the pool's
   * liquidity. Added 2026-09-25 to replace MIN_TVL_USD as the real
   * slippage-safety gate: a fixed dollar floor doesn't know how big our
   * capital actually is, so it either blocks genuinely-safe small-cap pools
   * (confirmed live: 6 of 7 sampled ~$300k-mcap pools had 0.3-3.3% capital/
   * TVL ratio — completely safe for our ~$130 capital — but sat on
   * $472-$22,632 TVL, all below the old $35k/$50k floor) or, if loosened
   * enough to admit them, would just as easily admit a genuinely-too-thin
   * pool too (the 7th sample, MACCA-SOL: $472 TVL, 27.5% ratio — real
   * price-impact risk). This scales automatically as capital compounds:
   * the same ratio requires proportionally more TVL as the deposit grows.
   */
  maxCapitalTvlRatioPct: number;
  blacklistPools: Map<string, number>; // poolAddress -> blacklisted-until (epoch ms)
}

let lastScanAt = 0;

function isBlacklisted(poolAddress: string, blacklistPools: Map<string, number>): boolean {
  const until = blacklistPools.get(poolAddress);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    blacklistPools.delete(poolAddress); // expired, self-clean
    return false;
  }
  return true;
}

/**
 * Fetches the top pools by 24h volume (single page). There are 100k+ DLMM
 * pools total; since MIN_24H_VOLUME_USD/MIN_TVL_USD are floors, real
 * candidates always rank near the top of a volume-sorted list — pulling
 * the top page is equivalent to a full scan for this bot's purposes without
 * paginating through the entire (mostly-dead) pool universe every 60s.
 */
export async function fetchTopPools(): Promise<MeteoraPair[]> {
  const res = await withRetry(
    () =>
      axios.get<RawMeteoraPoolsResponse>(METEORA_POOLS_URL, {
        timeout: 15_000,
        params: { page: 1, page_size: METEORA_POOLS_PAGE_SIZE, sort_by: 'volume_24h:desc' },
      }),
    {
      maxRetries: HTTP_MAX_RETRIES,
      baseDelayMs: HTTP_RETRY_BASE_DELAY_MS,
      isRetryable: isRateLimitError,
      label: 'meteora:pools',
    },
  );
  return res.data.data.map(normalizePool);
}

interface DexScreenerPair {
  baseToken?: { address?: string };
  dexId?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number };
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
}

/** Trailing 1h USD volume for a token, used by riskManager's volume-drop hard-exit check. */
export async function getVolume1hUsd(mint: string): Promise<number | null> {
  try {
    const res = await withRetry(
      () => axios.get<{ pairs?: DexScreenerPair[] }>(`${DEXSCREENER_TOKEN_URL}/${mint}`, { timeout: 10_000 }),
      { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:volume1h' },
    );
    // A mint can trade on multiple DEXs (Raydium/PumpSwap/Orca/...) —
    // DexScreener returns all of them, not just our Meteora pool. Taking
    // pairs[0] blind (old behavior) could compare OUR held position's
    // volume-drop against a completely different DEX's activity. Find the
    // Meteora-specific pair; permissive-unknown (null) if none, same policy
    // as every other DexScreener-sourced field in this file.
    const meteoraPair = res.data.pairs?.find((p) => p.dexId === 'meteora');
    const h1 = meteoraPair?.volume?.h1;
    return typeof h1 === 'number' ? h1 : null;
  } catch (err) {
    logger.debug(`[scanner] dexscreener volume1h lookup failed for ${mint}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Applies one hydrated DexScreener pair's fields onto our MeteoraPair —
 * shared by the batch hydration below so the field-mapping logic exists
 * in exactly one place.
 */
function applyDexScreenerFields(pair: MeteoraPair, dexPair: DexScreenerPair): void {
  const priceChange = dexPair.priceChange;
  if (typeof priceChange?.h1 === 'number') pair.priceChange1hPct = priceChange.h1;
  if (typeof priceChange?.h6 === 'number') pair.priceChange6hPct = priceChange.h6;
  if (typeof priceChange?.h24 === 'number') pair.priceChange24hPct = priceChange.h24;
  if (typeof dexPair.volume?.m5 === 'number') pair.volumeM5Usd = dexPair.volume.m5;
  if (typeof dexPair.volume?.h6 === 'number') pair.volumeH6Usd = dexPair.volume.h6;
  const m5Txns = dexPair.txns?.m5;
  if (typeof m5Txns?.buys === 'number' && typeof m5Txns?.sells === 'number') pair.txCountM5 = m5Txns.buys + m5Txns.sells;
  const h1Txns = dexPair.txns?.h1;
  if (typeof h1Txns?.buys === 'number' && typeof h1Txns?.sells === 'number' && h1Txns.buys + h1Txns.sells > 0) {
    pair.buyRatio1h = h1Txns.buys / (h1Txns.buys + h1Txns.sells);
  }
}

/**
 * Hydrates price-change fields (1h/6h/24h), volume (m5/h6), and 5-minute
 * tx count from DexScreener for a candidate list, via the batched
 * `/tokens/v1/{chainId}/{tokenAddresses}` endpoint (<=30 addresses/call,
 * billed as ONE request each — see DEXSCREENER_TOKENS_BATCH_URL comment).
 * Sequential batches, no concurrency wrapper needed (concurrency was only
 * ever there to avoid slamming the one-call-per-pool endpoint; the batch
 * endpoint removes the reason for it). Best-effort: a failed batch just
 * leaves that batch's pools' DexScreener fields undefined, which every
 * downstream filter already treats as "unknown, don't block".
 */
export async function hydrateTrendData(pairs: MeteoraPair[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += DEXSCREENER_BATCH_MAX_ADDRESSES) {
    const batch = pairs.slice(i, i + DEXSCREENER_BATCH_MAX_ADDRESSES);
    const addresses = batch.map((p) => nonSolToken(p)!.address).join(',');
    try {
      const res = await withRetry(
        () => axios.get<DexScreenerPair[]>(`${DEXSCREENER_TOKENS_BATCH_URL}/${SOLANA_CHAIN_ID}/${addresses}`, { timeout: 10_000 }),
        { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:tokens-batch' },
      );
      const byMint = new Map<string, DexScreenerPair>();
      for (const dexPair of res.data) {
        const base = dexPair.baseToken?.address;
        if (!base) continue;
        // A mint can trade on multiple DEXs (Raydium/PumpSwap/Orca/...) —
        // DexScreener returns all of them, not just our Meteora pool. The
        // old "first match wins per mint" behavior could hydrate our
        // Meteora pool's trend/momentum/crash-guard signals from a
        // completely different DEX's activity (confirmed live: a thin
        // Meteora pool getting momentum-mode entry signals off a much
        // busier Raydium pair for the same token). Only trust a
        // Meteora-specific pair — first Meteora match wins if there's more
        // than one Meteora pair for the same mint.
        if (dexPair.dexId !== 'meteora') continue;
        if (!byMint.has(base)) byMint.set(base, dexPair);
      }
      for (const pair of batch) {
        const dexPair = byMint.get(nonSolToken(pair)!.address);
        if (dexPair) applyDexScreenerFields(pair, dexPair);
      }
    } catch (err) {
      logger.debug('[scanner] dexscreener batch hydration failed', {
        addresses,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const pair of batch) pair.dexHydrationFailed = true;
    }
  }
}

/**
 * Hydrates `mintAuthorityRevoked` on the memecoin side via RugCheck's
 * report API (Meteora's own API doesn't expose mint-authority at all).
 * Only called on the short pre-filtered list — one HTTP call per pool,
 * not something to run against the full pool universe. Was a direct
 * Solana RPC call (rpc.ts's isMintAuthorityRevoked) until 2026-09-29 —
 * moved off Helius entirely after that RPC-per-pool pattern became the
 * dominant load causing sustained 429s once multiple paper-trade
 * instances ran in parallel; RugCheck's free single-token endpoint puts
 * this load on a separate rate-limit bucket instead.
 */
export async function hydrateMintAuthority(pairs: MeteoraPair[]): Promise<void> {
  await mapWithConcurrency(pairs, RPC_HYDRATION_CONCURRENCY, async (pair) => {
    const memecoin = nonSolToken(pair);
    if (!memecoin) return;
    memecoin.mintAuthorityRevoked = await isMintAuthorityRevokedViaRugCheck(memecoin.address);
  });
}

export interface FilterOpts {
  /**
   * Skip the checks that only make sense when SIZING new capital into a
   * pool (minVolTvlRatio, maxMemecoinMarketCapUsd,
   * maxPriceChange1hPumpPct, entryMinSpikeRatio, maxCapitalTvlRatioPct) — a
   * pool growing past these ceilings, pumping hard, having its spike cool
   * off, or our own capital becoming a bigger slice of its TVL (because it
   * grew, not because we deposited more) is a symptom of the position
   * SUCCEEDING or just maturing, not of it going bad — don't force an exit
   * on a held winner (trailing take-profit / the switch's trend-protect
   * guard already cover "is this still worth holding"). Used when
   * re-screening a pool we're already holding to decide "stay" vs "leave"
   * — genuine health/danger checks (min TVL floor, min volume, holders,
   * mint/freeze authority, crash-guard, trend floor, activity cascade, tx
   * count, wash-trade guard, buy-ratio) still apply either way. Never set
   * true for a fresh multi-candidate market scan — that's exactly where
   * these checks matter.
   */
  skipSizingChecks?: boolean;
  /**
   * SOL amount about to be deposited into a pool — required for the
   * maxCapitalTvlRatioPct check above. Undefined = that check is skipped
   * (permissive-unknown, same policy as the rest of the screen), so every
   * caller that wants slippage-safety protection must actually pass it.
   */
  currentCapitalSol?: number;
}

/**
 * Applies the full memecoin screen (TVL/volume/ratio/age/mcap/holders/
 * freeze+mint authority/crash-guard) to an already-fetched pair list and
 * returns the survivors ranked best-first. Split out from `scanPools` so
 * callers that already have a fresh pair list (e.g. the paper-trade loop
 * refreshing its held pool every tick) can re-filter without an extra
 * network round-trip.
 */
export async function filterAndRankPools(pairs: MeteoraPair[], config: ScannerConfig, opts: FilterOpts = {}): Promise<MeteoraPair[]> {
  const preFiltered = pairs.filter((pair) => {
    if (isBlacklisted(pair.address, config.blacklistPools)) return false;

    const tvl = Number(pair.liquidity);
    const vol24h = Number(pair.trade_volume_24h);
    if (!Number.isFinite(tvl) || !Number.isFinite(vol24h) || tvl <= 0) return false;

    if (tvl < config.minTvlUsd) return false;
    // Real slippage-safety gate (see maxCapitalTvlRatioPct doc comment) —
    // scales with our actual capital instead of a fixed dollar floor.
    if (!opts.skipSizingChecks && opts.currentCapitalSol !== undefined) {
      const sol = solToken(pair);
      if (sol) {
        const capitalUsd = opts.currentCapitalSol * sol.priceUsd;
        if ((capitalUsd / tvl) * 100 > config.maxCapitalTvlRatioPct) return false;
      }
    }
    if (vol24h < config.minVolume24hUsd) return false;
    if (!opts.skipSizingChecks && vol24h / tvl < config.minVolTvlRatio) return false;
    if (pair.bin_step < config.minBinStep) return false;

    const ageHours = (Date.now() - pair.createdAtMs) / 3_600_000;
    if (ageHours < config.minPoolAgeHours) return false;

    // Memecoin screen: require one side to be SOL, and the other side to
    // pass market-cap ceiling / holder floor / freeze-authority checks.
    const memecoin = nonSolToken(pair);
    if (!memecoin) return false;
    if (!opts.skipSizingChecks && memecoin.marketCapUsd > config.maxMemecoinMarketCapUsd) return false;
    if (memecoin.holders < config.minTokenHolders) return false;
    if (config.requireFreezeAuthorityDisabled && !memecoin.freezeAuthorityDisabled) return false;

    return true;
  });

  await Promise.all([hydrateTrendData(preFiltered), hydrateMintAuthority(preFiltered)]);

  const candidates = preFiltered.filter((pair) => {
    // A whole-batch DexScreener failure leaves every unknown-tolerant check
    // below permissive by default — fine for re-screening a pool we already
    // hold (a transient 429 shouldn't force-exit it), but a fresh entry
    // should never commit capital on data we know is missing, not just
    // absent. See dexHydrationFailed doc comment / STONK10 incident.
    if (!opts.skipSizingChecks && pair.dexHydrationFailed) return false;

    if (
      pair.priceChange1hPct !== undefined &&
      pair.priceChange1hPct < PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT
    ) {
      return false;
    }

    // Overextension ceiling — mirror of the crash guard above, but for the
    // other direction. The ranking below picks the biggest-already-moved
    // pool by design; without a ceiling that means chasing pools that just
    // went parabolic, which is exactly when a memecoin is most likely to
    // mean-revert hard. Confirmed live 2026-09-24: post-entry 20min windows
    // routinely show -8% to -28% troughs shortly after entry. Entry-only
    // (skipSizingChecks) — a HELD position pumping +50%+ in an hour is
    // exactly the outcome this bot wants, not a reason to force an exit.
    if (!opts.skipSizingChecks && pair.priceChange1hPct !== undefined && pair.priceChange1hPct > config.maxPriceChange1hPumpPct) {
      return false;
    }

    // 24h overextension ceiling — same reasoning as the 1h ceiling above,
    // but catches a pool whose blow-off already happened over the last day
    // and has since decelerated enough to slip under the 1h check. See
    // MAX_PRICE_CHANGE_24H_PUMP_PCT (env.ts) for the GO-SOL incident.
    if (!opts.skipSizingChecks && pair.priceChange24hPct !== undefined && pair.priceChange24hPct > config.maxPriceChange24hPumpPct) {
      return false;
    }

    // Uptrend filter: good volume alone put a pool like JEANPHIL-SOL at #1
    // even mid-downtrend. 6h is steadier than 1h for memecoin noise — same
    // "unknown, don't block" policy as the crash-guard above (a failed
    // DexScreener lookup shouldn't starve every candidate).
    if (config.requireUptrend && pair.priceChange6hPct !== undefined && pair.priceChange6hPct < config.minPriceChange6hPct) {
      return false;
    }

    // Activity cascade: a healthy-looking 24h number can hide a pool that's
    // basically dead RIGHT NOW (wash-traded/stale volume) — check that 1h
    // and 5m pace haven't collapsed relative to the 24h average pace.
    // 1h uses Meteora's own number (already fetched, no "unknown" case);
    // 5m only exists via DexScreener, so a failed lookup doesn't block.
    const vol24h = Number(pair.trade_volume_24h);
    const avgHourlyUsd = vol24h / 24;
    if (pair.volume1hUsd < avgHourlyUsd * config.minRecentActivityRatio) return false;

    const avg5MinUsd = vol24h / 288;
    if (pair.volumeM5Usd !== undefined && pair.volumeM5Usd < avg5MinUsd * config.minRecentActivityRatio) return false;

    // Absolute floor, not relative: a pool with a weak 24h average already
    // has a low bar for the ratio check above, so it can still pass with 0
    // trades in the last 5 minutes. This just asks "did anyone actually
    // trade in the last 5 minutes" directly.
    if (pair.txCountM5 !== undefined && pair.txCountM5 < config.minTxCountM5) return false;

    // Basic wash-trading tell: huge volume relative to TVL with price barely
    // moving is what a self-trading loop (buy/sell back and forth, same
    // wallet(s)) looks like — real directional buying pressure moves price.
    // Not a guarantee (organic high-ratio pools with flat price exist too),
    // just a red flag cheap to check with data already on hand. "unknown,
    // don't block" if 1h price data never hydrated.
    const volTvlRatioNow = Number(pair.trade_volume_24h) / Number(pair.liquidity);
    if (
      volTvlRatioNow > WASH_TRADE_VOL_TVL_RATIO_THRESHOLD &&
      pair.priceChange1hPct !== undefined &&
      Math.abs(pair.priceChange1hPct) < WASH_TRADE_FLAT_PRICE_BAND_PCT
    ) {
      return false;
    }

    if (config.requireMintAuthorityDisabled) {
      const memecoin = nonSolToken(pair);
      // fail-closed: unknown (RPC lookup failed) or still-active mint authority both block the pool
      if (!memecoin || memecoin.mintAuthorityRevoked !== true) return false;
    }

    // A pool's $ volume number doesn't say who's trading which direction —
    // require buys to actually dominate sells in the last hour before
    // trusting the activity as a real "pump forming" signal, not a dump
    // wearing the same $ number. Health check like the ones above, not a
    // sizing check — applies to a re-screen too (buys flipping to
    // sell-dominant while holding is itself a reason to reconsider, same
    // as the wash-trade/crash-guard checks). Unknown (no DexScreener h1 tx
    // data) doesn't block, same policy as the rest of this screen.
    if (pair.buyRatio1h !== undefined && pair.buyRatio1h <= config.entryMinBuyRatio1h) return false;

    // Absolute spike floor for FRESH entries only, 'momentum' mode only —
    // see ENTRY_MIN_SPIKE_RATIO doc comment. A held position's own spike
    // cooling off is not itself a reason to force an exit (trailing
    // take-profit / trend-protect already cover "is this position still
    // worth holding"), so this only applies when sizing NEW capital into a
    // pool.
    if (!opts.skipSizingChecks && config.entryStrategyMode === 'momentum' && volumeSpikeRatio(pair) < config.entryMinSpikeRatio) return false;

    // 'trend' mode's entry floor: skip acceleration entirely, require a
    // large SUSTAINED move instead (both 6h AND 24h) — see
    // ENTRY_STRATEGY_MODE (env.ts) for the SI-SOL incident that motivated
    // this. Fails closed on unknown data (undefined), unlike the rest of
    // this screen — verifying the sustained trend IS the point of this mode.
    if (!opts.skipSizingChecks && config.entryStrategyMode === 'trend') {
      if ((pair.priceChange6hPct ?? -Infinity) < config.trendMinSustainedPct) return false;
      if ((pair.priceChange24hPct ?? -Infinity) < config.trendMinSustainedPct) return false;
    }

    // 'range' mode's volatility ceiling — deliberately NOT gated by
    // skipSizingChecks (see rangeMaxVolatilityPct doc comment): a held
    // range-bound position that starts trending broke its own thesis, so
    // this stays live on re-screen too, unlike every other sizing check
    // here. Fails closed on unknown data, same reasoning as trend mode.
    if (config.entryStrategyMode === 'range') {
      if (Math.abs(pair.priceChange1hPct ?? Infinity) > config.rangeMaxVolatilityPct) return false;
      if (Math.abs(pair.priceChange6hPct ?? Infinity) > config.rangeMaxVolatilityPct) return false;
    }

    return true;
  });

  const shortlist =
    config.entryStrategyMode === 'trend'
      ? rankTrendCandidates(candidates)
      : config.entryStrategyMode === 'range'
        ? rankRangeCandidates(candidates)
        : rankCandidates(candidates);
  logger.info(`[scanner] ${candidates.length}/${pairs.length} pairs pass filters (${config.entryStrategyMode} mode), top ${shortlist.length} shortlisted`);
  return shortlist;
}

/**
 * 'trend' entryStrategyMode's ranking (see ENTRY_STRATEGY_MODE, env.ts) —
 * candidates already cleared the trendMinSustainedPct floor (genuine
 * sustained 6h+24h move), so the remaining question is which is most
 * "established" rather than which is accelerating fastest. TVL (liquidity)
 * descending is the direct proxy: deepest pool first — biggest, most mature,
 * least likely to be a thin/fragile mover. Deliberately a single sort key,
 * not a weighted composite — nothing yet justifies more than that.
 */
export function rankTrendCandidates(candidates: MeteoraPair[]): MeteoraPair[] {
  return [...candidates].sort((a, b) => Number(b.liquidity) - Number(a.liquidity));
}

/**
 * 'range' entryStrategyMode's ranking (see ENTRY_STRATEGY_MODE, env.ts) —
 * candidates already cleared the rangeMaxVolatilityPct ceiling (genuinely
 * calm, not trending), so the remaining question is which generates the
 * most fee yield relative to capital. vol/TVL ratio (turnover) descending
 * is the direct proxy — more $ traded per $ of liquidity means a bigger
 * pro-rata fee share for the same deposit, with the volatility ceiling
 * above already having screened out the IL risk that would normally come
 * with high turnover. Single sort key, same reasoning as rankTrendCandidates.
 */
export function rankRangeCandidates(candidates: MeteoraPair[]): MeteoraPair[] {
  return [...candidates].sort((a, b) => Number(b.trade_volume_24h) / Number(b.liquidity) - Number(a.trade_volume_24h) / Number(a.liquidity));
}

/**
 * Ranking rewritten 2026-09-24 to chase acceleration, not magnitude. The old
 * primary sort was raw priceChange6hPct descending — literally "pick
 * whoever already moved the most in 6h." For a mean-reverting memecoin that
 * selects for pools near/past their local top, not pools about to start
 * moving: confirmed live, post-entry 20min windows routinely showed -8% to
 * -28% troughs right after entry. requireUptrend (elsewhere) already gates
 * "must be positive over 6h" — that's enough of a qualifier; ranking on TOP
 * of that by raw magnitude just doubles down on lateness.
 *
 * Three stages:
 *  1. Shortlist by volumeSpikeRatio (this hour's pace vs. the preceding 5h's)
 *     — a RATE signal, not a cumulative one. A pool up only +5% over 6h but
 *     running 3x its own recent pace right now is plausibly earlier-stage
 *     than one up +40% over 6h whose pace has already cooled back toward 1x
 *     (i.e. already past its move).
 *  2. Tie-break by buyRatio1h descending — among similarly-accelerating
 *     candidates, prefer the one where buys actually dominate (genuine
 *     accumulation) over one where the $ volume could just as well be
 *     distribution. Missing data (`?? 0`) sorts last.
 *  3. Tie-break by priceChange24hPct ascending — among otherwise similar
 *     candidates, prefer the one whose 24h background is flatter (the move
 *     is new) over one that's already a known multi-hour/day runner (most
 *     of its gain happened before the last 6h). Missing data (`?? Infinity`)
 *     sorts last.
 *
 * Pure/exported (no I/O) so it's independently testable without network —
 * see src/scripts/checkRankCandidates.ts.
 */
export function rankCandidates(candidates: MeteoraPair[]): MeteoraPair[] {
  const shortlist = candidates
    .slice()
    .sort((a, b) => volumeSpikeRatio(b) - volumeSpikeRatio(a))
    .slice(0, TREND_SHORTLIST_SIZE);

  shortlist.sort((a, b) => {
    const buyDiff = (b.buyRatio1h ?? 0) - (a.buyRatio1h ?? 0);
    if (buyDiff !== 0) return buyDiff;
    return (a.priceChange24hPct ?? Infinity) - (b.priceChange24hPct ?? Infinity);
  });

  return shortlist;
}

export interface OpportunityScanResult {
  /** Top-ranked market candidate, if it's a genuinely different pool from the one currently held and one exists. Null if no candidate qualifies or the top candidate IS the currently-held pool. */
  candidate: MeteoraPair | null;
  candidateSpikeRatio: number;
  currentSpikeRatio: number;
  /** Candidate's 1h buy ratio (buys/(buys+sells)) — undefined if DexScreener never returned tx-side data. See MeteoraPair.buyRatio1h. */
  candidateBuyRatio1h: number | undefined;
  /** Currently-held pool's own 6h price trend — undefined if unhydrated. Used to protect a position that's still genuinely trending up even if its volume spike has cooled. */
  currentPriceTrendPct: number | undefined;
}

/**
 * Full-market scan used by the opportunistic pool-switching feature: finds
 * the best currently-available candidate and compares its volume-spike
 * ratio against the currently-held pool's own live spike ratio, hydrated
 * in the same pass for apples-to-apples freshness. Not subject to
 * MIN_SCAN_INTERVAL_MS (that throttle guards the hot per-tick health-check
 * path; this runs on its own much slower OPPORTUNITY_SCAN_INTERVAL_MS
 * cadence, enforced by the caller in index.ts/paperTrade.ts, not here).
 */
export async function scanForBetterOpportunity(currentPoolAddress: string, config: ScannerConfig, currentCapitalSol?: number): Promise<OpportunityScanResult> {
  const pairs = await fetchTopPools();
  const currentPool = pairs.find((p) => p.address === currentPoolAddress) ?? null;
  const shortlist = await filterAndRankPools(pairs, config, { currentCapitalSol });
  const topCandidate = shortlist[0] ?? null;

  // filterAndRankPools already hydrated every pool in `shortlist` in place
  // (same object references as in `pairs`). The currently-held pool might
  // not be in that shortlist (e.g. it's not top-3-by-trend right now, or
  // it's temporarily blacklisted) — hydrate it separately if so, still just
  // one extra batched HTTP call, not one-per-pool.
  if (currentPool && currentPool.volumeH6Usd === undefined) {
    await hydrateTrendData([currentPool]);
  }

  const currentSpikeRatio = currentPool ? volumeSpikeRatio(currentPool) : 0;
  const candidateSpikeRatio = topCandidate ? volumeSpikeRatio(topCandidate) : 0;
  const currentPriceTrendPct = currentPool?.priceChange6hPct;

  if (!topCandidate || topCandidate.address === currentPoolAddress) {
    return { candidate: null, candidateSpikeRatio: 0, currentSpikeRatio, candidateBuyRatio1h: undefined, currentPriceTrendPct };
  }
  return { candidate: topCandidate, candidateSpikeRatio, currentSpikeRatio, candidateBuyRatio1h: topCandidate.buyRatio1h, currentPriceTrendPct };
}

export interface PoolEligibility {
  eligible: boolean;
  /** Human-readable reasons the pool failed the screen — empty when eligible. */
  reasons: string[];
}

/**
 * Diagnostic-only: recomputes which specific filterAndRankPools check(s) a
 * pool fails, for logging when a re-screen says "no" and it's not obvious
 * why. Deliberately duplicates filterAndRankPools' checks instead of
 * threading a reasons-array through it — this only runs for one
 * already-held pool on a rebalance, not the hot multi-pool scan path, so a
 * small duplicated checklist here is cheaper than restructuring the hot
 * path's filter for a rarely-needed explanation.
 * Assumes `pair` has already been through filterAndRankPools (or at least
 * hydrateTrendData/hydrateMintAuthority) so priceChange1hPct, priceChange6hPct,
 * volumeM5Usd, mintAuthorityRevoked are populated where available; fields left
 * `undefined` (hydration never ran, e.g. pair failed the pre-hydration
 * checks first) are silently skipped, not reported as failures.
 */
export function poolRejectReasons(pair: MeteoraPair, config: ScannerConfig, opts: FilterOpts = {}): string[] {
  const reasons: string[] = [];
  if (isBlacklisted(pair.address, config.blacklistPools)) reasons.push('blacklisted');
  if (!opts.skipSizingChecks && pair.dexHydrationFailed) reasons.push('dexscreener batch hydration failed (unknown trend/tx data)');

  const tvl = Number(pair.liquidity);
  const vol24h = Number(pair.trade_volume_24h);
  if (!Number.isFinite(tvl) || !Number.isFinite(vol24h) || tvl <= 0) {
    reasons.push('invalid tvl/volume data');
  } else {
    if (tvl < config.minTvlUsd) reasons.push(`tvl $${tvl.toFixed(0)} < min $${config.minTvlUsd}`);
    if (!opts.skipSizingChecks && opts.currentCapitalSol !== undefined) {
      const sol = solToken(pair);
      if (sol) {
        const ratioPct = ((opts.currentCapitalSol * sol.priceUsd) / tvl) * 100;
        if (ratioPct > config.maxCapitalTvlRatioPct) {
          reasons.push(`capital/tvl ratio ${ratioPct.toFixed(2)}% > max ${config.maxCapitalTvlRatioPct}%`);
        }
      }
    }
    if (vol24h < config.minVolume24hUsd) reasons.push(`vol24h $${vol24h.toFixed(0)} < min $${config.minVolume24hUsd}`);
    if (!opts.skipSizingChecks && vol24h / tvl < config.minVolTvlRatio) reasons.push(`vol/tvl ${(vol24h / tvl).toFixed(2)}x < min ${config.minVolTvlRatio}x`);
  }
  if (pair.bin_step < config.minBinStep) reasons.push(`bin_step ${pair.bin_step} < min ${config.minBinStep}`);
  const ageHours = (Date.now() - pair.createdAtMs) / 3_600_000;
  if (ageHours < config.minPoolAgeHours) reasons.push(`pool age ${ageHours.toFixed(1)}h < min ${config.minPoolAgeHours}h`);

  const memecoin = nonSolToken(pair);
  if (!memecoin) {
    reasons.push('no non-SOL side found');
  } else {
    if (!opts.skipSizingChecks && memecoin.marketCapUsd > config.maxMemecoinMarketCapUsd) reasons.push(`market cap $${memecoin.marketCapUsd.toFixed(0)} > max $${config.maxMemecoinMarketCapUsd}`);
    if (memecoin.holders < config.minTokenHolders) reasons.push(`holders ${memecoin.holders} < min ${config.minTokenHolders}`);
    if (config.requireFreezeAuthorityDisabled && !memecoin.freezeAuthorityDisabled) reasons.push('freeze authority not disabled');
    if (config.requireMintAuthorityDisabled && memecoin.mintAuthorityRevoked !== true) reasons.push('mint authority not confirmed revoked');
  }

  if (pair.priceChange1hPct !== undefined && pair.priceChange1hPct < PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT) {
    reasons.push(`1h crash guard ${pair.priceChange1hPct.toFixed(2)}% < ${PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT}%`);
  }
  if (!opts.skipSizingChecks && pair.priceChange1hPct !== undefined && pair.priceChange1hPct > config.maxPriceChange1hPumpPct) {
    reasons.push(`1h overextension ${pair.priceChange1hPct.toFixed(2)}% > max ${config.maxPriceChange1hPumpPct}%`);
  }
  if (!opts.skipSizingChecks && pair.priceChange24hPct !== undefined && pair.priceChange24hPct > config.maxPriceChange24hPumpPct) {
    reasons.push(`24h overextension ${pair.priceChange24hPct.toFixed(2)}% > max ${config.maxPriceChange24hPumpPct}%`);
  }
  if (config.requireUptrend && pair.priceChange6hPct !== undefined && pair.priceChange6hPct < config.minPriceChange6hPct) {
    reasons.push(`6h trend ${pair.priceChange6hPct.toFixed(2)}% < min ${config.minPriceChange6hPct}%`);
  }
  const avgHourlyUsd = vol24h / 24;
  if (pair.volume1hUsd < avgHourlyUsd * config.minRecentActivityRatio) {
    reasons.push(`1h activity $${pair.volume1hUsd.toFixed(0)} < ${(config.minRecentActivityRatio * 100).toFixed(0)}% of its own 24h pace ($${avgHourlyUsd.toFixed(0)})`);
  }
  const avg5MinUsd = vol24h / 288;
  if (pair.volumeM5Usd !== undefined && pair.volumeM5Usd < avg5MinUsd * config.minRecentActivityRatio) {
    reasons.push(`5m activity $${pair.volumeM5Usd.toFixed(0)} < ${(config.minRecentActivityRatio * 100).toFixed(0)}% of its own 24h pace ($${avg5MinUsd.toFixed(0)})`);
  }
  if (pair.txCountM5 !== undefined && pair.txCountM5 < config.minTxCountM5) {
    reasons.push(`5m tx count ${pair.txCountM5} < min ${config.minTxCountM5}`);
  }
  const volTvlRatioNow = tvl > 0 ? vol24h / tvl : 0;
  if (
    volTvlRatioNow > WASH_TRADE_VOL_TVL_RATIO_THRESHOLD &&
    pair.priceChange1hPct !== undefined &&
    Math.abs(pair.priceChange1hPct) < WASH_TRADE_FLAT_PRICE_BAND_PCT
  ) {
    reasons.push(`possible wash trading: vol/tvl ${volTvlRatioNow.toFixed(1)}x with flat 1h price ${pair.priceChange1hPct.toFixed(2)}%`);
  }
  if (pair.buyRatio1h !== undefined && pair.buyRatio1h <= config.entryMinBuyRatio1h) {
    reasons.push(`1h buy ratio ${(pair.buyRatio1h * 100).toFixed(0)}% <= ${config.entryMinBuyRatio1h * 100}% - sell-dominant, not a genuine pump signal`);
  }
  if (!opts.skipSizingChecks && config.entryStrategyMode === 'momentum' && volumeSpikeRatio(pair) < config.entryMinSpikeRatio) {
    reasons.push(`volume spike ${volumeSpikeRatio(pair).toFixed(2)}x < entry floor ${config.entryMinSpikeRatio}x - not actually accelerating`);
  }
  if (!opts.skipSizingChecks && config.entryStrategyMode === 'trend') {
    if ((pair.priceChange6hPct ?? -Infinity) < config.trendMinSustainedPct) {
      reasons.push(`6h change ${pair.priceChange6hPct?.toFixed(2) ?? 'unknown'}% < trend floor ${config.trendMinSustainedPct}%`);
    }
    if ((pair.priceChange24hPct ?? -Infinity) < config.trendMinSustainedPct) {
      reasons.push(`24h change ${pair.priceChange24hPct?.toFixed(2) ?? 'unknown'}% < trend floor ${config.trendMinSustainedPct}%`);
    }
  }
  if (config.entryStrategyMode === 'range') {
    if (Math.abs(pair.priceChange1hPct ?? Infinity) > config.rangeMaxVolatilityPct) {
      reasons.push(`1h |change| ${pair.priceChange1hPct?.toFixed(2) ?? 'unknown'}% > range ceiling ${config.rangeMaxVolatilityPct}% - no longer range-bound`);
    }
    if (Math.abs(pair.priceChange6hPct ?? Infinity) > config.rangeMaxVolatilityPct) {
      reasons.push(`6h |change| ${pair.priceChange6hPct?.toFixed(2) ?? 'unknown'}% > range ceiling ${config.rangeMaxVolatilityPct}% - no longer range-bound`);
    }
  }

  return reasons;
}

/**
 * Re-checks a single already-held pool against the entry screen — used
 * when an idle/out-of-range position needs to decide "stay in this pool
 * (still qualifies) or leave and find a different one (no longer does)".
 * Always skips the capital-sizing checks (minVolTvlRatio/
 * maxMemecoinMarketCapUsd, see FilterOpts) — this is a "should I keep
 * holding" decision, not a "should new capital go here" decision, so a
 * pool that simply grew past those ceilings (i.e. succeeded) shouldn't
 * get force-exited for it. Not subject to MIN_SCAN_INTERVAL_MS (that
 * throttle guards the expensive full-market scan; this is one pool,
 * called only when a rebalance is already happening, not on every tick).
 */
export async function isPoolStillEligible(poolAddress: string, config: ScannerConfig): Promise<PoolEligibility> {
  const pairs = await fetchTopPools();
  const pool = pairs.find((p) => p.address === poolAddress);
  if (!pool) return { eligible: false, reasons: ['pool fell out of the top-200-by-volume window'] };
  const opts: FilterOpts = { skipSizingChecks: true };
  const passed = await filterAndRankPools([pool], config, opts);
  const eligible = passed.length > 0;
  return { eligible, reasons: eligible ? [] : poolRejectReasons(pool, config, opts) };
}

/**
 * Scans + filters candidate pools. Enforces a hard floor on poll frequency
 * (>= MIN_SCAN_INTERVAL_MS) regardless of caller cadence, so a misconfigured
 * caller can't hammer the API.
 */
export async function scanPools(config: ScannerConfig, currentCapitalSol?: number): Promise<MeteoraPair[]> {
  const now = Date.now();
  if (now - lastScanAt < MIN_SCAN_INTERVAL_MS) {
    logger.debug('[scanner] skip: polled too recently');
    return [];
  }
  lastScanAt = now;

  const pairs = await fetchTopPools();
  return filterAndRankPools(pairs, config, { currentCapitalSol });
}

export function defaultScannerConfig(blacklistPools: Map<string, number>): ScannerConfig {
  return {
    minTvlUsd: env.MIN_TVL_USD,
    minVolume24hUsd: env.MIN_24H_VOLUME_USD,
    minVolTvlRatio: env.MIN_VOL_TVL_RATIO,
    maxMemecoinMarketCapUsd: env.MAX_MEMECOIN_MARKET_CAP_USD,
    minTokenHolders: env.MIN_TOKEN_HOLDERS,
    requireFreezeAuthorityDisabled: env.REQUIRE_FREEZE_AUTHORITY_DISABLED,
    requireMintAuthorityDisabled: env.REQUIRE_MINT_AUTHORITY_DISABLED,
    minBinStep: env.MIN_BIN_STEP,
    minPoolAgeHours: env.MIN_POOL_AGE_HOURS,
    requireUptrend: env.REQUIRE_UPTREND,
    minPriceChange6hPct: env.MIN_PRICE_CHANGE_6H_PCT,
    minRecentActivityRatio: env.MIN_RECENT_ACTIVITY_RATIO,
    minTxCountM5: env.MIN_TX_COUNT_M5,
    maxPriceChange1hPumpPct: env.MAX_PRICE_CHANGE_1H_PUMP_PCT,
    maxPriceChange24hPumpPct: env.MAX_PRICE_CHANGE_24H_PUMP_PCT,
    entryMinBuyRatio1h: env.ENTRY_MIN_BUY_RATIO_1H,
    entryMinSpikeRatio: env.ENTRY_MIN_SPIKE_RATIO,
    entryStrategyMode: env.ENTRY_STRATEGY_MODE,
    trendMinSustainedPct: env.TREND_MIN_SUSTAINED_PCT,
    rangeMaxVolatilityPct: env.RANGE_MAX_VOLATILITY_PCT,
    maxCapitalTvlRatioPct: env.MAX_CAPITAL_TVL_RATIO_PCT,
    blacklistPools,
  };
}
