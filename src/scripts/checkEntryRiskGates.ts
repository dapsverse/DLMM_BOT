import assert from 'node:assert/strict';
import { boostNoPresenceReject, dipFadingReject, lowYieldEntryReject, pumpedBagReject, sellBuyReject } from '../logic/entryRiskGates.js';
import { socialPresence } from '../logic/dexBoost.js';
import { env } from '../config/env.js';

// ---- boost without a website AND without an X account (Anakin-SOL 2026-11-02: boost 500, no site, no X)
assert.match(boostNoPresenceReject(500, false, false, 100) ?? '', /boost 500 >= 100 with no website and no X account/);
assert.ok(boostNoPresenceReject(100, false, false, 100)); // exactly the threshold rejects
assert.equal(boostNoPresenceReject(99, false, false, 100), null); // below the threshold
assert.equal(boostNoPresenceReject(500, true, false, 100), null); // a website is enough
assert.equal(boostNoPresenceReject(500, false, true, 100), null); // an X account is enough
assert.equal(boostNoPresenceReject(0, false, false, 100), null); // no boost: not this rule's business
// unknown never blocks: no boost data, no social data (DexScreener not hydrated), rule off
assert.equal(boostNoPresenceReject(null, false, false, 100), null);
assert.equal(boostNoPresenceReject(undefined, false, false, 100), null);
assert.equal(boostNoPresenceReject(500, undefined, undefined, 100), null);
assert.equal(boostNoPresenceReject(500, undefined, false, 100), null); // half-known is still unknown
assert.equal(boostNoPresenceReject(500, false, false, 0), null);

// ---- falling below the 4h high with fading volume
assert.match(dipFadingReject(-17.23, 0.218, 15, 1) ?? '', /17\.2% below the 4h high with volume spike 0\.22x < 1x/); // the Anakin-SOL entry
assert.equal(dipFadingReject(-15, 0.5, 15, 1), null); // exactly 15% is not beyond the limit
assert.ok(dipFadingReject(-15.1, 0.5, 15, 1));
assert.equal(dipFadingReject(-17, 1, 15, 1), null); // volume accelerating (>= 1x) passes
assert.equal(dipFadingReject(-17, 3, 15, 1), null);
assert.equal(dipFadingReject(-10, 0.2, 15, 1), null); // shallow dip: fine
assert.equal(dipFadingReject(null, 0.2, 15, 1), null); // unknown never blocks (the dip gate itself fails closed on a missing 4h high)
assert.equal(dipFadingReject(-30, null, 15, 1), null);
assert.equal(dipFadingReject(-30, Number.NaN, 15, 1), null);
assert.equal(dipFadingReject(-30, 0.1, 0, 1), null); // 0 = off

// ---- sell:buy 1h
assert.match(sellBuyReject(0.386, 1.5) ?? '', /sell:buy 1h 1\.59 > 1\.5/); // Anakin-SOL buyRatio1h 0.386
assert.equal(sellBuyReject(0.4, 1.5), null); // exactly 1.5
assert.ok(sellBuyReject(0.39, 1.5));
assert.equal(sellBuyReject(0.5, 1.5), null);
assert.equal(sellBuyReject(0.9, 1.5), null);
assert.ok(sellBuyReject(0, 1.5)); // only sells
assert.equal(sellBuyReject(undefined, 1.5), null); // unknown never blocks
assert.equal(sellBuyReject(Number.NaN, 1.5), null);
assert.equal(sellBuyReject(0.1, 0), null); // 0 = off

// ---- post-pump bag: price already far above its 48h low (real closed trades 16 Oct-2 Nov: FTR 4892%, ヤギ 978%, Anakin-SOL 906% all lost >= 14%)
assert.match(pumpedBagReject(905.91, 800) ?? '', /905\.9% above its 48h low >= 800%/); // Anakin-SOL
assert.ok(pumpedBagReject(800, 800)); // boundary rejects
assert.equal(pumpedBagReject(799.9, 800), null);
assert.equal(pumpedBagReject(128, 800), null); // typical entry (median 128%)
assert.equal(pumpedBagReject(-5, 800), null);
assert.equal(pumpedBagReject(null, 800), null); // unknown never blocks (the candle context can fail)
assert.equal(pumpedBagReject(undefined, 800), null);
assert.equal(pumpedBagReject(Number.NaN, 800), null);
assert.equal(pumpedBagReject(5000, 0), null); // 0 = off

// ---- entry floor on the REAL 24h fee/TVL, the same figure and threshold the meridian low-yield exit uses (13 of 95 closed trades exited by it at minute 61)
assert.match(lowYieldEntryReject(3.98, 7) ?? '', /low yield: fee\/TVL 24h 3\.98% < 7% \(the low-yield exit would close it/); // GATO-SOL 4 Nov
assert.ok(lowYieldEntryReject(6.99, 7));
assert.equal(lowYieldEntryReject(7, 7), null); // exactly the threshold passes (the exit rule closes only BELOW it)
assert.equal(lowYieldEntryReject(13.64, 7), null);
// a strong 4h x 6 number does not rescue a weak 24h one: only the 24h figure is passed in, so 24h 4.56 is rejected whatever the 4h says
assert.ok(lowYieldEntryReject(4.56, 7));
assert.equal(lowYieldEntryReject(null, 7), null); // unknown never blocks (the exit rule also skips an unknown yield)
assert.equal(lowYieldEntryReject(undefined, 7), null);
assert.equal(lowYieldEntryReject(Number.NaN, 7), null);
assert.equal(lowYieldEntryReject(1, 0), null); // threshold 0 = off
assert.equal(lowYieldEntryReject(0, 7) !== null, true); // a real zero is a dead pool

// ---- social presence from the DexScreener pairs of a token
const withInfo = (websites: { url?: unknown }[], socials: { type?: unknown; url?: unknown }[]) => [{ info: { websites, socials } }];
assert.deepEqual(socialPresence(withInfo([{ url: 'https://anakin.xyz' }], [{ type: 'twitter', url: 'https://x.com/anakinsol' }])), { hasWebsite: true, hasX: true });
assert.deepEqual(socialPresence(withInfo([], [{ type: 'telegram', url: 'https://t.me/anakin' }])), { hasWebsite: false, hasX: false }); // telegram only
assert.deepEqual(socialPresence([{}]), { hasWebsite: false, hasX: false }); // pair data without a profile
assert.deepEqual(socialPresence(withInfo([{ url: '' }, {}], [{ type: 'twitter', url: 'https://x.com/i/communities/123' }])), { hasWebsite: false, hasX: false }); // empty url / a community page is not an account
assert.deepEqual(socialPresence(withInfo([], [{ type: 'twitter', url: 'https://twitter.com/Anakin_SOL' }])), { hasWebsite: false, hasX: true });
assert.deepEqual(socialPresence(withInfo([], [{ url: 'https://x.com/someone' }])), { hasWebsite: false, hasX: true }); // recognised by host when the type is missing
// any pair of the token can carry the profile
assert.deepEqual(socialPresence([{}, { info: { websites: [{ url: 'https://a.io' }] } }]), { hasWebsite: true, hasX: false });
assert.equal(socialPresence(undefined), undefined); // no pair data at all: unknown
assert.equal(socialPresence([]), undefined);

// ---- conservative defaults (unless the environment overrides them)
if (process.env.ENTRY_BOOST_MIN_NO_PRESENCE === undefined) assert.equal(env.ENTRY_BOOST_MIN_NO_PRESENCE, 100);
if (process.env.ENTRY_DIPFADE_MAX_BELOW_PCT === undefined) assert.equal(env.ENTRY_DIPFADE_MAX_BELOW_PCT, 15);
if (process.env.ENTRY_DIPFADE_MIN_SPIKE === undefined) assert.equal(env.ENTRY_DIPFADE_MIN_SPIKE, 1);
if (process.env.ENTRY_MAX_SELL_BUY_1H === undefined) assert.equal(env.ENTRY_MAX_SELL_BUY_1H, 1.5);
if (process.env.ENTRY_ENFORCE_MIN_FEE_TVL === undefined) assert.equal(env.ENTRY_ENFORCE_MIN_FEE_TVL, true);
if (process.env.ENTRY_MAX_ABOVE_LOW_48H_PCT === undefined) assert.equal(env.ENTRY_MAX_ABOVE_LOW_48H_PCT, 800);
console.log('OK: entry risk gates (boost without presence, fading dip, sell:buy) + social presence');
