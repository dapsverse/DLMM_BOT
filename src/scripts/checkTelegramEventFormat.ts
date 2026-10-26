import assert from 'node:assert/strict';
import { createDeduper, formatEvent } from '../logic/telegramEventFormat.js';

const entered = '2026-10-23T13:46:55.365Z [info] [index] entered pool 9fm4XNjiNUXVQqu7d4X2iqjkhgftptcUvD2XbgheexAY {"capitalSol":0.613240337,"priceChange1hPct":4.99,"priceChange6hPct":-18.54,"priceChange24hPct":410,"volumeSpikeRatio":0.477,"buyRatio1h":0.5303030303030303,"priceContext":{"aboveLow6hPct":14.95,"belowHigh6hPct":-30.8,"aboveLow48hPct":978.47,"belowHigh48hPct":-45.5,"chg15mPct":-1.97,"chg1hPct":5.1,"higherLow":true},"feeYield":{"r24h":10.569494930124756,"r4hx6":12.755},"dollarFlow":null}';
assert.equal(
  formatEvent(entered),
  '✅ Masuk pool 9fm4XN…exAY | modal 0.613 SOL\n1h +5.0% · 6h -18.5% · 24h +410% · vol spike 0.48x · buy 53%\n48h: +978% dari low, -45.5% dari high · higher low ✓ · fee yield 24h 10.6%\n20:46 WIB',
);
assert.equal(formatEvent('[info] [index] entered pool P123 {"capitalSol":1}'), '✅ Masuk pool P123 | modal 1.000 SOL'); // minimal data, no time
assert.equal(formatEvent('[info] [index] entered pool P123 {broken'), undefined); // parse failure: raw line

const trig = '2026-10-23T10:07:36.494Z [info] [ai] manager triggered {"pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g","trigger":"out of range 7min"}';
assert.equal(formatEvent(trig), '🧠 AI Manager dipicu · pool 9Ft5WA…7j4g\nout of range 7min\n17:07 WIB');
const dec = '2026-10-23T10:07:39.487Z [info] [ai] manager decision {"pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g","action":"hold","reason":"default hold","react":true,"turns":1,"costUsd":0,"tools":[]}';
assert.equal(formatEvent(dec), '⏸ AI Manager: HOLD · pool 9Ft5WA…7j4g\ndefault hold\nturns 1 · 0 tool calls · cost $0.000 · 17:07 WIB');
assert.equal(formatEvent('[info] [ai] manager decision {"action":"close","reason":"dump"}'), '🔴 AI Manager: CLOSE\ndump');
assert.equal(formatEvent('2026-10-23T08:34:27.596Z [warn] [index] AI manager: closing position {"pool":"ELnp","reason":"x"}'), null); // duplicate of the close decision

assert.equal(formatEvent('2026-10-23T10:10:26.713Z [warn] [rebalanceEngine] TAKE_PROFIT: closing position {"pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g"}'), '🔻 TAKE_PROFIT: menutup posisi 9Ft5WA…7j4g\nPnL realized menyusul\n17:10 WIB');
// old log line (no realizedPnlSol key): the old format, no PnL line
assert.equal(
  formatEvent('2026-10-23T10:10:36.206Z [warn] [rebalanceEngine] TAKE_PROFIT complete {"pool":"9Ft5WAeBULPQgpexg7jtga19DuTtcVeshsSHaEAx7j4g","solBalance":0.328949693,"nextCapital":0.29894969299999996}'),
  '✅ TAKE_PROFIT selesai · pool 9Ft5WA…7j4g\nsaldo wallet 0.329 SOL · modal berikut 0.299 SOL\n17:10 WIB',
);
// new log line: realized PnL in SOL and % of the deploy (the HgEJs5 take profit of 2026-10-26, same numbers as state/ai-outcomes.jsonl)
assert.equal(
  formatEvent('2026-10-26T00:16:09.652Z [warn] [rebalanceEngine] TAKE_PROFIT complete {"pool":"HgEJs5LSjd3da5LTsTJXa3nXjT1oucdLemeUq6V1gbsS","solBalance":0.508767186,"nextCapital":0.478767186,"depositSol":0.38342240600000005,"realizedPnlSol":0.02534,"realizedPnlPct":6.61}'),
  '✅ TAKE_PROFIT selesai · pool HgEJs5…gbsS\nsaldo wallet 0.509 SOL · modal berikut 0.479 SOL\nPnL realized +0.0253 SOL (+6.61% dari modal deploy 0.383 SOL)\n07:16 WIB',
);
// a loss keeps its sign; works for other exit kinds too
assert.match(formatEvent('2026-10-26T00:16:09.652Z [warn] [rebalanceEngine] STOP_LOSS complete {"pool":"P1","solBalance":0.3,"nextCapital":0.27,"depositSol":0.4,"realizedPnlSol":-0.1,"realizedPnlPct":-25}')!, /PnL realized -0\.1000 SOL \(-25\.00% dari modal deploy 0\.400 SOL\)/);
// legs not measured reliably (null): said so, no number invented
assert.match(formatEvent('2026-10-26T00:16:09.652Z [warn] [rebalanceEngine] TAKE_PROFIT complete {"pool":"P1","solBalance":0.3,"nextCapital":0.27,"depositSol":0.4,"realizedPnlSol":null,"realizedPnlPct":null}')!, /PnL realized: tidak terukur/);
// deposit missing: still prints the PnL, without the deploy amount
assert.match(formatEvent('2026-10-26T00:16:09.652Z [warn] [rebalanceEngine] TAKE_PROFIT complete {"pool":"P1","realizedPnlSol":0.01,"realizedPnlPct":2}')!, /PnL realized \+0\.0100 SOL \(\+2\.00% dari modal deploy\)/);

// generic form: no timestamp/level prefix, rounded numbers, ids shortened, arrays counted, signatures dropped
const gen = formatEvent('2026-10-14T19:59:21.691Z [info] [dlmm] limit order placed {"goal":"buyToken","order":"8o5JwGJ7mQk3SbYwaUTodobxq3Jxx6g66UnPKwuUQ49P","activeBin":-469,"bins":[-480,-479,-478],"amount":"464972284","signature":"5Za9Jjip1kvXSnWKatvSAP6TYd2nHnmeZb12iBpmMsH5FVuG6ADwQBDDuz6LaptNMzqQTtgWFt8gvMWp98AhNpFQ"}')!;
assert.equal(gen, 'ℹ️ limit order placed\ngoal buyToken · order 8o5JwG…Q49P · activeBin -469 · bins [3] · amount 464972284\ndlmm · 02:59 WIB');
assert.ok(!gen.includes('5Za9Jjip') && !gen.includes('T19:'));
assert.equal(formatEvent('2026-10-21T01:59:19.912Z [warn] [riskManager] HARD_EXIT {"reasons":["unrealized loss 41.29% >= STOP_LOSS_PCT 25%"]}'), '⚠️ HARD_EXIT\nreasons unrealized loss 41.29% >= STOP_LOSS_PCT 25%\nriskManager · 08:59 WIB');
assert.equal(formatEvent('2026-10-23T10:07:39.486Z [warn] [ai] react manager error {"error":"Claude Code returned an error result: limit"}'), '⚠️ react manager error\nerror Claude Code returned an error result: limit\nai · 17:07 WIB');
assert.equal(formatEvent('2026-10-23T10:07:39.486Z [error] [x] boom'), '❌ boom\nx · 17:07 WIB'); // no json

// PR #13 screener lines still handled, unparsable lines fall back
assert.ok(formatEvent('2026-10-23T13:31:15.445Z [info] [ai] screener decision {"action":"skip","reason":"r","conviction":6}')!.startsWith('🤖 AI Screener: SKIP'));
assert.equal(formatEvent('2026-10-23T13:31:58.487Z [info] [index] AI screener: skip {"reason":"r"}'), null);
assert.equal(formatEvent('plain text line'), undefined);

// deduper: the same message within the window is dropped (time line ignored), a different one or one after the window passes
const rep = createDeduper(10 * 60_000);
const tp = '2026-10-23T18:43:00.224Z [info] [riskManager] TAKE_PROFIT {"reasons":["profit 4.23% dropped to trailing floor 6.00%"]}';
const m1 = formatEvent(tp)!;
const m2 = formatEvent(tp.replace('18:43:00', '18:44:15'))!; // next minute: only the WIB time differs
assert.notEqual(m1, m2);
assert.equal(rep(m1, 0), false);
assert.equal(rep(m2, 60_000), true);
assert.equal(rep(formatEvent(tp.replace('4.23%', '3.30%'))!, 61_000), false); // different content
assert.equal(rep(m1, 11 * 60_000), false); // window over
console.log('checkTelegramEventFormat ok');
