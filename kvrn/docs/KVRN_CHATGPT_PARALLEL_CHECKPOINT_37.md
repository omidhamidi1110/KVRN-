# KVRN ChatGPT Checkpoint 37 — Locked Unapplied Migration Chain

**Development only. DO NOT DEPLOY.** Production remains `07ac61f`. Claude owns separate Admin/CMS/SEO changes; this is the ChatGPT backend branch from shared Checkpoint 08. All migration drafts 038–060 are **unapplied**.

## New since 36

- `qa/unapplied-migration-checksums.json`: SHA-256 manifest for 23 additive migration drafts 038–060 as presently reviewed. It preserves evidence of the exact SQL the source was tested against. Future changes require explicit review and an intentional manifest refresh, never silently editing older drafts.
- `scripts/verify-unapplied-migration-chain.mjs`: read-only 23-file preflight that verifies contiguous numbered drafts, matching hashes, outer BEGIN/COMMIT, and rejection of obvious destructive SQL and modifications to core financial/commerce tables and canonical finalization functions.
- `scripts/test-unapplied-migration-chain.mjs`: eight offline tests for tampering, missing files, unsupported destructive statements, and transaction boundaries.
- `package.json`: added `qa:unapplied-migrations` to the cumulative offline safety suite.

## Limitations / what is NOT completed

This preflight is **not a SQL parser and does not prove migrations will execute or integrate correctly**. It never connects to Neon. Full PostgreSQL staging migration, concurrency, rollback and financial-correctness tests are required. There is **no customer-facing store-credit redemption**, no bulk campaign sender/cron, and no SMS provider-clearance integration. The local owner test sender from Checkpoint 36 is development-only, disabled by default and cannot run in deployed builds. Existing Stripe finalization remains untouched to preserve order totals and FIFO/payment snapshots. No provider messages, Stripe charges, production database writes or Cloudflare deployments took place.

## Verification

`npm run qa:consolidated-offline`: PASS, including `qa:marketing-local-manual` (8/8) and `qa:unapplied-migrations` (23/23 hashes, 8/8 behavioral preflight checks). Full Next/Jest/TypeScript and Postgres/provider/browser integration require staging dependencies and credentials and have not run.
