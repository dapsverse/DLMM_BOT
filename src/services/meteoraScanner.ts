import axios from 'axios';
import { env } from '../config/env.js';
import {
  METEORA_POOLS_URL,
  METEORA_POOLS_PAGE_SIZE,
  DEXSCREENER_TOKEN_URL,
  WSOL_MINT,
  MIN_SCAN_INTERVAL_MS,
  PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT,
  TREND_SHORTLIST_SIZE,
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

// ponytail: first-cut wash-trading heuristic, hardcoded not env-configurable
// — no calibration data yet to justify exposing knobs. Revisit if false
// positives/negatives show up in practice.
const WASH_TRADE_VOL_TVL_RATIO_THRESHOLD = 30;
const WASH_TRADE_FLAT_PRICE_BAND_PCT = 2;

/**
 * This hour's volume vs. the preceding 5h's average pace (via DexScreener's
 * 6h volume figure) — a ratio well above 1 means volume just surged above
 * its own recent baseline, not just "the pool has been busy over the last
 * 24h" (which a static vol/TVL ratio can't distinguish from stale/decaying
 * activity). Returns 0 (never wins a tie-break) when 6h data never
 * hydrated; caps at a large-but-finite number instead of Infinity when the
 * prior baseline is ~0 so sorting stays well-defined.
 */
function volumeSpikeRatio(p: MeteoraPair): number {
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
  requireUptrend: boolean;
  minPriceChange6hPct: number;
  minRecentActivityRatio: number;
  /** Absolute floor on 5-minute buy+sell count — a relative-to-24h-average ratio can still pass with 0 real trades if the pool's own baseline is already weak; this is a hard, non-relative "is anyone actually trading right now" check. */
  minTxCountM5: number;
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
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
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
 * Hydrates price-change fields (1h/6h/24h) and 5-minute volume from
 * DexScreener for a short candidate list (post TVL/volume filter, not the
 * whole pair list — keeps calls bounded). Everything comes back in one
 * response, no extra request cost. Best-effort: a failed lookup just
 * leaves the fields undefined, which the crash-guard/uptrend/activity
 * filters all treat as "unknown, don't block".
 */
async function hydrateTrendData(pairs: MeteoraPair[]): Promise<void> {
  await mapWithConcurrency(pairs, DEXSCREENER_CONCURRENCY, async (pair) => {
    try {
      const res = await withRetry(
        () => axios.get<{ pairs?: DexScreenerPair[] }>(`${DEXSCREENER_TOKEN_URL}/${pair.mint_x}`, { timeout: 10_000 }),
        { maxRetries: 2, baseDelayMs: HTTP_RETRY_BASE_DELAY_MS, isRetryable: isRateLimitError, label: 'dexscreener:token' },
      );
      const dexPair = res.data.pairs?.[0];
      const priceChange = dexPair?.priceChange;
      if (typeof priceChange?.h1 === 'number') pair.priceChange1hPct = priceChange.h1;
      if (typeof priceChange?.h6 === 'number') pair.priceChange6hPct = priceChange.h6;
      if (typeof priceChange?.h24 === 'number') pair.priceChange24hPct = priceChange.h24;
      if (typeof dexPair?.volume?.m5 === 'number') pair.volumeM5Usd = dexPair.volume.m5;
      if (typeof dexPair?.volume?.h6 === 'number') pair.volumeH6Usd = dexPair.volume.h6;
      const m5Txns = dexPair?.txns?.m5;
      if (typeof m5Txns?.buys === 'number' && typeof m5Txns?.sells === 'number') pair.txCountM5 = m5Txns.buys + m5Txns.sells;
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

  await Promise.all([hydrateTrendData(preFiltered), hydrateMintAuthority(preFiltered)]);

  const candidates = preFiltered.filter((pair) => {
    if (
      pair.priceChange1hPct !== undefined &&
      pair.priceChange1hPct < PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT
    ) {
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
    return true;
  });

  // Two-stage pick, not a single blended score: a composite score let raw
  // vol/TVL ratio dominate (e.g. a 27x-ratio pool with flat/negative 6h
  // still won over a genuinely-trending one) — trend was only ever a small
  // multiplier, never the deciding factor. Instead: shortlist the
  // strongest 6h trends first, THEN pick within just those. Trend gates
  // which pools are even in contention; the tie-break only ranks within
  // that trend-qualified set.
  // Missing 6h data (`?? -Infinity`) sorts to the bottom of the trend
  // shortlist — never lets an unconfirmed trend take a slot from a
  // confirmed one, though it can still surface if too few candidates exist.
  //
  // Tie-break is volume-SPIKE ratio (this hour's pace vs. the preceding 5h's
  // pace, via DexScreener's 6h volume), not static vol/TVL ratio. A high
  // vol/TVL ratio can just mean a pool that's always been busy — it doesn't
  // tell you interest is fresh RIGHT NOW. A spike (current hour running well
  // above its own recent baseline) does, and combined with the trend gate
  // above ("uptrend + volume spike") is a real breakout-confirmation
  // pattern, not just "was active at some point in the last 24h."
  const trendShortlist = candidates
    .slice()
    .sort((a, b) => (b.priceChange6hPct ?? -Infinity) - (a.priceChange6hPct ?? -Infinity))
    .slice(0, TREND_SHORTLIST_SIZE);

  trendShortlist.sort((a, b) => volumeSpikeRatio(b) - volumeSpikeRatio(a));

  logger.info(`[scanner] ${candidates.length}/${pairs.length} pairs pass filters, top ${trendShortlist.length} shortlisted by trend then volume spike`);
  return trendShortlist;
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
export function poolRejectReasons(pair: MeteoraPair, config: ScannerConfig): string[] {
  const reasons: string[] = [];
  if (isBlacklisted(pair.address, config.blacklistPools)) reasons.push('blacklisted');

  const tvl = Number(pair.liquidity);
  const vol24h = Number(pair.trade_volume_24h);
  if (!Number.isFinite(tvl) || !Number.isFinite(vol24h) || tvl <= 0) {
    reasons.push('invalid tvl/volume data');
  } else {
    if (tvl < config.minTvlUsd) reasons.push(`tvl $${tvl.toFixed(0)} < min $${config.minTvlUsd}`);
    if (tvl > config.maxTvlUsd) reasons.push(`tvl $${tvl.toFixed(0)} > max $${config.maxTvlUsd}`);
    if (vol24h < config.minVolume24hUsd) reasons.push(`vol24h $${vol24h.toFixed(0)} < min $${config.minVolume24hUsd}`);
    if (vol24h / tvl < config.minVolTvlRatio) reasons.push(`vol/tvl ${(vol24h / tvl).toFixed(2)}x < min ${config.minVolTvlRatio}x`);
  }
  if (pair.bin_step < config.minBinStep) reasons.push(`bin_step ${pair.bin_step} < min ${config.minBinStep}`);
  const ageHours = (Date.now() - pair.createdAtMs) / 3_600_000;
  if (ageHours < config.minPoolAgeHours) reasons.push(`pool age ${ageHours.toFixed(1)}h < min ${config.minPoolAgeHours}h`);

  const memecoin = nonSolToken(pair);
  if (!memecoin) {
    reasons.push('no non-SOL side found');
  } else {
    if (memecoin.marketCapUsd > config.maxMemecoinMarketCapUsd) reasons.push(`market cap $${memecoin.marketCapUsd.toFixed(0)} > max $${config.maxMemecoinMarketCapUsd}`);
    if (memecoin.holders < config.minTokenHolders) reasons.push(`holders ${memecoin.holders} < min ${config.minTokenHolders}`);
    if (config.requireFreezeAuthorityDisabled && !memecoin.freezeAuthorityDisabled) reasons.push('freeze authority not disabled');
    if (config.requireMintAuthorityDisabled && memecoin.mintAuthorityRevoked !== true) reasons.push('mint authority not confirmed revoked');
  }

  if (pair.priceChange1hPct !== undefined && pair.priceChange1hPct < PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT) {
    reasons.push(`1h crash guard ${pair.priceChange1hPct.toFixed(2)}% < ${PRICE_CHANGE_1H_CRASH_THRESHOLD_PCT}%`);
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

  return reasons;
}

/**
 * Re-checks a single already-held pool against the full entry screen —
 * used when an idle/out-of-range position needs to decide "stay in this
 * pool (still qualifies) or leave and find a different one (no longer
 * does)". Not subject to MIN_SCAN_INTERVAL_MS (that throttle guards the
 * expensive full-market scan; this is one pool, called only when a
 * rebalance is already happening, not on every tick).
 */
export async function isPoolStillEligible(poolAddress: string, config: ScannerConfig): Promise<PoolEligibility> {
  const pairs = await fetchTopPools();
  const pool = pairs.find((p) => p.address === poolAddress);
  if (!pool) return { eligible: false, reasons: ['pool fell out of the top-200-by-volume window'] };
  const passed = await filterAndRankPools([pool], config);
  const eligible = passed.length > 0;
  return { eligible, reasons: eligible ? [] : poolRejectReasons(pool, config) };
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
    requireUptrend: env.REQUIRE_UPTREND,
    minPriceChange6hPct: env.MIN_PRICE_CHANGE_6H_PCT,
    minRecentActivityRatio: env.MIN_RECENT_ACTIVITY_RATIO,
    minTxCountM5: env.MIN_TX_COUNT_M5,
    blacklistPools,
  };
}
