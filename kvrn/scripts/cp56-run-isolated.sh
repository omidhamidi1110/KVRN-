#!/usr/bin/env bash
# CP56 local-only runner. Existing staging source is NOT reset, no provider I/O.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for f in .env .env.local .env.production .env.production.local; do
  if test -f "$f"; then echo "STOP: $f detected (no production env files permitted)" >&2; exit 1; fi
done
if test "$(pwd -P)" != /workspaces/KVRN-/kvrn-merged-staging; then
  echo 'STOP: run only in /workspaces/KVRN-/kvrn-merged-staging' >&2; exit 1
fi
printf '%s\n' '=== CP56 isolated finance/marketing PostgreSQL concurrency ==='
env -i HOME="$HOME" PATH="$PATH" NODE_ENV=test \
  node scripts/cp56-finance-races.mjs 2>&1 | tee /tmp/kvrn-cp56-finance.log
printf '%s\n' '=== CP56 Cloudflare/OpenNext BUILD ONLY (NO DEPLOY) ==='
if ! env -i HOME="$HOME" PATH="$PATH" CI=1 NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 npm run cf:build > /tmp/kvrn-cp56-cf-build.log 2>&1; then
    tail -n 45 /tmp/kvrn-cp56-cf-build.log
    echo 'FAIL: Cloudflare build. No deploy attempted.' >&2
    exit 1
fi
tail -n 14 /tmp/kvrn-cp56-cf-build.log
node scripts/cp56-cloudflare-artifact-audit.mjs \
  2>&1 | tee /tmp/kvrn-cp56-artifacts.log
printf '%s\n' '=== CP56 isolated checks completed; NOTHING deployed ==='
