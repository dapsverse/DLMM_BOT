// READ-ONLY rough backtest (no wallet, no tx): SOL-only ladder variants WITHOUT flip on S2 candidate entries + cached 5m candles. Temporary file, deleted after the run.
import { existsSync, readFileSync } from 'node:fs';
import { env } from '../config/env.js';
import { advanceSim, type SimParams, type SimPosition } from '../logic/shadowSim.js';
type C = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
interface Cand { type: string; cycle: string; id: string; pool: string; name: string; mint: string; binStep: number; price: number; f: { volRatio: number | null; organicScore: number | null; botHoldersPct: number | null; chg24h: number | null; feeTvl24h: number | null } }
const DIRS = ['/tmp/dip-candles', '/tmp/wide-candles'];
const load = (pool: string): C[] => {
  for (const d of DIRS) if (existsSync(`${d}/${pool}.json`)) return JSON.parse(readFileSync(`${d}/${pool}.json`, 'utf8')) as C[];
  return [];
};
const cands = readFileSync('state/s2/candidates.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Cand).filter((c) => c.type === 's2_cand' && c.price > 0 && c.binStep > 0);
const t0 = (c: Cand) => Math.floor(Date.parse(c.cycle) / 1000);
// base gates S2 can express: audit, volume floor, falling knife
const base = (c: Cand) => (c.f.volRatio ?? 0) >= env.ENTRY_MIN_VOLUME_SPIKE_RATIO && (c.f.organicScore ?? 100) >= env.MIN_ORGANIC_SCORE && (c.f.botHoldersPct ?? 0) <= env.MAX_BOT_HOLDERS_PCT && !(c.f.chg24h !== null && c.f.chg24h <= -env.ENTRY_HARD_SKIP_DROP24H_PCT && (c.f.volRatio ?? 0) < env.ENTRY_HARD_SKIP_MAX_SPIKE);
interface Ev { c: Cand; after: C[]; aboveLow48: number | null }
const evs: Ev[] = [];
for (const c of cands.filter(base)) {
  const cs = load(c.pool);
  if (cs.length < 50) continue;
  const t = t0(c);
  const after = cs.filter((x) => x.timestamp > t);
  if (after.length < 12) continue;
  const w48 = cs.filter((x) => x.timestamp > t - 48 * 3600 && x.timestamp <= t);
  const covers48 = cs[0]!.timestamp <= t - 47 * 3600 && w48.length > 400;
  evs.push({ c, after, aboveLow48: covers48 ? (c.price / Math.min(...w48.map((x) => x.low)) - 1) * 100 : null });
}
const dedup = (a: Ev[]): Ev[] => {
  const last = new Map<string, number>();
  const out: Ev[] = [];
  for (const e of [...a].sort((x, y) => t0(x.c) - t0(y.c))) {
    if (t0(e.c) - (last.get(e.c.pool) ?? -1e12) < 6 * 3600) continue;
    last.set(e.c.pool, t0(e.c));
    out.push(e);
  }
  return out;
};
const sets: Record<string, Ev[]> = {
  'ALL base-gated': dedup(evs),
  '+ fee/TVL 24h >= 7 (PR #37)': dedup(evs.filter((e) => (e.c.f.feeTvl24h ?? 0) >= env.MERIDIAN_MIN_FEE_TVL_24H_PCT)),
  '+ fee>=7 + not post-pump (>=800% above 48h low, known only)': dedup(evs.filter((e) => (e.c.f.feeTvl24h ?? 0) >= env.MERIDIAN_MIN_FEE_TVL_24H_PCT && (e.aboveLow48 === null || e.aboveLow48 < 800))),
};
const baseP: SimParams = {
  capitalSol: 1, ladderBins: 69, targetRangePct: env.TARGET_RANGE_PCT, minRadius: env.MIN_BIN_RADIUS, maxRadius: env.MAX_BIN_RADIUS, slPct: 25,
  exit: { takeProfitPct: env.MERIDIAN_TAKE_PROFIT_PCT, trailingTriggerPct: env.MERIDIAN_TRAILING_TRIGGER_PCT, trailingDropPct: env.MERIDIAN_TRAILING_DROP_PCT, outOfRangeBinsToClose: env.MERIDIAN_OOR_BINS_TO_CLOSE, outOfRangeWaitMinutes: env.MERIDIAN_OOR_WAIT_MIN, minFeePerTvl24hPct: env.MERIDIAN_MIN_FEE_TVL_24H_PCT, minAgeBeforeYieldCheckMin: env.MERIDIAN_MIN_AGE_YIELD_CHECK_MIN },
  trailingFloorPct: env.TRAILING_MIN_PNL_PCT, flipOorAboveMin: 10, flipTvlCollapsePct: 30, exitCostPct: env.EXIT_COST_PCT, exitCostGasSol: env.EXIT_COST_GAS_SOL, feeFactor: 1, maxHours: 48,
};
interface V { name: string; bins: number; sl: number; tp?: number }
const VARS: V[] = [
  { name: 'V0 live-like: 69 bins, SL25, bot TP/trailing, NO flip', bins: 69, sl: 25 },
  { name: 'V1 69 bins, SL12', bins: 69, sl: 12 },
  { name: 'V2 35 bins, SL12', bins: 35, sl: 12 },
  { name: 'V3 25 bins, SL10', bins: 25, sl: 10 },
  { name: 'V4 25 bins, SL8 / TP8 symmetric (no trailing)', bins: 25, sl: 8, tp: 8 },
  { name: 'V5 15 bins, SL6 / TP6 symmetric (no trailing)', bins: 15, sl: 6, tp: 6 },
];
function open(e: Ev, v: V): SimPosition {
  const t = t0(e.c);
  const n = v.bins;
  const w = Array.from({ length: n }, (_, i) => 1 + i); // bid-ask: heavier deeper
  const sum = w.reduce((a, b) => a + b, 0);
  return { id: e.c.id, decisionId: e.c.id, mode: 'A', pool: e.c.pool, name: e.c.name, mint: e.c.mint, binStep: e.c.binStep, solPriceUsd: null, capitalSol: 1, entryTs: t, lastTs: t, entryPrice: e.c.price, feeTvl24hPct: e.c.f.feeTvl24h, phase: 'classic', solBins: w.map((x, d) => ({ k: -d, s: x / sum })), tokBins: [], lo: -(n - 1), hi: 0, feesSol: 0, gasPaidSol: env.EXIT_COST_GAS_SOL, peakPct: 0, oorSinceTs: null, flipTvlUsd: null, flipTs: null };
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
function t(xs: { v: number; g: string }[]): string {
  const N = xs.length;
  if (N < 3) return 'n/a';
  const m = sum(xs.map((x) => x.v)) / N;
  const gr = new Map<string, number>();
  for (const x of xs) gr.set(x.g, (gr.get(x.g) ?? 0) + (x.v - m));
  const G = gr.size;
  if (G < 2) return 'n/a';
  const va = (sum([...gr.values()].map((s) => s * s)) / (N * N)) * (G / (G - 1));
  return va > 0 ? (m / Math.sqrt(va)).toFixed(2) : 'n/a';
}
for (const [sn, es] of Object.entries(sets)) {
  console.log(`\n#### ${sn}: decisions ${es.length}, pools ${new Set(es.map((e) => e.c.pool)).size}, post-pump-known ${es.filter((e) => e.aboveLow48 !== null).length}`);
  for (const v of VARS) {
    const p: SimParams = { ...baseP, ladderBins: v.bins, slPct: v.sl, exit: { ...baseP.exit, ...(v.tp ? { takeProfitPct: v.tp, trailingTriggerPct: 1e9 } : {}) } };
    const rs = es.map((e) => ({ e, x: advanceSim(open(e, v), e.after, { tvlUsd: null, feeTvl24hPct: e.c.f.feeTvl24h }, p).exit })).filter((r) => r.x);
    const pn = rs.map((r) => r.x!.pnlSol);
    const w = sum(pn.filter((x) => x > 0));
    const l = Math.abs(sum(pn.filter((x) => x < 0)));
    console.log(`  ${v.name}: resolved ${rs.length}/${es.length}, total ${sum(pn).toFixed(3)} SOL (1 SOL/pos), avg ${(sum(pn) / pn.length * 100).toFixed(2)}%, win ${Math.round((pn.filter((x) => x > 0).length / pn.length) * 100)}%, PF ${l ? (w / l).toFixed(2) : 'inf'}, worst ${(Math.min(...pn) * 100).toFixed(1)}%, t ${t(rs.map((r) => ({ v: r.x!.pnlSol, g: r.e.c.pool + r.e.c.cycle.slice(0, 10) })))}`);
  }
}
