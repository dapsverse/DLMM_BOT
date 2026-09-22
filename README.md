# meteora-dlmm-bot

Single-pool auto-compounding LP bot for Meteora DLMM pools on Solana.

## Strategy

- Holds capital in **one pool at a time** (`MAX_CONCURRENT_POOLS=1`) — capital efficiency over diversification.
- Starts with `INITIAL_LP_CAPITAL_SOL` (default 4.2 SOL) as LP capital; `MIN_GAS_RESERVE_SOL` (default 0.8 SOL) always stays in the wallet, untouched by LP deposits.
- Every rebalance/compound cycle: close position → claim fees → reclaim rent → swap 50:50 via Jupiter → reopen at the new active bin. Profit compounds into the next position size.
- Hard-exits (dumps to SOL, blacklists the pool 6h) on: ≥25% unrealized loss, >3 rebalances/hour, or a >60% 1h volume crash.

See `src/config/env.ts` and `.env.example` for every tunable threshold.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `RPC_URL` — a paid RPC endpoint is strongly recommended (public mainnet-beta RPC rate-limits aggressively; `getRecentPrioritizationFees`/frequent polling will get throttled).
- `PRIVATE_KEY` — base58-encoded secret key of the trading wallet. **Fund this wallet with exactly what you intend to risk.** Never reuse a wallet holding unrelated funds.

```bash
npm run typecheck   # verify types without emitting
npm run dev          # run with tsx, auto-restart on file change
npm run build        # compile to dist/
npm start            # run compiled dist/index.js
```

## Before running on mainnet with real capital

The SDK wrapper in `src/services/meteoraDLMM.ts` was written against the documented `@meteora-ag/dlmm` v1.9.x API surface. SDK instruction-builder names have moved before across minor versions. Before funding the wallet:

1. `npm install`, then diff the wrapper's method calls against `node_modules/@meteora-ag/dlmm/dist/**/*.d.ts` for the version actually installed.
2. Run once against a **devnet** pool (or a tiny mainnet position, a few dollars) end-to-end: open → claim → close → reopen. Confirm rent comes back and balances match expectations.
3. Review `src/logic/rebalanceEngine.ts` — pricing is done in SOL terms using the pool's active-bin price, which assumes standard token decimals. Sanity-check the computed SOL-equivalent values against a block explorer before trusting the compound sizing.

## VPS Deployment

Any small VPS (1 vCPU / 1GB RAM is enough — this is I/O-bound, not compute-bound) works. Example with `pm2`:

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name meteora-dlmm-bot
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

Logs land in `LOG_DIR` (default `./logs`) as JSON (`combined.log`, `error.log`), plus colorized console output — `pm2 logs meteora-dlmm-bot` tails the latter.

**Operational safety:**
- Keep `.env` out of version control (already in a typical `.gitignore`; double-check before pushing).
- Monitor wallet balance externally too — the bot enforces `MIN_GAS_RESERVE_SOL` but a stuck/failed transaction can still eat into it faster than expected under fee spikes.
- `MAX_REBALANCE_PER_HOUR` and the cooldown guard are the two brakes against fee-bleed in a whipsawing pool; don't raise them without understanding why the default is conservative.

## Directory layout

```
src/
├── config/     env validation (env.ts) + static constants (constants.ts)
├── services/   Solana connection, Meteora DLMM SDK wrapper, Jupiter swap, pool scanner
├── logic/      rebalance/auto-compound engine, risk manager (HOLD/REBALANCE/HARD_EXIT)
├── utils/      winston logger (secret-redacting), retry/backoff helper
└── index.ts    main loop
```
