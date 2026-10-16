import assert from 'node:assert/strict';
import { ladderBounds, ladderRangeStatus } from '../logic/ladderRange.js';
import { validateSubmit } from '../services/aiReact.js';
import { parseScreenerDecision } from '../logic/aiDecision.js';

// token-only spot: deposited token is X when SOL is Y (xIsSol=false) -> bins [center, center+n-1] ABOVE the price (bin id up = token price up)
const center = -305, n = 60;
const depositIsX = true; // = !xIsSol with xIsSol=false
assert.deepEqual(ladderBounds(center, n, depositIsX), { lo: -305, hi: -246 });
const inside = ladderRangeStatus(-300, center, n, depositIsX);
assert.equal(inside.isOutOfRange, false);
const pumped = ladderRangeStatus(-240, center, n, depositIsX); // price rose through the range: all SOL
assert.deepEqual(pumped, { isOutOfRange: true, tokenBelowRange: true }); // tokenBelowRange here = "fell through" = deposit side sold out
const dumped = ladderRangeStatus(-310, center, n, depositIsX); // price fell below the range: still all token
assert.deepEqual(dumped, { isOutOfRange: true, tokenBelowRange: false });
// getBinRangeStatus inverts the flag for token spot so tokenBelowRange always means "position is all token": dumped -> true, pumped -> false.

// SOL=X variant: token is Y, range [center-(n-1), center] (bins below), token price up = bin id down
assert.deepEqual(ladderBounds(100, n, false), { lo: 41, hi: 100 });

const allowed = new Set(['P']);
const ok = { action: 'deploy' as const, pool: 'P', conviction: 6, reason: 'r', bins_below: 50 };
assert.equal((validateSubmit({ ...ok, strategy: 'token_spot' }, allowed, 35, 69, 0) as { strategy: string }).strategy, 'token_spot');
assert.equal((validateSubmit(ok, allowed, 35, 69, 0) as { strategy: string }).strategy, 'sol_ladder');
assert.equal((validateSubmit({ ...ok, strategy: 'bogus' }, allowed, 35, 69, 0) as { strategy: string }).strategy, 'sol_ladder');
const d = parseScreenerDecision('{"action":"deploy","pool":"P","strategy":"token_spot","bins_below":50,"conviction":6,"reason":"x"}', allowed, 35, 69, 0) as { strategy: string };
assert.equal(d.strategy, 'token_spot');
console.log('checkTokenSpot ok');
