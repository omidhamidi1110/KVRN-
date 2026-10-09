# KVRN CP59 — isolated PostgreSQL-backed browser cart UI test

**Status:** CP59 test harness prepared and locally syntax/self-test checked; the full PostgreSQL + Chromium run must be executed in the owner's Codespaces. Latest independently confirmed owner checkpoint is CP58.1 public-only browser QA PASS.

## Scope and limitations

CP59 adds `scripts/cp59-local-cart-fixture.mjs` only. It does NOT change the application, routes, checkout, database migrations, Stripe, R2, or the previously verified CP58 QA code.

A disposable local PostgreSQL 16 DB is cloned from the preserved `kvrn_cp55_migrationtest` 064-schema evidence. Migration 065 and the existing `db/seed.sql` are applied **to that clone only**. Synthetic stock is set at M=2 and all other sizes=0, for both coded products, and queried from PostgreSQL. A local-only Wrangler Worker is started with no credentials, accounts, routes, R2 binding, cron, or dispatch permission. Chromium intercepts only `GET /api/inventory?slug=...`, returning the immutable result read from PostgreSQL, and blocks all cross-origin browser traffic and ALL browser non-GET/HEAD requests. It visits the real storefront PDP, confirms zero-stock size is disabled, selects in-stock M, adds to bag, and navigates to the local Checkout UI without payment creation.

**This is a browser-interaction test based on real PostgreSQL fixture data injected into the browser.** It is deliberately NOT proof that the actual Worker `/api/inventory` route is connected to local PostgreSQL via the Neon HTTP adapter. It does NOT test full server-side checkout, payment, Shippo, Stripe, Cloudflare R2, or authenticated admin actions. These remain unverified and must not be marked passed.

### Owner commands (no reinstall/rebuild/production changes)

```bash
cd /workspaces/KVRN-
unzip -oq KVRN_CP59_CART_QA_PATCH.zip -d cp59-cart-patch
python3 cp59-cart-patch/CP59_APPLY_PATCH.py
cd kvrn-merged-staging
node scripts/cp59-local-cart-fixture.mjs --self-test
node scripts/cp59-local-cart-fixture.mjs
```

The runner demands exact local Codespaces PG16 data directory, Unix socket port 5433, role postgres, and the original CP55 evidence DB. It fails closed on any unrecognized environment files. On success it drains all test connections and drops its own randomized clone with **no FORCE**; on failure it attempts safe cleanup and reports errors. The untouched original CP55 database and both preserved CP56 forensics DBs are not used for writes. Full report `/tmp/kvrn-cp59-cart-report.json`; Wrangler logs `/tmp/kvrn-cp59-worker.log`.

If the browser runner fails, send the `CP59 FAIL` line and (if needed) the last 50 lines of `/tmp/kvrn-cp59-worker.log` before further changes. The CP58.1 public browser pass does not need rerunning.
