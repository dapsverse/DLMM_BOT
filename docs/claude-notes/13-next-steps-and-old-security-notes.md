## Next steps

1. **Let the 4 running instances keep going** on the combined dexId-fallback
   + range TVL/profit-override + chase-guard fixes — this is now the
   cleanest run of the session (fewest known bugs). Watch for: does
   `range-optAB`'s TVL floor keep it out of another o-SOL-style disaster;
   does the range-ceiling profit override actually let a future winner run
   further without giving back the gain on a reversal that never comes back
   (the symmetric risk the user flagged); does momentum's chase guard
   actually stop a repeat of the SI-SOL buy-high pattern; does `range`
   keep beating `momentum` at both capital scales now that the TVL floor
   is capital-scale-independent.
2. **Chase guard is paper-trade + real-bot code-complete but the real bot
   has never executed a single real transaction** — first real use will be
   whatever pool it first tries to exit, so there's no live-fire validation
   of the `getCurrentPriceUsd()` lookup path yet, only the self-check.
3. Decide on the still-open spec gaps: `HARD_EXIT` profit-guard, absolute
   switch-margin floor (both from 2026-09-23), the volume-drop Option A/B
   magnitude (currently 1h, arbitrary), and now also whether `trend`/`range`
   should become the new defaults (or stay opt-in tracks) once more data
   exists.
4. Once behavior looks solid over a longer window across multiple episodes
   (not just one): re-check `.env.live` wallet balance, decide on a first
   real cycle. Same "no devnet dry-run, watch the first cycle closely"
   plan as every prior session — nothing about that has changed.

## Security notes (do not relax these)

- Never print/echo the private key or the Helius API key to any tool
  output. `.env` and `.env.live` are both gitignored.
- One Helius API key WAS exposed once this session via an automatic
  tool-diff notification (see "Where things stand" above) — not rotated
  per user's call, flagged here so it isn't forgotten.
- `commit.gpgsign` is `true` in this machine's global git config; set to
  `false` **locally for this repo only** to unblock commits in this
  sandbox (no TTY for the passphrase prompt) — already done, don't
  redo/ask again unless a fresh clone needs it too.

