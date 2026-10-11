import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persisted live-bot state (2026-10-11): everything the live loop keeps only in memory
 * (currentPool's PoolContext minus the SDK pool handle, blacklist/chase guard, capital, timers) so a
 * restart can reattach to an OPEN position instead of orphaning it. On boot the on-chain position set
 * is always the source of truth (see reconcileBoot); this file only supplies the bookkeeping the chain
 * cannot (deposit basis for stop-loss/take-profit, peak profit, rebalance history, blacklist).
 */
export const STATE_VERSION = 1;
export const DEFAULT_STATE_FILE = 'state/live-state.json';
/** Timers older than this are not trusted after a restart (would fire an idle-forced rebalance on stale data). */
export const STALE_TIMER_MS = 10 * 60_000;

/** PoolContext without the SDK `pool` handle (re-created via openPool on boot). */
export interface PersistedPosition {
  poolAddress: string;
  mintX: string;
  mintY: string;
  xIsSol: boolean;
  initialDepositSol: number;
  rebalanceTimestamps: number[];
  lastRebalanceAt: number;
  volume1hBaselineUsd: number;
  volume1hBaselineSetAtMs: number;
  binStep: number;
  centerBinId: number | null;
  outOfRangeSinceMs: number | null;
  inRangeSinceMs: number | null;
  peakProfitPct: number;
  otherMintDecimals: number;
  reserveSolAccount: string;
}

export interface PersistedState {
  version: number;
  savedAtMs: number;
  wallet: string;
  position: PersistedPosition | null;
  /** true while an irreversible multi-step operation (close/rebalance/entry) is running: a restart then may have left tokens in the wallet. */
  inFlight: boolean;
  currentCapitalSol: number;
  lastOtherMint: string | null;
  lastSwitchAtMs: number | null;
  /** [poolAddress, blacklisted-until epoch ms] */
  blacklist: [string, number][];
  /** [mint, exit price USD] — see ScannerConfig.chaseGuardPools */
  chaseGuard: [string, number][];
  dollarFlowBreach: { pool: string; count: number };
}

export type BootPlan =
  | { kind: 'flat' }
  | { kind: 'resume'; poolAddress: string; fromState: boolean }
  | { kind: 'ambiguous'; pools: string[] };

/**
 * Decide what to do on boot from ground truth. `statePool` = pool the state file claims we hold (or
 * null); `chainPools` = pools where the wallet really has an open position right now.
 * - none on chain -> flat (the caller clears any stale state position)
 * - exactly one on chain -> resume it; fromState says whether the state file describes that same pool
 * - more than one -> ambiguous: refuse to trade (never risk double-deploying)
 */
export function reconcileBoot(statePool: string | null, chainPools: string[]): BootPlan {
  const pools = [...new Set(chainPools)];
  const [only] = pools;
  if (only === undefined) return { kind: 'flat' };
  if (pools.length > 1) return { kind: 'ambiguous', pools };
  return { kind: 'resume', poolAddress: only, fromState: statePool === only };
}

/** Timers saved long ago can't be trusted: drop them so updateOutOfRangeTracking re-observes from now. */
export function applyStaleTimers(pos: PersistedPosition, savedAtMs: number, nowMs: number, maxAgeMs = STALE_TIMER_MS): PersistedPosition {
  if (nowMs - savedAtMs <= maxAgeMs) return { ...pos };
  return { ...pos, outOfRangeSinceMs: null, inRangeSinceMs: null };
}

/** Blacklist entries store their expiry; keep only the unexpired ones. */
export function pruneExpired(entries: [string, number][], nowMs: number): [string, number][] {
  return entries.filter(([, until]) => until > nowMs);
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Structural validation: a corrupt or foreign file must never be trusted as bookkeeping. */
export function parseState(raw: string, wallet: string): PersistedState | null {
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (o.version !== STATE_VERSION || o.wallet !== wallet || !isFiniteNum(o.savedAtMs)) return null;
  if (!isFiniteNum(o.currentCapitalSol) || typeof o.inFlight !== 'boolean') return null;
  if (!Array.isArray(o.blacklist) || !Array.isArray(o.chaseGuard)) return null;
  const p = o.position as Record<string, unknown> | null;
  if (p !== null) {
    if (!p || typeof p !== 'object') return null;
    const strs = ['poolAddress', 'mintX', 'mintY', 'reserveSolAccount'];
    const nums = ['initialDepositSol', 'lastRebalanceAt', 'volume1hBaselineUsd', 'volume1hBaselineSetAtMs', 'binStep', 'peakProfitPct', 'otherMintDecimals'];
    if (strs.some((k) => typeof p[k] !== 'string') || nums.some((k) => !isFiniteNum(p[k]))) return null;
    if (typeof p.xIsSol !== 'boolean' || !Array.isArray(p.rebalanceTimestamps)) return null;
  }
  return o as unknown as PersistedState;
}

export function stateFilePath(): string {
  return process.env.STATE_FILE ?? DEFAULT_STATE_FILE;
}

/** Atomic write: tmp file + rename, so a kill mid-write can never leave a half-written state. Never throws (state is best-effort bookkeeping). */
export function saveState(state: PersistedState, path = stateFilePath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Returns null if missing, unreadable, corrupt, from another wallet, or another version. A rejected existing file is kept as `.bad`. */
export function loadState(wallet: string, path = stateFilePath()): PersistedState | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseState(raw, wallet);
  if (!parsed) {
    try {
      copyFileSync(path, `${path}.bad`);
    } catch {
      /* ignore */
    }
  }
  return parsed;
}
