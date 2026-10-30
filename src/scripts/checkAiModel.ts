import assert from 'node:assert/strict';
import { PERIODIC_TRIGGER, pickManagerModel, managerTrigger } from '../logic/aiTriggers.js';
import { modelOption } from '../services/aiReact.js';
import { env } from '../config/env.js';

const m = { closeModel: 'claude-opus-5-5', periodicModel: '' };

// event-triggered manager calls (a possible close) use the close model; the routine periodic check stays on the default (empty = SDK default)
assert.equal(pickManagerModel('out of range 9min', m), 'claude-opus-5-5');
assert.equal(pickManagerModel('loss -9.0%', m), 'claude-opus-5-5');
assert.equal(pickManagerModel('holding token (11%) at a loss', m), 'claude-opus-5-5');
assert.equal(pickManagerModel(PERIODIC_TRIGGER, m), '');
// no trigger known: treated as an event (never silently downgraded)
assert.equal(pickManagerModel(undefined, m), 'claude-opus-5-5');
// the periodic model can be set explicitly too
assert.equal(pickManagerModel(PERIODIC_TRIGGER, { ...m, periodicModel: 'some-model' }), 'some-model');

// the literal produced by managerTrigger is the constant the picker compares with
const limits = { periodicMin: 30, cooldownMin: 10, oorMin: 5, lossPct: 8, volumeBelowPct: 50 };
const base = { isOutOfRange: false, minutesOutOfRange: null, profitPct: 0, volumeVsBaselinePct: 100, tokenSharePct: 0, minutesSinceLastCall: 45 };
assert.equal(managerTrigger(base, limits), PERIODIC_TRIGGER);
assert.equal(managerTrigger({ ...base, minutesSinceLastCall: 20, isOutOfRange: true, minutesOutOfRange: 9 }, limits), 'out of range 9min');

// SDK option: only a non-empty model is passed on, otherwise the SDK default stays in force
assert.deepEqual(modelOption('claude-opus-5-5'), { model: 'claude-opus-5-5' });
assert.deepEqual(modelOption('  claude-opus-5-5 '), { model: 'claude-opus-5-5' });
assert.deepEqual(modelOption(''), {});
assert.deepEqual(modelOption('   '), {});
assert.deepEqual(modelOption(undefined), {});

// configured defaults: Opus for open (screener) and event-triggered close decisions, default model for the periodic check (unless overridden by the environment)
if (process.env.AI_SCREEN_MODEL === undefined) assert.equal(env.AI_SCREEN_MODEL, 'claude-opus-5-5');
if (process.env.AI_MANAGE_CLOSE_MODEL === undefined) assert.equal(env.AI_MANAGE_CLOSE_MODEL, 'claude-opus-5-5');
if (process.env.AI_MANAGE_MODEL === undefined) assert.equal(env.AI_MANAGE_MODEL, '');

console.log('checkAiModel ok');
