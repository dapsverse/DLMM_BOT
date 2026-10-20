## 2026-09-29 decision: spot executor dropped, focus narrowed to DLMM only

User asked why the scanner only ever looks at Meteora-listed tokens even
though a token can trade on Raydium/PumpSwap/pump.fun long before (or
without ever) getting a Meteora DLMM pool. Investigated whether to broaden
discovery beyond Meteora's own `/pools` API, specifically for the spot
executor (which doesn't need a Meteora pool at all — it can buy anything
via Jupiter). Findings (full research trail in conversation history, not
reproduced here):

- **DexScreener cannot replace Meteora's `/pools` as a discovery source.**
  Confirmed against current docs (docs.dexscreener.com/api/reference,
  2026-09-29) and live: it has no "list/browse pairs" endpoint at all —
  only token/pair-address lookup and free-text search. Tried the obvious
  workaround (`q=solana`) live — returned wrapped-SOL pairs on Base/
  Ethereum/BSC, not Solana pairs at all. Also tried its internal
  (undocumented) API directly — `io.dexscreener.com/dex/screener/...` — got
  an immediate Cloudflare 403, i.e. actively bot-blocked, not just
  unsupported. Not viable at any reliability level.
- **Real alternatives exist** (Raydium's own `/pools/info/list` API — free,
  official, sortable by volume/liquidity; pump.fun — unofficial only, or
  paid third-party wrappers like Solana Tracker/Codex for genuine
  pre-graduation bonding-curve discovery) but each adds either a new paid
  vendor dependency or an unsupported/breakable API — a real cost/risk
  trade-off, not a free win.
- **Reframe (user's own conclusion, and the actual reason to stop here):**
  Meteora-only discovery is not an arbitrary limitation for the DLMM
  execution path — DLMM *requires* a Meteora pool to exist, so discovery
  and execution are already coherent for `range`/`momentum` modes. It's
  ONLY a real limitation for spot, which doesn't need Meteora at all. Since
  broadening spot's universe isn't cheaply achievable, and spot had
  separately been the worst performer all session (see `trend-optAB-spot`'s
  -77%+ run above) — **decision: drop the spot executor entirely, focus
  exclusively on DLMM `range` vs `momentum`.** `ENABLE_SPOT_EXECUTOR` stays
  in the codebase (still a valid toggle, still tested by
  `checkSpotExecutor.ts`) but no running instance uses it going forward
  unless this decision is revisited.

**Related fix landed same session** (real bug, not just the above
architecture question): `hydrateTrendData`/`getVolume1hUsd` queried
DexScreener by token mint, and DexScreener returns pairs from ALL DEXs a
mint trades on — the old "first match wins" behavior could hydrate a thin
Meteora pool's trend/momentum/crash-guard/volume-drop signals from a
completely different (possibly much busier) DEX's activity for the same
token. Fixed by filtering to `dexId === 'meteora'` specifically (DexScreener
pair objects already carry this field, just wasn't being used). TVL/volume
screening itself was never affected — that comes straight from Meteora's
own `/pools` API, only the DexScreener-sourced enrichment fields had this
gap.

**Current running instances as of this decision**: `range-optAB` (DLMM,
`range` mode) and `momentum-optAB` (DLMM, `momentum` mode, default —
active `evaluateSwitchOpportunity` switching, the one mode that has it),
both restarted fresh on the dexId fix. `trend-optAB-spot` killed, all its
logs deleted (not archived — decision is to drop it, not revisit later
without a fresh reason to). ADVANCEBOT's `vs-dlmmbot` ladder instance is
unaffected by this decision (separate codebase/strategy) and keeps running.

**Update same day, few hours later**: the Helius RPC key hit its limit
(sustained, non-recovering 429s for ~4.78h, confirmed zero progress across
ALL instances including ADVANCEBOT — worse than every prior burst this
session, which always settled within minutes). User swapped in a fresh
Helius key (both DLMMBOT's and ADVANCEBOT's `.env` `RPC_URL` updated,
value deliberately never printed to any tool output per the standing
secrets-handling rule) and asked to restart again, PLUS add two more DLMM
instances at **90 SOL capital** (`range-optAB-90sol`, `momentum-optAB-90sol`
— same modes/config as the 1.2 SOL pair, just `INITIAL_LP_CAPITAL_SOL=90`)
to see how the same strategies behave at a materially different capital
scale (90 SOL pushes the `MAX_CAPITAL_TVL_RATIO_PCT` floor ~75x higher than
at 1.2 SOL, likely a very different reachable pool universe). All 4 DLMM
instances + ADVANCEBOT restarted fresh on the new key.

**Same session, ~1.5h later — the REAL root cause found and fixed**: even
on the fresh Helius key, all 4 DLMM instances stayed at 429 storm /
zero-entries for 1.35h+ (1000+ 429s each) while ADVANCEBOT (same key) was
fine — pointed at DLMMBOT-specific RPC load, not the key itself. Traced to
`hydrateMintAuthority`'s per-candidate-pool direct Solana RPC `getMint`
call (rpc.ts's `isMintAuthorityRevoked`) — 4x the instances now running
this in parallel per scan tick was the dominant Helius load. Replaced with
RugCheck.xyz's free, unauthenticated single-token report API
(`src/services/rugcheck.ts`, `isMintAuthorityRevokedViaRugCheck`) — same
fail-closed-on-failure contract, verified live against a revoked mint
(BONK) and non-revoked one (USDC) before shipping. Old RPC version deleted
entirely (zero callers after the swap). Moves this load to a completely
separate rate-limit bucket instead of Helius. **Confirmed fixed**: 0 429s
across all 4 instances within 15s of restarting on the fix (previously
1000+ within 1.35h on the same fresh key). All 4 DLMM instances restarted
again on this fix; ADVANCEBOT untouched (separate codebase, wasn't
affected by this specific bug). **Go-live window clock restarted one more
time from this point** (2026-09-29 ~06:49 UTC — 3 days still lands
2026-10-02, Friday). This should be the last restart before the window
counts for real — infra is now believed stable.
**Superseded same day — see "2026-09-30 session" below: 3 more real bugs
were found and fixed that same infra-stable window, restarting the clock
again to 2026-09-30 ~00:02 UTC, which now misses the Friday target
(lands 2026-10-03, Saturday instead).**

