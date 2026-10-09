#!/usr/bin/env bash
# Run synthetic SQL-only tests in a strictly verified LOCAL PostgreSQL cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$ROOT" = '/workspaces/KVRN-/kvrn-merged-staging' ]] || { echo "STOP: wrong source root $ROOT"; exit 2; }
cd "$ROOT"
[[ -d node_modules/pg ]] || { echo 'STOP: existing pg dependency missing'; exit 3; }
[[ -f db/migrations/065_cp56_checkout_lock_order_and_provider_marker.sql ]] || { echo 'STOP: missing CP56 migration'; exit 4; }
for f in .env .env.local .env.production .env.production.local .dev.vars; do
  [[ ! -e "$f" ]] || { echo "STOP: sensitive env file in staging: $f"; exit 5; }
done
LOG=/tmp/kvrn-cp56-concurrency.log
set +e
env -i HOME="$HOME" PATH="$PATH" CI=1 NODE_ENV=test \
  node scripts/cp56-isolated-concurrency.mjs >"$LOG" 2>&1
rc=$?
set -e
tail -n 32 "$LOG"
echo "CP56 concurrency exit code: $rc; complete log: $LOG"
exit "$rc"
