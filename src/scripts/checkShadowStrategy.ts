import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { computeShadowInputs, decideShadow, ema, type ShadowCandle, type ShadowParams } from '../logic/shadowStrategy.js';
import { summarizeShadow, type ShadowLine } from '../logic/shadowReport.js';

// the documented defaults (env.ts SHADOW_*)
const P: ShadowParams = { chg15mPct: 1.5, chg1hPct: 3, chg4hPct: 8, emaSlopePct: 0.5, pressureBand: 0.05, volConfirmRatio: 1.3, downScore: 2, exitScore: 1 };
const T0 = 1_800_000_000;
/** n 5m candles ending now; price follows f(i) (0 = oldest); green candles when the price rose; volume v(i) */
const series = (n: number, f: (i: number) => number, v: (i: number) => number = () => 100): ShadowCandle[] =>
  Array.from({ length: n }, (_, i) => {
    const open = i === 0 ? f(0) : f(i - 1);
    const close = f(i);
    return { timestamp: T0 + i * 300, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: v(i) };
  });

// too little data: nothing is guessed
assert.equal(computeShadowInputs(series(48, () => 1), null), null);
const none = decideShadow(null, P);
assert.equal(none.mode, 'unknown');
assert.equal(none.score, null);

// EMA helper: constant series stays constant, rising series lags below the price
assert.deepEqual(ema([2, 2, 2], 12), [2, 2, 2]);
assert.ok(ema([1, 2, 3, 4, 5], 3)[4]! < 5);

// 1) steady downtrend: -0.3% per candle for 72 candles, volume expanding, only red candles
const down = series(72, (i) => 1 * Math.pow(0.997, i), (i) => 100 * Math.pow(1.03, i));
const di = computeShadowInputs(down, 0.4)!;
assert.ok(di.chg15mPct < -0.8 && di.chg1hPct < -3 && di.chg4hPct < -13 && di.emaSlopePct < -0.5);
assert.equal(di.upVolShare, 0); // all candles red
assert.equal(di.pressure, 0.2); // mean of 0 and 0.4
assert.ok(di.volRatio! > 1.3);
const dd = decideShadow(di, P);
assert.deepEqual(dd.votes, { chg15m: 0, chg1h: -1, chg4h: -1, ema: -1, pressure: -1, volume: -1 }); // 15m: -0.9% is under the 1.5% bar
assert.equal(dd.score, -5);
assert.equal(dd.trend, 'down');
assert.equal(dd.mode, 'B');

// 2) steady uptrend with green candles
const up = series(72, (i) => 1 * Math.pow(1.004, i), (i) => 100 * Math.pow(1.03, i));
const ud = decideShadow(computeShadowInputs(up, 0.6), P);
assert.equal(ud.trend, 'up');
assert.equal(ud.mode, 'A');
assert.ok(ud.score! >= 4);

// 3) flat / chop: neutral -> A
const flat = series(72, (i) => 1 + (i % 2 ? 0.001 : -0.001));
const fd = decideShadow(computeShadowInputs(flat, 0.5), P);
assert.equal(fd.trend, 'neutral');
assert.equal(fd.mode, 'A');

// volume only counts when it CONFIRMS the 1h move: expanding volume on a flat hour gives sign(0) = 0
const flatBig = series(72, () => 1, (i) => (i >= 60 ? 400 : 100));
assert.equal(decideShadow(computeShadowInputs(flatBig, null), P).votes.volume, 0);
// a down move on FADING volume gets no volume vote
const fade = series(72, (i) => Math.pow(0.997, i), (i) => 400 - i * 5);
assert.equal(decideShadow(computeShadowInputs(fade, null), P).votes.volume, 0);

// threshold edges: score -1 is not down, -2 is; unknown buyRatio does not break pressure
const base = computeShadowInputs(flat, null)!;
const mk = (o: Partial<typeof base>) => ({ ...base, ...o });
const s = (o: Partial<typeof base>, prev = false) => decideShadow(mk(o), P, prev);
assert.equal(s({ chg1hPct: -3, chg4hPct: 0, emaSlopePct: 0, chg15mPct: 0, pressure: null, volRatio: null }).score, -1); // one vote
assert.equal(s({ chg1hPct: -3, chg4hPct: 0, emaSlopePct: 0, chg15mPct: 0, pressure: null, volRatio: null }).mode, 'A');
assert.equal(s({ chg1hPct: -3, chg4hPct: -8, emaSlopePct: 0, chg15mPct: 0, pressure: null, volRatio: null }).mode, 'B'); // exactly on the bars: -1 -1 = -2
assert.equal(s({ chg1hPct: -2.99, chg4hPct: -8, emaSlopePct: 0, chg15mPct: 0, pressure: null, volRatio: null }).mode, 'A'); // just inside the bar

// hysteresis: a pool that was down stays down until the score is >= +1; a fresh pool needs <= -2 to go down
const mid = { chg1hPct: 0, chg4hPct: -8, emaSlopePct: 0, chg15mPct: 0, pressure: null, volRatio: null }; // score -1
assert.equal(s(mid, false).mode, 'A');
assert.equal(s(mid, true).mode, 'B');
assert.equal(s({ ...mid, chg4hPct: 0 }, true).mode, 'B'); // score 0: still down
assert.equal(s({ ...mid, chg4hPct: 0, chg1hPct: 3 }, true).mode, 'A'); // score +1: leaves down
assert.equal(s({ ...mid, chg4hPct: 0, chg1hPct: 3 }, true).trend, 'neutral');
assert.match(s(mid, true).reasons.join(' '), /was down/);

// NaN inputs vote 0 (never throw)
assert.equal(decideShadow(mk({ chg1hPct: NaN, chg4hPct: NaN, chg15mPct: NaN, emaSlopePct: NaN, pressure: null, volRatio: null }), P).score, 0);

// ---- report summary ----
const lines: ShadowLine[] = [
  { type: 'decision', id: 'a:1', ts: '2026-10-24T00:00:00Z', pool: 'a', mode: 'A', trend: 'up', score: 3 },
  { type: 'decision', id: 'b:1', ts: '2026-10-24T01:00:00Z', pool: 'b', mode: 'B', trend: 'down', score: -4 },
  { type: 'decision', id: 'c:1', ts: '2026-10-24T02:00:00Z', pool: 'c', mode: 'unknown', trend: 'unknown', score: null },
  { type: 'outcome', decisionId: 'a:1', ts: 'x', pool: 'a', realStrategy: 'sol_ladder', realMode: 'B', realizedPnlSol: -0.02, realizedPnlUsd: -2, realizedPnlPct: -7 },
  { type: 'outcome', decisionId: 'b:1', ts: 'x', pool: 'b', realStrategy: 'bid_ask_flip', realMode: 'B', realizedPnlSol: 0.01, realizedPnlUsd: 1, realizedPnlPct: 3 },
  { type: 'outcome', decisionId: null, ts: 'x', pool: 'z', realStrategy: 'sol_ladder', realMode: 'B', realizedPnlSol: 0.5, realizedPnlUsd: 50, realizedPnlPct: 9 },
];
const sum = summarizeShadow(lines);
assert.equal(sum.decisions, 3);
assert.equal(sum.byMode.A.withOutcome, 1);
assert.ok(Math.abs(sum.byMode.A.sumPnlSol + 0.02) < 1e-12);
assert.equal(sum.byMode.B.wins, 1);
assert.equal(sum.unlinkedOutcomes, 1); // the unlinked +0.5 is NOT mixed into any mode
assert.equal(sum.comparable, 2);
assert.equal(sum.agree, 1); // live is B: agrees with the B pick only
assert.equal(sum.byMode.unknown.decisions, 1);

// ---- I/O layer: fail-open and linking (axios mocked, temp file) ----
const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
process.env.SHADOW_FILE = join(dir, 'shadow.jsonl');
const { shadowDecision, shadowOutcome } = await import('../services/shadowLog.js');
const { readShadowLines } = await import('../services/shadowFile.js');
const info = { pool: 'POOL1', name: 'X-SOL', mint: 'MINT1', binStep: 100, buyRatio1h: 0.4, solPriceUsd: 100, aiStrategy: 'sol_ladder', aiConviction: 6 };

const realGet = axios.get;
try {
  // a failing fetch: resolves null, writes nothing, never throws
  (axios as unknown as { get: unknown }).get = async () => {
    throw new Error('network down');
  };
  assert.equal(await shadowDecision(info), null);
  assert.equal(readShadowLines().length, 0);

  // a working fetch: one decision line with the inputs and the price
  const rows = down.map((c) => ({ ...c }));
  (axios as unknown as { get: unknown }).get = async () => ({ data: { data: rows } });
  const d = await shadowDecision(info);
  assert.equal(d?.mode, 'B');
  const ls = readShadowLines();
  assert.equal(ls.length, 1);
  const first = ls[0] as unknown as Record<string, unknown>;
  assert.equal(first.type, 'decision');
  assert.equal(first.pool, 'POOL1');
  assert.equal(first.mint, 'MINT1');
  assert.equal(first.mode, 'B');
  assert.equal(first.priceAtDecision, down[down.length - 1]!.close);
  assert.ok((first.inputs as Record<string, unknown>).chg1hPct !== undefined);
  assert.equal((first.realIntent as Record<string, unknown>).aiStrategy, 'sol_ladder');

  // outcome links to the decision made just before the position opened, and USD uses the SOL price of the decision
  shadowOutcome({ pool: 'POOL1', openedAtMs: Date.now() + 5_000, realStrategy: 'bid_ask_flip', flipped: true, exitReason: 'STOP_LOSS', minutesHeld: 90, depositSol: 0.3, realizedPnlSol: -0.06, realizedPnlPct: -20, snapshotPnlPct: -22 });
  // an outcome for another pool does not link
  shadowOutcome({ pool: 'OTHER', openedAtMs: Date.now(), realStrategy: 'sol_ladder', flipped: false, exitReason: 'x', minutesHeld: 1, depositSol: 0.3, realizedPnlSol: null, realizedPnlPct: null, snapshotPnlPct: 0 });
  const all = readShadowLines() as unknown as Record<string, unknown>[];
  assert.equal(all.length, 3);
  assert.equal(all[1]!.decisionId, first.id);
  assert.equal(all[1]!.realMode, 'B');
  assert.equal(all[1]!.flipped, true);
  assert.equal(all[1]!.realizedPnlUsd, -6);
  assert.equal(all[2]!.decisionId, null);
  assert.equal(all[2]!.realizedPnlUsd, null);

  // the next decision of the same pool uses the hysteresis memory (was B)
  const again = await shadowDecision(info);
  assert.equal(again?.prevDown, true);
  // a damaged line is skipped by the reader, not fatal
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.SHADOW_FILE!, '{not json\n');
  assert.equal(readShadowLines().length, 4);
  assert.equal(readFileSync(process.env.SHADOW_FILE!, 'utf8').split('\n').filter(Boolean).length, 5);
} finally {
  (axios as unknown as { get: unknown }).get = realGet;
  rmSync(dir, { recursive: true, force: true });
}

console.log('checkShadowStrategy ok');
