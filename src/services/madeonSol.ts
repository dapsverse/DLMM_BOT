import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const r = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

/** Pure: compact the MadeOnSol /token/{mint} snapshot (deployer record, early-buyer exit, KOL flow, twitter reuse, blacklist). null when the response has no token. */
export function summarizeToken(raw: unknown): Record<string, unknown> | null {
  const t = r(r(raw).token);
  if (!t.mint) return null;
  const kol = r(t.kol_activity);
  const ebe = r(t.early_buyer_exit);
  const tw = r(t.twitter_reuse);
  return {
    deployer: pick(r(t.deployer), ['wallet', 'tier', 'total_deployed', 'total_bonded', 'bonding_rate', 'recent_bond_rate', 'history_status', 'resolved_outcome_count']),
    earlyBuyers: pick(ebe, ['cohort', 'still_holding', 'sold', 'still_holding_pct']),
    launchCohortSol: t.launch_cohort_sol ?? null,
    kols: pick(kol, ['unique_kols', 'buying_kols', 'selling_kols', 'buy_sol', 'sell_sol', 'net_flow_sol', 'signal', 'window_hours']),
    topKolBuyers: (Array.isArray(kol.top_buyers) ? kol.top_buyers : []).slice(0, 3).map((b) => `${r(b).name}:${Math.round(Number(r(b).sol_amount) || 0)}SOL`),
    twitterReuse: pick(tw, ['handle', 'mints_same_handle', 'mints_same_url']),
    blacklisted: t.is_blacklisted === true ? (t.blacklist_category ?? true) : false,
    mevVolumePct1h: r(t.mev_volume_pct)['1h'] ?? null,
    ageHours: typeof t.age_seconds === 'number' ? Math.round(t.age_seconds / 360) / 10 : null,
  };
}

type Fetcher = (mint: string) => Promise<unknown>;
let blockedUntil = 0;
const cache = new Map<string, { at: number; v: Record<string, unknown> | null }>();
const CACHE_MS = 30 * 60_000;
const DAILY_BUDGET = 150; // free tier is 200/day and 10/min: keep headroom
let spent = { day: '', n: 0 };

async function httpFetch(mint: string): Promise<unknown> {
  const res = await fetch(`https://madeonsol.com/api/v1/token/${encodeURIComponent(mint)}`, {
    headers: { Authorization: `Bearer ${env.MADEONSOL_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw Object.assign(new Error(`madeonsol ${res.status}`), { status: res.status });
  return res.json();
}

/** Deployer history + early-buyer exit + KOL flow for a token. null on no key, over budget, any error (never throws). */
export async function fetchTokenIntel(mint: string, fetcher: Fetcher = httpFetch, nowMs = Date.now(), hasKey = !!env.MADEONSOL_API_KEY): Promise<Record<string, unknown> | null> {
  if (!hasKey || nowMs < blockedUntil) return null;
  const hit = cache.get(mint);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.v;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (spent.day !== day) spent = { day, n: 0 };
  if (spent.n >= DAILY_BUDGET) return null;
  spent.n++;
  try {
    const v = summarizeToken(await fetcher(mint));
    cache.set(mint, { at: nowMs, v });
    return v;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 429 || status === 401 || status === 403 || (status ?? 0) >= 500) blockedUntil = nowMs + 10 * 60_000;
    logger.warn('[madeonSol] failed', { error: e instanceof Error ? e.message : String(e), status });
    return null;
  }
}
