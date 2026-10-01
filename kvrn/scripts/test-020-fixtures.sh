#!/usr/bin/env bash
# scripts/test-020-fixtures.sh
#
# Canonical runner for the migration-020 PostgreSQL fixtures.
#
# WHY THIS EXISTS
#
# Some fixture groups are deliberately SEQUENTIAL LIFECYCLE CHAINS, not
# independent cases. f20a creates an affiliate, a paid order and the shared
# mk_order helper; f20b..f20e then walk that same commission through refunds,
# disputes, restorations and payouts. Splitting them into standalone scripts
# would mean each re-creating the prior economic history, which is exactly the
# state the later scenarios are meant to be testing.
#
# So the chain is preserved and made explicit here. Every group runs on a
# GENUINELY FRESH database, exactly once, in documented order, under
# ON_ERROR_STOP=1, and the psql PROCESS EXIT CODE is authoritative. No group ever
# runs against a database a previous group or a diagnostic session has touched.
#
# Usage:  scripts/test-020-fixtures.sh [path/to/migrations] [path/to/fixtures]

set -uo pipefail

MIG_DIR="${1:-db/migrations}"
FIX_DIR="${2:-db/fixtures}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGHOST_DIR="${PGHOST_DIR:-/tmp}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
RUN_ID="f20run_$$"
FAILURES=0

# psql runs as the postgres user, which cannot read a developer home directory.
# Stage world-readable copies so the gate does not depend on ambient permissions.
STAGE="$(mktemp -d /tmp/kvrn-fixgate.XXXXXX)"
cp "$MIG_DIR"/0*.sql "$STAGE"/ 2>/dev/null
cp "$FIX_DIR"/*.sql  "$STAGE"/ 2>/dev/null
chmod -R a+rX "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
MIG_DIR="$STAGE"
FIX_DIR="$STAGE"

psql_as() {
  local db="$1"; shift
  su "$PGUSER" -c "$PGBIN/psql -h $PGHOST_DIR -p $PGPORT -d $db $*"
}

fresh_db() {
  local db="$1"
  psql_as postgres "-q -c 'DROP DATABASE IF EXISTS $db;' -c 'CREATE DATABASE $db;'" >/dev/null 2>&1
  for f in $(ls "$MIG_DIR"/0*.sql | sort); do
    psql_as "$db" "-v ON_ERROR_STOP=1 -q -f '$f'" >/dev/null 2>&1
    local rc=$?
    if [ $rc -ne 0 ]; then
      echo "  FATAL: migration $(basename "$f") failed on $db (exit $rc)"
      return $rc
    fi
  done
  return 0
}

# run_chain <label> <fixture> [fixture...]
# Each chain gets its OWN fresh database. Any nonzero psql exit stops the chain
# immediately and marks the whole run failed.
run_chain() {
  local label="$1"; shift
  local db="${RUN_ID}_${label}"
  printf '\n=== CHAIN: %s ===\n' "$label"

  if ! fresh_db "$db"; then FAILURES=$((FAILURES+1)); return 1; fi

  for fx in "$@"; do
    local path="$FIX_DIR/$fx.sql"
    if [ ! -f "$path" ]; then
      echo "  MISSING FIXTURE: $path"; FAILURES=$((FAILURES+1)); return 1
    fi
    # Output is captured from the FIRST and ONLY execution. Re-running the
    # fixture to obtain the message would report a duplicate-key collision caused
    # by the diagnostic run itself, hiding the real failure.
    local out
    out=$(psql_as "$db" "-v ON_ERROR_STOP=1 -f '$path'" 2>&1)
    local rc=$?
    printf '  %-10s psql exit=%s\n' "$fx" "$rc"
    if [ $rc -ne 0 ]; then
      echo "  --- first error (from the original run) ---"
      echo "$out" | grep -i 'ERROR:' | head -2
      FAILURES=$((FAILURES+1)); return $rc
    fi
  done
  echo "  chain OK"
  return 0
}

echo "020 FIXTURE GATE — every chain runs on its own fresh database"
echo "migrations: $MIG_DIR   fixtures: $FIX_DIR"

# ── Stage 1: the S1..S10 refund/dispute lifecycle ───────────────────────────
# SEQUENTIAL: f20a seeds the affiliate, the paid order and mk_order; the rest
# continue that same commission's life.
run_chain stage1_lifecycle f20a f20b f20c

# ── Stage 1: zero-base, pause, hold, payout lifecycle ───────────────────────
# SEQUENTIAL: f20d extends f20a's world; f20e continues f20d.
run_chain stage1_payouts f20a f20b f20c f20d f20e

# ── Stage 1: concurrency ────────────────────────────────────────────────────
run_chain stage1_race f20race

# ── Stage 2: blockers #5..#8, #13 ───────────────────────────────────────────
# SEQUENTIAL: s2b and s2c build on s2test's affiliates and orders.
run_chain stage2 s2test s2b s2c

# ── Stage 3: attribution and backfill ───────────────────────────────────────
run_chain stage3 s3t s3u

# ── Stage 3: atomic audit rollback ──────────────────────────────────────────
run_chain stage3_audit audit2

# ── Final2-A: dispute-centric sync, corrections, backfill ordering ──────────
run_chain final2a_disputes b12fix
run_chain final2a_backfill b3

# ── Final2-B: historical ownership, causality, projection, window ───────────
# SEQUENTIAL: b2u continues b2t's affiliates.
run_chain final2b b2t b2u

# ── Rev2/Rev3 regression suites ─────────────────────────────────────────────
run_chain rev2_regression rev2 rev2b rev2c
run_chain rev3_repro repro r3b

# ── B6 provenance + B7 period scoping ──────────────────────────────────────
run_chain b6b7_provenance f3t

# ── Final5 freeze-candidate pass ────────────────────────────────────────────
# STANDALONE: builds its own affiliates/orders, not part of any prior chain.
run_chain final5 final5

printf '\n============================================================\n'
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL FIXTURE CHAINS PASSED (fresh databases, ON_ERROR_STOP=1)"
  exit 0
fi
echo "FIXTURE CHAINS FAILED: $FAILURES"
exit 1
