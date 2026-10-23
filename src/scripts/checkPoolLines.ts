import assert from 'node:assert/strict';
import { poolLineTexts, type PoolLineInput } from '../logic/poolLines.js';
import { cycleView } from '../logic/cyclePnl.js';

const base: PoolLineInput = {
  tokenX: 'PHP',
  tokenY: 'SOL',
  binStep: 100,
  baseFee: 1,
  valueSol: 0.2112,
  valueUsd: 22.0,
  feesSol: 0.0001,
  feesUsd: 0.01,
  depositSol: 0.2034,
  pnlSol: 0.008,
  pnlPct: 3.92,
  feePerTvl24h: 26.9,
  outOfRange: false,
};

// non-flip: wording identical to the pre-flip-labels version
const plain = poolLineTexts(base, 100, true, null);
assert.deepEqual(plain, [
  'PHP-SOL: value 0.2112 SOL ($21.12), fees 0.0001 SOL ($0.01), PnL +0.0080 SOL ($0.80) (+3.92%)',
  'deposit: 0.2034 SOL ($20.34)',
  'fees generated (unclaimed): 0.0001 SOL = $0.01',
  'position value now: 0.2112 SOL = $22.00',
  'PnL incl. fees: +0.0080 SOL = +$0.80 (+3.92%)',
  'pool fee/TVL 24h: 26.90%, bin step 100, base fee 1%',
  'range: in range',
  'SOL price: $100.00',
]);
assert.deepEqual(poolLineTexts(base, 100, false, null), [plain[0]]);
assert.ok(!plain.join('\n').includes('total cycle value'));
// a state basis that is not in flip phase changes nothing
assert.deepEqual(poolLineTexts(base, 100, true, { initialDepositSol: 0.3, flipPhase: false, bankedSol: 0.06 }), plain);

// flip: explicit total line, flip-only labels, cycle PnL against the original deposit
const basis = { initialDepositSol: 0.2879, flipPhase: true, bankedSol: 0.061 };
const flip = poolLineTexts(base, 100, true, basis);
const total = 0.2112 + 0.0001 + 0.061;
assert.equal(flip[0], `PHP-SOL: flip position value 0.2112 SOL ($21.12), fees 0.0001 SOL ($0.01), PnL ${(0.2112 + 0.0001 + 0.061 - 0.2879) >= 0 ? '+' : ''}${(0.2112 + 0.0001 + 0.061 - 0.2879).toFixed(4)} SOL ($${((0.2112 + 0.0001 + 0.061 - 0.2879) * 100).toFixed(2)}) (${(((0.2112 + 0.0001 + 0.061 - 0.2879) / 0.2879) * 100).toFixed(2)}%) [cycle incl. flip, banked 0.0610 SOL]`);
assert.equal(flip[1], `total cycle value: ${total.toFixed(4)} SOL ($${(total * 100).toFixed(2)}) = posisi 0.2112 + fee 0.0001 + banked 0.0610`);
assert.equal(flip[1], 'total cycle value: 0.2723 SOL ($27.23) = posisi 0.2112 + fee 0.0001 + banked 0.0610');
assert.ok(flip.some((l) => l.startsWith('flip position value now (not the whole cycle): 0.2112 SOL')));
assert.ok(!flip.some((l) => l.startsWith('position value now')), 'the plain label must not be used for a flip');
assert.ok(flip.some((l) => l.startsWith('deposit (original, before flip): 0.2879 SOL') && l.includes('flipped position deposit: 0.2034')));
assert.ok(flip.some((l) => l.startsWith('PnL incl. fees:') && l.endsWith('(whole cycle)')));
// the total equals what cycleView reports and what the PnL line is based on
assert.ok(Math.abs(cycleView(0.2112, 0.0001, 0.2034, 0.008, 3.92, basis).totalValueSol - total) < 1e-12);
// the short (/status) form also carries the total line
const flipShort = poolLineTexts(base, 100, false, basis);
assert.equal(flipShort.length, 2);
assert.ok(flipShort[0]!.includes('flip position value') && flipShort[1]!.startsWith('total cycle value'));

// no SOL price: no dollar amounts, nothing breaks
const noUsd = poolLineTexts(base, 0, false, basis);
assert.ok(!noUsd.join('\n').includes('$'));
assert.equal(noUsd[1], 'total cycle value: 0.2723 SOL = posisi 0.2112 + fee 0.0001 + banked 0.0610');

console.log('checkPoolLines ok');
