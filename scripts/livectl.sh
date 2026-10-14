#!/bin/sh
# Runs a command with .env.live loaded (the wallet key stays in this child only, never in the Telegram notifier).
cd "$(dirname "$0")/.." || exit 1
set -a
. ./.env.live
set +a
exec "$@"
