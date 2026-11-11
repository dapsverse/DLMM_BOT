import assert from 'node:assert/strict';
import { createHeartbeat, formatHeartbeat, heartbeatIntervalOf, shouldSendHeartbeat, skipReasonKey } from '../logic/heartbeat.js';
import { formatEvent } from '../logic/telegramEventFormat.js';
import { env } from '../config/env.js';

// reason keys group by text, not by numbers
assert.equal(skipReasonKey('low yield: fee/TVL 24h 4.93% < 7% (the low-yield exit would close it after the first hour)'), 'low yield');
assert.equal(skipReasonKey('low yield: fee/TVL 24h 0.31% < 7%'), 'low yield');
assert.equal(skipReasonKey('low volume spike: 0.03x < 0.15x (volume pace fading)'), 'low volume spike');
assert.equal(skipReasonKey('token audit: bot holders % 46.2 > max'), 'token audit');
assert.equal(skipReasonKey('no dip: 5.8% below the 4h high, need 10-30%'), 'no dip');
assert.equal(skipReasonKey('18.1% below the 4h high with volume spike 0.2x < 1x (fading sell-off)'), 'N below the Nh high with volume spike N'); // a reason without a colon: numbers masked, cut at 40 chars
assert.equal(skipReasonKey(''), 'unknown');

// counters fed from log messages only
const t0 = 1_000_000;
const hb = createHeartbeat(t0);
hb.onLogLine('[scanner] 13/200 pairs pass filters (meridian mode), top 13 shortlisted');
hb.onLogLine('[scanner] 5/200 pairs pass filters (meridian mode), top 5 shortlisted');
for (let i = 0; i < 4; i++) hb.onLogLine(`[index] skipping pool P${i} — low yield: fee/TVL 24h ${i}.5% < 7%`);
for (let i = 0; i < 2; i++) hb.onLogLine(`[index] skipping pool Q${i} — no dip: ${i}.8% below the 4h high, need 10-30%`);
hb.onLogLine('[index] skipping pool R — low volume spike: 0.03x < 0.15x');
hb.onLogLine('[index] skipping pool S — token audit: bot holders % 46.2 > max');
hb.onLogLine('[index] no eligible pool found this scan'); // not a skip, not a scan
hb.onLogLine(undefined); // non-string messages are ignored
hb.onLogLine({ a: 1 });
const snap = hb.take(t0 + 2 * 3600_000);
assert.deepEqual({ ...snap, topSkips: undefined }, { windowMin: 120, scans: 2, pairs: 400, passedScanner: 18, skipped: 8, eligible: 10, topSkips: undefined });
assert.deepEqual(snap.topSkips, [['low yield', 4], ['no dip', 2], ['low volume spike', 1]]); // top 3 of 4 reasons, most frequent first
// take() resets the window
const snap2 = hb.take(t0 + 3 * 3600_000);
assert.deepEqual({ scans: snap2.scans, skipped: snap2.skipped, eligible: snap2.eligible, windowMin: snap2.windowMin, top: snap2.topSkips.length }, { scans: 0, skipped: 0, eligible: 0, windowMin: 60, top: 0 });

// due(): interval, 0 = off
const hb2 = createHeartbeat(t0);
assert.equal(hb2.due(t0 + 119 * 60_000, 120), false);
assert.equal(hb2.due(t0 + 120 * 60_000, 120), true);
assert.equal(hb2.due(t0 + 1e9, 0), false);
assert.equal(hb2.due(t0 + 1e9, -5), false);
hb2.take(t0 + 120 * 60_000);
assert.equal(hb2.due(t0 + 121 * 60_000, 120), false); // window restarts after take()

// notifier: only after a full interval of silence
assert.equal(shouldSendHeartbeat(0, 119 * 60_000, 120), false); // something was sent 119 min ago
assert.equal(shouldSendHeartbeat(0, 120 * 60_000, 120), true);
assert.equal(shouldSendHeartbeat(0, 1e12, 0), false); // off

// log line -> interval, message text
const meta = { windowMin: 120, scans: 480, pairs: 96000, passedScanner: 1500, skipped: 1497, eligible: 3, topSkips: [['low yield', 900], ['no dip', 300], ['low volume spike', 200]], intervalMin: 120, position: null, uptimeMin: 1264 };
const line = `2026-11-05T07:00:00.000Z [info] [heartbeat] bot heartbeat ${JSON.stringify(meta)}`;
assert.equal(heartbeatIntervalOf(line), 120);
assert.equal(heartbeatIntervalOf('2026-11-05T07:00:00.000Z [info] [index] no eligible pool found this scan'), null);
const text = formatEvent(line);
assert.ok(typeof text === 'string');
assert.match(text!, /Heartbeat DLMMBOT · 2j 0m terakhir/);
assert.match(text!, /Status: flat \(tidak ada posisi\) · uptime 21j 4m/);
assert.match(text!, /Scan 480× · pool dicek 96000 · lolos filter scanner 1500 · lolos semua gate 3/);
assert.match(text!, /Skip teratas: low yield 900× · no dip 300× · low volume spike 200×/);
assert.match(formatHeartbeat({ ...meta, position: 'CHOO-SOL', topSkips: [] }, ''), /Status: ada posisi CHOO-SOL[\s\S]*Skip teratas: -/);

// config: default 2 h unless the environment overrides it
if (process.env.HEARTBEAT_INTERVAL_MIN === undefined) assert.equal(env.HEARTBEAT_INTERVAL_MIN, 120);
console.log('OK: heartbeat (counters, window reset, interval, quiet-period rule, Telegram text)');
