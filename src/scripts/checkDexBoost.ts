import assert from 'node:assert/strict';
import { activeBoosts } from '../logic/dexBoost.js';
import { buildReactScreenerPrompt } from '../logic/aiPrompts.js';

// no pair data at all: unknown, never 0
assert.equal(activeBoosts(undefined), undefined);
assert.equal(activeBoosts([]), undefined);
// pairs without a boosts field (DexScreener omits it when nothing is running): hydrated, no boost
assert.equal(activeBoosts([{}, { boosts: {} }]), 0);
// a boost on any of the token's pairs counts, the highest wins (ELON2028-like: boost 500 on the PumpSwap pair, none on the Meteora pair)
assert.equal(activeBoosts([{ boosts: { active: 0 } }, { boosts: { active: 500 } }, {}]), 500);
assert.equal(activeBoosts([{ boosts: { active: 10 } }, { boosts: { active: 30 } }]), 30);
// garbage values never become a boost
assert.equal(activeBoosts([{ boosts: { active: Number.NaN } }, { boosts: { active: -5 } }]), 0);

// the screener prompt carries the rule as a weighed risk factor, with the age condition, and not as a veto
const prompt = buildReactScreenerPrompt(0.9, '', []);
assert.match(prompt, /dexBoostsActive > 0/);
assert.match(prompt, /poolAgeHours under about 48/);
assert.match(prompt, /not a veto/);
console.log('checkDexBoost ok');
