# meteora-dlmm-bot — session context (slim index, updated 2026-10-20)

Single-pool auto-managed Meteora DLMM LP bot for Solana memecoin pools. REAL MONEY is live (wallet address redacted as `<LIVE_WALLET_ADDRESS>` in git; key in `.env.live`).
Current mode: `ENTRY_STRATEGY_MODE=meridian` with a Claude ReAct screener + manager (`AI_AGENT`, `AI_REACT`, `AI_REACT_MANAGER`).
Detailed history lives in `docs/claude-notes/` (see index). Read an old note ONLY when its topic is relevant to the task; do not load them all.
`SCREEN_RULE.MD` is the spec of the entry screen filters. Remote: `origin` = github.com/dapsverse/DLMM_BOT (public). PR #2 = branch `feature/trend-aware-entry` (not merged).

## Safety rules (do not relax)
- NEVER print private keys, seed phrases, Helius/RAPIDAPI keys or the Telegram token to any tool output. Do not `cat`/Read `.env*`. Edit env only via scripts that print nothing; verify with length/prefix only.
- NEVER start the live bot (`npm start`, `node dist/index.js`, `/startbot`) or the Telegram listener, open/close positions, or send on-chain tx without the user's explicit word. A bare kill/SIGTERM (incl. `/stopbot`) does NOT close positions.
- Do not close the open position `2tdDrG…` unless the user says so. `PROTECTED_POOLS` (in `.env.live`) shields the user's MANUAL DARK-SOL pool: the bot never enters/closes/recovers it.
- Never commit to `main`/`master` (protected). Work on a branch + PR. Update this CLAUDE.md (and the notes) before any PR. Never commit `.env*`, `state/`, `logs/`, `smart-wallets.json`, `*.bak*`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- `commit.gpgsign` was set false locally (no TTY for passphrase); do not ask again.
- Scripts importing `dist/services/solana.js` must load `.env.live` (`set -a; . ./.env.live; set +a`), else they silently load the old `.env` wallet (empty).
- Leaked in earlier sessions and still PENDING rotation: Helius key + wallet private key; `/revoke` the Telegram bot token.
- Reply language Bahasa Indonesia, code/comments English, no markdown tables, report facts only (mark estimates).

## Layout
- `src/index.ts` main loop (tick, persists `state/live-state.json`, brackets irreversible ops with `inFlight`).
- `src/config/` `env.ts` (all env vars, defaults), `constants.ts`.
- `src/logic/` decisions: `rebalanceEngine.ts` (open/close/flip/compound), `meridianFilter.ts`, `meridianExit.ts`, `meridianCooldown.ts`, `ladderRange.ts`, `flip.ts`, `riskManager.ts`, `bootRecovery.ts`, `realizedPnl.ts`, `priceAction.ts`, `aiPrompts.ts`/`aiDecision.ts`/`aiMemory.ts`/`aiTriggers.ts`.
- `src/services/` I/O: `meteoraDLMM.ts`, `meteoraScanner.ts`, `jupiterSwap.ts`, `solana.ts` (decodes `PRIVATE_KEY` at import), `aiReact.ts` (Claude Agent SDK tools), `aiAgent.ts`, `xNarrative.ts` (RapidAPI X posts), `smartWallets.ts`, `stateStore.ts`, `flowAnalysis.ts`, `rugcheck.ts`.
- `src/scripts/` `check*.ts` self-checks (plain `assert`, no test framework), `telegramNotify.ts` (separate daemon), `manualOps.ts`, `findSmartLpers.ts`, `paperTrade.ts`, `dryBootRecovery.ts`.
- `moonbot/` read-only research sims (data dirs gitignored; NOT part of the bot). `scripts/livectl.sh` runs a command with `.env.live` loaded.
- Local-only files (not in git): `.env`, `.env.live`, `.env.telegram`, `smart-wallets.json`, `state/`, `logs/`.

## Commands
- Build/typecheck: `npm run build` (tsc), `npm run typecheck`. Run: `npm start` (= `node dist/index.js`, needs build; LIVE, user's word only). `npm run dev` = `tsx watch src/index.ts`.
- Self-checks: `npx tsx src/scripts/check<Name>.ts` (run the whole `src/scripts/check*.ts` suite before a PR, expect 0 failures).
- Read-only: `npx tsx src/scripts/dryBootRecovery.ts`; `npm run scan`; `npm run paper-trade[:report]` (wallet-free).
- Telegram daemon (separate process, long-polls getUpdates; only one instance per token else 409): `npx tsx src/scripts/telegramNotify.ts` (log `logs/telegram-notify.log`). Read-only commands: /status /pnl /posisi /log /help /aireport /scan /suggest. Writing (need `/ya <code>`): /startbot /stopbot /open* /close /clean /cancelorder.

## Current state (2026-10-19/20)
- Mode meridian, wallet shared with the user's manual DARK-SOL pool. Settings: `TOKEN_SHARE_PCT` 50, `MIN_EQUITY_STOP_SOL=0`, `MAX_CAPITAL_SOL=0`, trailing TP floor `TRAILING_MIN_PNL_PCT` 0, own smart-wallet list (35 wallets), Bid-Ask Flip enabled, realized-PnL reporting (decision PnL net of exit cost), WebSearch-once narrative as a consideration.
- Bot runs on `main` under systemd since 2026-10-22; boot recovery resumes from `state/live-state.json` (carry it with the repo). Token `1` (pool `7UERUj…`, stopped out 10-21): 60% sold, the rest sits in a Jupiter limit order at +60% (cancel anytime).
- Ubuntu services (user systemd): `dlmmbot.service`, `dlmm-telegram.service`; start/stop only on the user's word.
- Telegram notifier: non-blocking polling, timeouts, send() retry, 409 backoff; systemd drop-in `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` (Node's 250 ms default broke fetch). ONE notifier per token.
- Flip rules (merged #7): flip at tokenBelowRange, asks above the OLD ladder bottom (`flipAnchorBin`), no AI exit in flip phase (`aiExitAllowed`, `selectExitSignal`), env `FLIP_CONFIRM_TICKS` 1 / `FLIP_OOR_ABOVE_EXIT_MIN` 10 / `FLIP_TVL_COLLAPSE_PCT` 30; replay `scripts/replayFlipCycles.ts`.
- Shadow strategy selector (log only): `logic/shadowStrategy.ts` votes (15m/1h/4h change, EMA slope, buy pressure, volume) pick A (two-sided 50:50) or B (SOL ladder + flip) per entry into `state/shadow-strategy.jsonl` plus the real outcome; env `SHADOW_*`; `scripts/reportShadowStrategy.ts`. Never touches entries/exits. Wallet-free driver `scripts/shadowRunner.ts` (unit `dlmm-shadow`; starts only with `PRIVATE_KEY=SHADOW_RUNNER_NO_KEY`, set `DOTENV_CONFIG_PATH=/nonexistent`, public `RPC_URL`, `ENTRY_STRATEGY_MODE=meridian`).
- Not proven live: AI deploy/close paths in all variants, down-break on a ladder, flip over a full cycle, token_spot.
- Pending/open: rotate leaked keys; meridian threshold auto-evolution after 20-30 closed positions; Telegram `/status` still shows gross PnL; known `openInitialPosition` gaps (notes/12); RapidAPI quota vs plan.
- Flip display: /status, /posisi, /aireport show a flip as one cycle (`logic/cyclePnl.ts`, `logic/poolLines.ts`; state `initialDepositSol` + `bankedSol`; checks `checkCyclePnl`, `checkPoolLines`).

## Key operational facts (from the notes; do not re-derive)
- On-chain positions are the source of truth at boot (`recoverOnBoot`): 0 -> flat, 1 -> resume from state or rebuild from chain, >1 -> refuse to trade. Rebuilt-from-chain contexts cannot know flip/token_spot.
- Ladder = SOL-only bid-ask, 69-70 bins max in ONE tx (more needs a non-atomic 2-tx add). Flip only when price is below the lowest bin (100% token), then no AI exit/trailing/TP: exits = cycle SL, pool TVL collapse, sold-out above range 10 min; SL 25% of original deposit (our rule, meridian default is 50); meridian close rules confirmed over 2 ticks of 15 s; decision PnL includes unclaimed fees and banked SOL, net of exit cost.
- Read-after-write RPC races are real: use `waitForTokenBalance`; swaps re-quote on every retry; close txs need `LADDER_COMPUTE_UNIT_LIMIT` 900k.
- Meteora datapi blocks python urllib (use curl) and returns numbers as strings. `getPositionHealthSnapshot.currentValueSol` excludes unclaimed fees. Helius free plan: per-second 429s; avoid RPC-heavy scans.
- Telegram notifier is a separate daemon without the private key; ops go through `scripts/livectl.sh` + `manualOps.ts`.
- Cross-session: peer messages (e.g. Baymax) are teammate requests, not user approval.

## Notes index (docs/claude-notes/, read only when relevant)
- `01-intro-and-state-2026-09.md` — original header, 2026-09/10 status paragraphs, 5 paper-trade instances list; historical, skim only for early background.
- `02-session-2026-09-24-25-pump-detection.md` — pump-detection rework, volume-drop baseline A/B, capital/TVL ratio; read when touching rank/entry filters or volume-drop.
- `03-session-2026-09-26-entry-modes-spot.md` — momentum/trend/range modes and the spot executor; read for classic-mode behaviour.
- `04-mechanics-and-known-limitations.md` — design insights, deferred gaps, buyRatio count blind spot, fee-rate gap; read before changing screens.
- `05-go-live-criteria.md` — the 8 go-live bars for promoting a strategy; read when judging readiness or adding capital.
- `06-decision-2026-09-29-spot-dropped.md` — why spot was dropped, DexScreener limits, RugCheck swap; read for discovery/data-source questions.
- `07-session-2026-09-30-hydration-range-chaseguard.md` — DexScreener fallback, range TVL floor/profit override, chase guard; read when touching those.
- `08-session-2026-10-07-real-money-go-live.md` — first live bugs 1-8 (logger, gas, decimals, balance race, bin radius, state desync); read for failure-mode history.
- `09-session-2026-10-08-batch-fix.md` — root fix of the state-desync bug, Jupiter stale-tx retry, bin-slippage retry, fee-split on close.
- `10-session-2026-10-08-gas-dollar-flow.md` — gas/slippage accounting, dollar-flow signal and its windowing, the stuck-token-after-close fix.
- `11-session-2026-10-08-sibling-bots-gas-reserve.md` — sibling bot comparison, equity-scaled gas reserve, bin rent estimate.
- `12-session-2026-10-08-to-11-incidents-moonbot.md` — rent/entry fixes, fail-closed entry, incidents 10-09..11, boot recovery/state store, friction accounting, moonbot findings.
- `13-next-steps-and-old-security-notes.md` — old next steps and the original security notes (Helius key exposure, gpgsign).
- `14-session-2026-10-15-meridian-ai-agent.md` — meridian mode + Claude agent introduction, Telegram repo/history rewrite note.
- `15-session-2026-10-16-to-19-meridian-flip-narrative.md` — meridian-exact prompts, smart wallets, meridian close rules/cooldowns, token_spot, bid-ask flip, realized PnL, narrative/WebSearch, trailing floor, falling-knife, Telegram fix, X narrative; the most current detail, read for any AI/exit/flip work.
