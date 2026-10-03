#!/usr/bin/env bash
# scripts/test-021-fixtures.sh
#
# Runner for the migration-021 (financial integrity) PostgreSQL fixtures.
#
# The fixture is STANDALONE: it builds its own products, orders, refunds, disputes,
# affiliates, expenses and history on a database that has had migrations 001..latest
# applied. It runs on a GENUINELY FRESH database, once, under ON_ERROR_STOP=1, and
# the psql PROCESS EXIT CODE is the only authority. The database is dropped on exit
# so repeated runs never accumulate state or hide a failure.
#
# It also reapplies migration 021 several times on the finished database and checks
# that the scan result is byte-identical afterwards (idempotency).
#
# Usage:  scripts/test-021-fixtures.sh [path/to/migrations] [path/to/fixtures]

set -uo pipefail

MIG_DIR="${1:-db/migrations}"
FIX_DIR="${2:-db/fixtures}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGHOST_DIR="${PGHOST_DIR:-/tmp}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
DB="f21run_$$"
FAILURES=0

STAGE="$(mktemp -d /tmp/kvrn-f21gate.XXXXXX)"
cp "$MIG_DIR"/0*.sql "$STAGE"/ 2>/dev/null
cp "$FIX_DIR"/f21_*.sql "$STAGE"/ 2>/dev/null
chmod -R a+rX "$STAGE"
cleanup() {
  su "$PGUSER" -c "$PGBIN/psql -h $PGHOST_DIR -p $PGPORT -d postgres -q -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE);'" >/dev/null 2>&1
  rm -rf "$STAGE"
}
trap cleanup EXIT

psql_as() {
  local db="$1"; shift
  su "$PGUSER" -c "$PGBIN/psql -h $PGHOST_DIR -p $PGPORT -d $db $*"
}

echo "021 FIXTURE GATE — fresh database, ON_ERROR_STOP=1"
psql_as postgres "-q -c 'DROP DATABASE IF EXISTS $DB;' -c 'CREATE DATABASE $DB;'" >/dev/null 2>&1

for f in $(ls "$STAGE"/0*.sql | sort); do
  psql_as "$DB" "-v ON_ERROR_STOP=1 -q -f '$f'" >/dev/null 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "  FATAL: migration $(basename "$f") failed (exit $rc)"; exit 1
  fi
done
echo "  migrations 001..latest applied"

out=$(psql_as "$DB" "-v ON_ERROR_STOP=1 -f '$STAGE/f21_integrity.sql'" 2>&1)
rc=$?
printf '  %-18s psql exit=%s\n' f21_integrity "$rc"
if [ $rc -ne 0 ]; then
  echo "  --- first error ---"
  echo "$out" | grep -i 'ERROR:' | head -3
  FAILURES=$((FAILURES+1))
fi
echo "$out" | grep -c 'PASS ' | sed 's/^/  assertions passed: /'

# Idempotency: reapply the migration three times; the scan must not change.
h1=$(psql_as "$DB" "-At -c \"SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) FROM financial_integrity_scan() t\"")
for i in 1 2 3; do
  psql_as "$DB" "-v ON_ERROR_STOP=1 -q -f '$STAGE/021_financial_integrity.sql'" >/dev/null 2>&1
  rc=$?
  printf '  reapply 021 #%s     psql exit=%s\n' "$i" "$rc"
  [ $rc -ne 0 ] && FAILURES=$((FAILURES+1))
done
h2=$(psql_as "$DB" "-At -c \"SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) FROM financial_integrity_scan() t\"")
if [ "$h1" = "$h2" ] && [ -n "$h1" ]; then
  echo "  scan identical before/after reapply: $h1"
else
  echo "  SCAN CHANGED AFTER REAPPLY: [$h1] vs [$h2]"; FAILURES=$((FAILURES+1))
fi

printf '\n============================================================\n'
if [ "$FAILURES" -eq 0 ]; then
  echo "021 FIXTURE GATE PASSED (fresh database, ON_ERROR_STOP=1)"
  exit 0
fi
echo "021 FIXTURE GATE FAILED: $FAILURES"
exit 1
