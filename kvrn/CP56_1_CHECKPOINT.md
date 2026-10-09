# KVRN CP56.1 — financial concurrency cleanup hardening

Source lineage: CP55 authoritative merged source + CP56 additive SQL 065 + CP56.1 runner-only lifecycle fix. No production approval.

## Evidence provided by owner (Oct 8, 2026)
- 5,355/5,355 previous Jest tests green, 64/64 local CP55 migrations green.
- Cloudflare OpenNext BUILD ONLY returned 0; 2,278-byte worker and 383 assets. No deployment.
- CP56 isolated PostgreSQL concurrency runner printed 12/12 PASS cases, then crashed after the assertions with an unhandled PostgreSQL `terminating connection due to administrator command` event. Runner returned exit code 1; the root cause is consistent with forced local-clone database deletion racing backend shutdown.

## CP56.1 change
- ONLY `scripts/cp56-isolated-concurrency.mjs` changed in place, under strict SHA guard; no SQL, production source, tests, or application files changed. Assertions remain identical.
- Removes `DROP DATABASE ... WITH (FORCE)` from clone cleanup. After `pool.end()` checks `pg_stat_activity` until all connections naturally disappear (up to roughly three seconds); then uses a plain `DROP DATABASE` (no forced termination). If any sessions remain, preserves the temporary clone and reports exit code 1 without disconnecting anything.
- Registers a PostgreSQL pool idle connection `error` handler; unexpected errors are logged and mark runner failure. Separates `CHECKS PASS` from end-to-end `PASS` including safe teardown.
- Fresh, randomly named disposable clones only; preserved `kvrn_cp55_migrationtest` is read-only; all remote/production resources remain untouched.

## Exact Codespaces steps
Upload `KVRN_CP56_1_PATCH.zip` to `/workspaces/KVRN-/`. Then:

```bash
cd /workspaces/KVRN-
unzip -q KVRN_CP56_1_PATCH.zip -d cp56-1-patch
python3 cp56-1-patch/CP56_1_APPLY_PATCH.py
cd kvrn-merged-staging
bash scripts/cp56-run-local-postgres.sh
```

This patch checks both old and new SHA-256 values and is safe to re-apply. It does not invoke Cloudflare, provider APIs, Neon, a migration runner, or Git commands.

## Next gates
1. Confirm 12/12 AND `CLEANUP PASS`, exit code 0 on Codespaces PostgreSQL.
2. Run the extended finance/marketing/identity/replay tests from `scripts/cp56-finance-races.mjs` in its own randomized local clone. It intentionally preserves its clone and does NOT contact provider APIs.
3. Run populated historical-schema upgrade test in a dedicated randomized local database; perform remaining synthetic webhook/admin/asset audits under local conditions.
4. Edge, R2 and browser/Stripe provider E2E require independent safe staging infrastructure and/or explicit authorization. No deployment or live provider actions assumed.

Recovery: source ZIP `KVRN_CP56_1_CUMULATIVE_FULL_SOURCE.zip` is cumulative. The incremental patch never re-extracts or replaces the existing staging site.
