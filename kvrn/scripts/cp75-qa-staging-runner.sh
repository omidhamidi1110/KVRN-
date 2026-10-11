#!/usr/bin/env bash
# Owner-controlled staging QA only. No production browser navigation or database writes.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${KVRN_BROWSER_BASE_URL:-}" ]]; then
  echo 'STOP: set KVRN_BROWSER_BASE_URL to a verified isolated staging HTTPS origin or localhost.' >&2
  exit 2
fi
# Run the existing production prohibition BEFORE loading Playwright, testing or posting.
node -e '
let u;try{u=new URL(process.env.KVRN_BROWSER_BASE_URL)}catch{process.exit(2)}
const loop=["localhost","127.0.0.1"].includes(u.hostname);
if ((!loop&&u.protocol!=="https:") || (/\b(kvrn\.shop)$/i.test(u.hostname)) ||
    u.pathname!=="/" || u.search || u.hash || u.username || u.password || u.origin+"/"!==u.href.replace(/\/$/,"/") ||
    (loop&&!["http:","https:"].includes(u.protocol))) {
  console.error("REFUSED: staging origin required. Never run browser tests against kvrn.shop.");process.exit(2)
}
' || { echo 'Invalid or unsafe target. No QA run started.' >&2; exit 2; }

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/kvrn-cp75-qa.XXXXXX")"
chmod 700 "$run_dir"
trap 'rm -rf "$run_dir"' EXIT
export KVRN_BROWSER_OUTPUT="$run_dir/browser.json"
export KVRN_QA_REPORT_OUTPUT="$run_dir/report.json"
export KVRN_SMOKE_OUTPUT="$run_dir/no-smoke-results.json"
export KVRN_JEST_OUTPUT="$run_dir/no-jest-results.json"
export KVRN_QA_PUBLIC_ONLY=true
export QA_TRIGGER_TYPE=manual
export QA_ENVIRONMENT=preview
export QA_COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"

echo 'Running NON-DESTRUCTIVE browser smoke on staging only. Cart/checkout will be skipped.'
status=0
node scripts/browser-smoke.mjs || status=$?
export QA_BROWSER_OUTCOME=$([[ "$status" == 0 ]] && echo success || echo failure)
node scripts/build-qa-report.mjs
node - "$KVRN_QA_REPORT_OUTPUT" <<'NODE'
const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[2]));
console.log(`Recorded staging QA results (local): ${r.passedCount} pass, ${r.failedCount} fail, ${r.skippedCount} skip; ${r.results.length} test contracts.`);
if(!r.results.length) { console.error('No evidence to report.'); process.exit(2) }
NODE

if [[ "${CP75_SUBMIT_QA_REPORT:-no}" != yes ]]; then
  echo 'NOT SUBMITTED: production QA database untouched.'
  echo 'To post verified staging results, obtain explicit owner approval and configure the report-only secret.'
  exit "$status"
fi

# This POST writes only the existing QA-report ledger; it does not run tests in production.
if [[ -z "${QA_REPORT_SECRET:-}" ]]; then
  read -r -s -p 'QA_REPORT_SECRET (input hidden): ' QA_REPORT_SECRET
  echo
fi
if [[ -z "$QA_REPORT_SECRET" ]]; then echo 'Missing QA report secret. No data sent.' >&2; exit 3; fi
report_url="${CP75_QA_REPORT_URL:-https://kvrn.shop/api/internal/qa-report}"
if [[ "$report_url" != 'https://kvrn.shop/api/internal/qa-report' ]]; then
  echo 'QA reporting endpoint does not match the allowlist. No data sent.' >&2; exit 3
fi
header_file="$run_dir/qa_headers"
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$QA_REPORT_SECRET" > "$header_file"
chmod 600 "$header_file"
unset QA_REPORT_SECRET
curl --fail-with-body --silent --show-error --max-redirs 0 --max-time 25 \
  --request POST --header @"$header_file" --data-binary @"$KVRN_QA_REPORT_OUTPUT" "$report_url"
echo
echo 'QA report POST finished. Verify corresponding run and contracts in AI Operations > QA.'
exit "$status"
