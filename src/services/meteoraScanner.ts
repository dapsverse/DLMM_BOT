import axios from 'axios';
import { env } from '../config/env.js';
import {
  METEORA_POOLS_URL,
  METEORA_POOLS_PAGE_SIZE,
  DEXSCREENER_TOKEN_URL,
  WSOL_MINT,
  MIN_SCAN_INTERVAL_MS,
  PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT,
  HTTP_MAX_RETRIES,
  HTTP_RETRY_BASE_DELAY_MS,
} from '../config/constants.js';
import { isRateLimitError, withRetry, mapWithConcurrency } from '../utils/retry.js';
import { isMintAuthorityRevoked } from './rpc.js';
import { logger } from '../utils/logger.js';

// ponytail: flat concurrency caps, not a real rate limiter — good enough to
// keep public/free-tier APIs from 429-storming on every scan; tune down if
// running against a free-tier RPC, up if on a paid one.
const DEXSCREENER_CONCURRENCY = 5;
const RPC_HYDRATION_CONCURRENCY = 4;

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
  maxTvlUsd: number;
  minVolume24hUsd: number;
  minVolTvlRatio: number;
  maxMemecoinMarketCapUsd: number;
  minTokenHolders: number;
  requireFreezeAuthorityDisabled: boolean;
  requireMintAuthorityDisabled: boolean;
  minBinStep: number;
  minPoolAgeHours: number;
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
  priceChange?: { h1?: number };
  volume?: { h1?: number };
}

/** Trailing 1h USD volume for a token, used by riskManager's volume-drop hard-exit check. */
export async function getVolume1hUsd(mint: string): Promise<number | null> {
  try {
    const res = await withRetry(
      () => axios.get<{ pairs?: DexScreenerPair[] }>(`${DEXSCREENER_TOKEN_URL}/${mint}`, { timeout: 10_000 }),
      { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:volume1h' },
    );
    const h1 = res.data.pairs?.[0]?.volume?.h1;
    return typeof h1 === 'number' ? h1 : null;
  } catch (err) {
    logger.debug(`[scanner] dexscreener volume1h lookup failed for ${mint}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Hydrates `priceChange1hPct` from DexScreener for a short candidate list
 * (post TVL/volume filter, not the whole pair list — keeps calls bounded).
 * Best-effort: a failed lookup just leaves the field undefined, which the
 * crash-guard filter treats as "unknown, don't block".
 */
async function hydratePriceChange1h(pairs: MeteoraPair[]): Promise<void> {
  await mapWithConcurrency(pairs, DEXSCREENER_CONCURRENCY, async (pair) => {
    try {
      const res = await withRetry(
        () => axios.get<{ pairs?: DexScreenerPair[] }>(`${DEXSCREENER_TOKEN_URL}/${pair.mint_x}`, { timeout: 10_000 }),
        { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:token' },
      );
      const h1 = res.data.pairs?.[0]?.priceChange?.h1;
      if (typeof h1 === 'number') pair.priceChange1hPct = h1;
    } catch (err) {
      logger.debug(`[scanner] dexscreener hydration failed for ${pair.address}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Hydrates `mintAuthorityRevoked` on the memecoin side via a direct RPC
 * mint-account read (Meteora's API doesn't expose mint-authority at all).
 * Only called on the short pre-filtered list — this is an RPC round-trip
 * per pool, not something to run against the full pool universe.
 */
async function hydrateMintAuthority(pairs: MeteoraPair[]): Promise<void> {
  await mapWithConcurrency(pairs, RPC_HYDRATION_CONCURRENCY, async (pair) => {
    const memecoin = nonSolToken(pair);
    if (!memecoin) return;
    memecoin.mintAuthorityRevoked = await isMintAuthorityRevoked(memecoin.address);
  });
}

/**
 * Applies the full memecoin screen (TVL/volume/ratio/age/mcap/holders/
 * freeze+mint authority/crash-guard) to an already-fetched pair list and
 * returns the survivors ranked best-first. Split out from `scanPools` so
 * callers that already have a fresh pair list (e.g. the paper-trade loop
 * refreshing its held pool every tick) can re-filter without an extra
 * network round-trip.
 */
export async function filterAndRankPools(pairs: MeteoraPair[], config: ScannerConfig): Promise<MeteoraPair[]> {
  const preFiltered = pairs.filter((pair) => {
    if (isBlacklisted(pair.address, config.blacklistPools)) return false;

    const tvl = Number(pair.liquidity);
    const vol24h = Number(pair.trade_volume_24h);
    if (!Number.isFinite(tvl) || !Number.isFinite(vol24h) || tvl <= 0) return false;

    if (tvl < config.minTvlUsd) return false;
    if (tvl > config.maxTvlUsd) return false;
    if (vol24h < config.minVolume24hUsd) return false;
    if (vol24h / tvl < config.minVolTvlRatio) return false;
    if (pair.bin_step < config.minBinStep) return false;

    const ageHours = (Date.now() - pair.createdAtMs) / 3_600_000;
    if (ageHours < config.minPoolAgeHours) return false;

    // Memecoin screen: require one side to be SOL, and the other side to
    // pass market-cap ceiling / holder floor / freeze-authority checks.
    const memecoin = nonSolToken(pair);
    if (!memecoin) return false;
    if (memecoin.marketCapUsd > config.maxMemecoinMarketCapUsd) return false;
    if (memecoin.holders < config.minTokenHolders) return false;
    if (config.requireFreezeAuthorityDisabled && !memecoin.freezeAuthorityDisabled) return false;

    return true;
  });

  await Promise.all([hydratePriceChange1h(preFiltered), hydrateMintAuthority(preFiltered)]);

  const candidates = preFiltered.filter((pair) => {
    if (
      pair.priceChange1hPct !== undefined &&
      pair.priceChange1hPct < PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT
    ) {
      return false;
    }

    if (config.requireMintAuthorityDisabled) {
      const memecoin = nonSolToken(pair);
      // fail-closed: unknown (RPC lookup failed) or still-active mint authority both block the pool
      if (!memecoin || memecoin.mintAuthorityRevoked !== true) return false;
    }
    return true;
  });

  // Best pool first: rank by vol/TVL ratio (capital efficiency proxy).
  candidates.sort((a, b) => Number(b.trade_volume_24h) / Number(b.liquidity) - Number(a.trade_volume_24h) / Number(a.liquidity));

  logger.info(`[scanner] ${candidates.length}/${pairs.length} pairs pass filters`);
  return candidates;
}

/**
 * Scans + filters candidate pools. Enforces a hard floor on poll frequency
 * (>= MIN_SCAN_INTERVAL_MS) regardless of caller cadence, so a misconfigured
 * caller can't hammer the API.
 */
export async function scanPools(config: ScannerConfig): Promise<MeteoraPair[]> {
  const now = Date.now();
  if (now - lastScanAt < MIN_SCAN_INTERVAL_MS) {
    logger.debug('[scanner] skip: polled too recently');
    return [];
  }
  lastScanAt = now;

  const pairs = await fetchTopPools();
  return filterAndRankPools(pairs, config);
}

export function defaultScannerConfig(blacklistPools: Map<string, number>): ScannerConfig {
  return {
    minTvlUsd: env.MIN_TVL_USD,
    maxTvlUsd: env.MAX_TVL_USD,
    minVolume24hUsd: env.MIN_24H_VOLUME_USD,
    minVolTvlRatio: env.MIN_VOL_TVL_RATIO,
    maxMemecoinMarketCapUsd: env.MAX_MEMECOIN_MARKET_CAP_USD,
    minTokenHolders: env.MIN_TOKEN_HOLDERS,
    requireFreezeAuthorityDisabled: env.REQUIRE_FREEZE_AUTHORITY_DISABLED,
    requireMintAuthorityDisabled: env.REQUIRE_MINT_AUTHORITY_DISABLED,
    minBinStep: env.MIN_BIN_STEP,
    minPoolAgeHours: env.MIN_POOL_AGE_HOURS,
    blacklistPools,
  };
}
