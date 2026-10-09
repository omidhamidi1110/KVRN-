#!/usr/bin/env bash
# LOCAL ARTIFACT BUILD ONLY. NO deployment, live credentials, or provider writes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
EXPECTED='/workspaces/KVRN-/kvrn-merged-staging'
[[ "$ROOT" = "$EXPECTED" ]] || { echo "STOP: must run in $EXPECTED; got $ROOT"; exit 2; }
cd "$ROOT"
for file in .env .env.local .env.production .env.production.local .dev.vars .dev.vars.production; do
  [[ ! -e "$file" ]] || { echo "STOP: unexpected environment file $file"; exit 3; }
done
[[ -x node_modules/.bin/opennextjs-cloudflare ]] || { echo 'STOP: existing npm dependencies missing (no automatic download)'; exit 4; }
[[ "$(node -p 'require("./package.json").scripts["cf:build"]')" = 'npx opennextjs-cloudflare build' ]] || { echo 'STOP: unexpected build script'; exit 5; }
[[ -f cloudflare-cron-wrapper.js && -f wrangler.toml ]] || { echo 'STOP: missing required wrapper/config'; exit 6; }
grep -q 'main *=[[:space:]]*"cloudflare-cron-wrapper.js"' wrangler.toml || { echo 'STOP: unexpected Worker entry point'; exit 7; }
grep -q '\./\.open-next/worker.js' cloudflare-cron-wrapper.js || { echo 'STOP: wrapper not importing built worker'; exit 8; }
mkdir -p /tmp
LOG=/tmp/kvrn-cp56-cloudflare-build.log
echo 'START: scrubbed-environment Cloudflare/OpenNext BUILD ONLY (never deploy)'
if env -i HOME="$HOME" PATH="$PATH" CI=1 NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production \
  npm run cf:build >"$LOG" 2>&1; then
  echo 'PASS: npm run cf:build returned 0'
else
  rc=$?
  echo "FAIL: cf:build exited $rc; diagnostic log: $LOG"
  tail -n 55 "$LOG"
  exit "$rc"
fi
[[ -s .open-next/worker.js ]] || { echo 'FAIL: .open-next/worker.js missing or empty'; exit 9; }
[[ -d .open-next/assets ]] || { echo 'FAIL: .open-next/assets missing'; exit 10; }
[[ -d .open-next/assets/_next/static ]] || { echo 'FAIL: static chunks missing in asset directory'; exit 11; }
for folder in images-r images/products images/campaign; do
  if [[ -d "public/$folder" ]]; then
    [[ -d ".open-next/assets/$folder" ]] || { echo "FAIL: public/$folder not packaged"; exit 12; }
  fi
done
# The project's public marketing/product files MUST survive the build; no upload or mutation.
for source in public/images/campaign/hero-main.webp public/images/products/project-kvrn-heavyweight-hoodie/1.webp; do
  [[ ! -f "$source" || -s ".open-next/assets/${source#public/}" ]] || { echo "FAIL: $source absent from Worker assets"; exit 13; }
done
printf 'PASS: generated worker size %s bytes\n' "$(wc -c < .open-next/worker.js)"
printf 'PASS: asset file count %s\n' "$(find .open-next/assets -type f | wc -l)"
echo "PASS: built OpenNext Worker and static assets; log: $LOG"
echo 'NO DEPLOYMENT EXECUTED. Edge runtime, R2 and browser E2E still require separate verification.'
