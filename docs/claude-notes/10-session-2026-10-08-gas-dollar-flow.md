## 2026-10-08 session (continued): gas/slippage quantified (negligible),
   DARK-vs-HIGGS explained (range mode working as designed), a real $
   buy/sell blind spot found + a new signal shipped for it, and — found
   WHILE validating that new signal — a severe pre-existing stuck-funds bug
   on every position close, now fixed

Direct continuation of the same real-money run (same wallet, same `range`
mode). User picked option (a) above (accept the thin ~0.09 SOL reserve),
bot relaunched on it, then asked a series of analysis questions that led to
real findings.

**1. Quantified gas + slippage — neither explains the -11% all-time
loss.** Pulled every on-chain tx since the 10:32 UTC restart directly (not
estimated): **total gas paid since then: 0.000808854 SOL (~$0.09)** across
36 landed transactions — most of the night's "failed retry" drama never
actually landed on-chain at all (Solana doesn't charge for a
simulation-rejected or never-confirmed send), so it cost zero, just time.
Separately computed **slippage** by comparing each swap's Jupiter-quoted
`outAmount` (already logged) against the REAL on-chain balance delta
received: **0.000811146 SOL (~$0.09) total across 16 swaps**, average
0.008%/swap. Combined, gas+slippage is under $0.20 for the whole run —
execution quality is excellent. The real loss is 100% coming from token
price action itself (the entry-near-rollover pattern already on file), not
transaction costs.

**2. Explained why the bot picked HIGGS-SOL over DARK-SOL re-pumping.**
Traced the exact scan (`02:17:16`, only 1/200 pools passed — not a
head-to-head ranking, DARK simply wasn't a candidate that tick). DARK's
6-hour HARD_EXIT blacklist (from the earlier phantom-loss bug) had JUST
expired 25 minutes before the scan, but that SAME `executeHardExit` also
armed the chase guard on DARK's mint (`recordExitForChaseGuard` — DARK's
price never dipped back to the exit level since, so it's likely still
guarded). Independently confirmed LIVE: DARK's 6h change was +123% at
check time — 8x past `RANGE_MAX_VOLATILITY_PCT` (15%) — range mode would
reject it outright on the ceiling alone regardless of the chase guard.
Two independent mechanisms both correctly declining a move this violent;
working exactly as designed, not a bug. (Catching a move like this is
`trend` mode's job, not `range`'s.)

**3. Found a real blind spot in `buyRatio1h`, user's own observation.**
User noticed HIGGS-SOL's tx-count buy ratio looked healthy (buys actually
outnumbered sells at every window: h1 145/148, h6 904/792, h24 4975/4546)
while its price fell hard the whole time (-9%/-10%/-37%). Confirmed in
code: `meteoraScanner.ts`'s `buyRatio1h = h1Txns.buys / (h1Txns.buys +
h1Txns.sells)` is a pure transaction-COUNT ratio — structurally blind to
"many small buys vs a few large sells" (classic whale-dump signature).
DexScreener/Meteora's public REST APIs expose only tx counts and an
undifferentiated total volume, no $ split by side — the only real fix is
reading on-chain reserve-account balance deltas directly.

**Shipped `src/services/flowAnalysis.ts` (`getDollarVolumeBuyRatio` /
`classifyDollarFlow`)** — reads a pool's own SOL-side reserve account's
recent balance history directly via RPC, classifies each transaction as
buy (SOL reserve increased) or sell (decreased), and computes a genuine
$-weighted ratio. Deliberately scoped LAZY per user's explicit choice (not
applied to the full ~200-pool scan, which would re-trigger this session's
RPC 429-storms): only checked for (a) the single top candidate right
before actually entering, and (b) the currently-held position on a
periodic timer (`OPPORTUNITY_SCAN_INTERVAL_MS`, runs for ANY
`ENTRY_STRATEGY_MODE` — unlike the momentum-only switch check, whale-dump
detection is a general risk signal). New `MIN_DOLLAR_BUY_RATIO` (env.ts,
default 0.4). `PoolContext` gained `reserveSolAccount` (threaded through
`openInitialPosition`). Self-check: `checkDollarFlow.ts`.

**4. The new signal's FIRST live trigger exposed something much worse.**
At `04:28:52`, it fired on the held BATON-SOL position: `buyRatioUsd: 0,
sellVolumeUsd: $3.08, txSampled: 1` — a single $3 sample, clearly too thin
to act on (root cause: most real swap activity routes through Address
Lookup Tables, which `getAccountKeys()` wasn't resolving — the reserve
account was invisible in `staticAccountKeys` for almost every transaction,
undercounting severely). The bot exited BATON on this near-zero-data
signal. **While investigating this false positive, a FAR more serious,
PRE-EXISTING bug was found**: the health check right before exit showed
BATON's position worth **1.2968 SOL**; wallet balance right after "TAKE_PROFIT
complete" was only **0.74285859 SOL** — roughly 0.66 SOL unaccounted for.
Pulled the actual close transaction from chain: the position's non-SOL
side returned **8,712.014436 tokens** to the wallet on close, but
`closeAndConvertToSol`'s very next line read the balance via plain
`getTokenBalance()` with NO staleness guard — got back the STALE pre-close
value (**7 raw units**, not 8712 whole tokens) — the exact same
read-after-write RPC race `waitForTokenBalance` already fixed for the
entry/rebalance-swap paths, just never applied to this specific read site
(present since this function was first written, NOT something introduced
by tonight's fee-split feature — the fee-split code just happened to make
the tiny stale "7" value visible in a log line for the first time, which
is how this was noticed). Net effect: 8712 tokens of BATON's mint (~$77,
~0.66 SOL) sat completely unswapped and untracked by `currentCapitalSol` —
**directly causing the very next entry (CRAWL) to open with only half
capital** (user's own observation: "cuma setengah"), exactly matching
`nextCapital` being computed from the already-short wallet balance.

**Fixed, all three, same incident:**
1. `closeAndConvertToSol` and `compoundCycle` (`rebalanceEngine.ts`) both
   now compute an `expectedOtherAmount` (principal+fee, read from
   `position.positionData` BEFORE closing) and use `waitForTokenBalance`
   (95% threshold) instead of a bare `getTokenBalance()` call immediately
   after `closePositionFull`. `compoundCycle`'s `balX`/`balY` read (used by
   BOTH the abandon path and, critically, the normal reopen path's
   `balanceTokenRatio` rebalancing) got the same fix — this bug could have
   silently corrupted the reopen path's 50:50 rebalancing too, not just the
   abandon-and-convert path, though that wasn't directly observed yet.
2. `flowAnalysis.ts` now resolves account indices via
   `getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })`
   (static + lookup-writable + lookup-readonly, in the order that matches
   preBalances/postBalances indexing) instead of `staticAccountKeys` alone.
3. New `MIN_DOLLAR_FLOW_SAMPLE_SIZE` (5) — `classifyDollarFlow` returns
   null (unknown, don't act) below this many classified transactions,
   regardless of how lopsided they look. Self-check updated to cover both
   the pre-fix incident shape (1 sample, still returns null) and the
   boundary (exactly 5 is enough).

**Recovered the stuck funds**: swapped the 8712.014436 BATON tokens back
to SOL directly (independent of the bot process, same pattern as prior
incidents) — **+0.667542749 SOL recovered**, confirmed 0 token balance
remaining afterward (double-checked after a short delay, since the FIRST
balance read in the recovery script itself also returned stale — a live,
in-the-moment reproduction of the exact race this fix addresses).

All fixes verified: `tsc --noEmit` clean, self-checks pass (still 25 —
`checkDollarFlow.ts` updated in place, not added new), `npm run build`
clean. Manually closed the live position (CRAWL,
`52By9szJr4qEnRCgaddfunEFw7o1CqFdfs7ve12oE3je`) before restarting (per the
same no-resume-on-boot discipline as every prior restart this run).

**Still open / not yet re-validated**: whether the `balanceTokenRatio`
corruption risk in `compoundCycle`'s normal reopen path (point 1 above)
ever actually fired silently on a PRIOR close tonight before this fix —
not retroactively checked, flagged here so a future session doesn't assume
every past "nextCapital" figure in this file's logs was necessarily
accurate.

**Live validation after restart (04:48 UTC onward)**: all fixes confirmed
working in the very next scan cycle — `waitForTokenBalance` caught a stale
read during a fresh entry swap and correctly retried (`"balance read below
expected, retrying"`); the dollar-flow pre-entry check skipped 2 real
sell-dominant candidates with healthy sample sizes (9 and 6, not 1); and a
SECOND BATON-SOL dollar-flow exit fired ~1h later with `txSampled:55,
buyRatioUsd:0.002` — a high-confidence, legitimate whale-dump read this
time — and the capital carried over cleanly to the next entry (no more
stuck funds, `nextCapital` even came out slightly ABOVE the pre-close
capital).

**Immediately after, found the dollar-flow window design itself was too
sensitive** — user noticed and asked directly. The original design sampled
"last 60 transactions, whatever time span that happens to cover" — on
BATON-SOL specifically (confirmed live) 60 tx spans only ~8 minutes, so a
brief few-minute flurry could trigger an exit before the picture
stabilizes. Also flagged a related concern: the original per-signature
`getTransaction` loop (up to 60 sequential RPC calls) felt like unnecessary
load. **Both fixed together**: switched to a genuine TIME window (default
1h, matching every other "1h" signal in this codebase) instead of a raw
transaction count, with a `maxTx` hard cap (300) to bound worst-case batch
size on an extremely active pool — `getSignaturesForAddress`'s own
`blockTime` is read for free to determine which signatures fall in the
window BEFORE fetching any transaction detail. Separately, replaced the
sequential `getTransaction` loop with `connection.getTransactions`
(PLURAL) — one batched JSON-RPC request for every sampled signature
instead of N round-trips — a free efficiency win found while answering the
user's RPC-load question, unrelated to the windowing change but landed in
the same pass. No silent truncation: logs a warning if `maxTx` is hit
before the window is fully covered (result is a partial hour, not the
complete picture). Verified: `tsc --noEmit` clean, self-checks pass (still
25 — `classifyDollarFlow`'s own unit tests were unaffected, the window/
batching logic lives in the RPC-calling wrapper which was never unit-tested
to begin with, same as its first version), `npm run build` clean. Not yet
re-validated live on this exact revision as of this write-up — next
restart should confirm the 1h-window behavior live.

**Live validation**: confirmed the TWEETCRAFT-SOL exit at `06:02:54` (right
before this restart) was on the OLD count-based logic (`txSampled:7`,
exited on what turned out to be a short burst while the user says the 1h
picture was still healthy) — a textbook case of exactly the bug the
window-size fix addresses, caught right at the boundary of the old code's
last live use.

