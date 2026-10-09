# KVRN — Combined development source handoff

**Snapshot date:** 2026-10-08. **State:** ChatGPT CP50 + Claude final + integration changes. **Not production ready or deployed.**

## Which archive to use

Use the `KVRN_COMBINED_CP50_CLAUDE_FINAL_SOURCE.zip` delivered with this handoff as **the only combined source snapshot**. It already includes ChatGPT's CP41–CP50 backend work and Claude's final `KVRN_CLAUDE_20261008T232942_664325Z.zip` frontend/CMS/SEO/performance work. **Do not layer either patch on top of this full source archive**. Do not apply it over live production or run a migration against production. The historical production reference, `07ac61f`, was never changed here.

This source was assembled in an offline sandbox: CP50's complete source was extracted, Claude's CP08-relative patch was checked and applied with zero conflicts, then integration changes were added. A local Git commit preserves the combined pre-integration state (`733db1f`). Claude's original `FINAL_HANDOFF.md`, `SHARED_FILES_CHANGED.md` and proposals are preserved verbatim inside this archive.

## Functionality finished in this integration pass

1. **Customer store-credit redemption entry.** New `/store-credit/verify` page receives the one-use email challenge in its URL fragment, clears the fragment, redeems the challenge via same-origin API and returns to checkout. It has noindex metadata, is dynamically gated and does not log tokens. The checkout can show the private verified balance, request verification and enter a precise USD amount, then pass `storeCreditCents` to existing credit-aware checkout. Bundle items continue to exclude credit redemption. These paths are **off by default and only supported for explicitly activated Stripe test mode**; they have not run against a Stripe account.
2. **Build blocker.** Claude's proposed TypeScript `BufferSource` cast fix was applied in `lib/resend-webhook-suppression.ts`. `tsconfig.json` already targeted ES2020 in ChatGPT CP50; no duplicate edit was needed.
3. **Analytics privacy.** Excluded the one-use credit verification page from consented first-party and GA4 page tracking, and registered it (and Claude's owner policy-draft route) in `qa/route-contracts.json`.
4. **GA4 split-tender reporting.** Canonical server-side purchase events now use capture-proof-backed gross merchandise value (cash + credit) when split tender is enabled. They refuse absent or conflicting capture proofs instead of reporting only Stripe cash. Cash-only purchases keep the old behavior.
5. **Live Analytics split-tender reporting.** Gross paid today includes verified store credit tender for orders with capture proofs, fails to `null` (unknown) for unresolved paid credit holds and leaves existing cash-only reporting unchanged when split tender is off. Corrected an eager SQL-query ordering bug found in the tests.
6. **Consolidated QA.** Updated the stale product-preview development check to Claude's responsive implementation, added five customer-credit integration checks, six tender-reporting checks and a credit-enabled Live Analytics privacy/accounting case. All the offline development gates pass.

These are working source changes, **not evidence of a successful full app build, database transaction, authorized messaging send or live payment**.

## What was preserved from Claude

Admin responsive table/card display, black-strip fixes, CMS draft/editor and publish flows, deferred placeholder policy seeds, October 6 policy draft support, SEO/GA4/optional Merchant fields, and 53 optimized WebP renditions/custom loader. See Claude's `FINAL_HANDOFF.md`. No changes were made to production service configurations. Claude reported a successful local `next build` with two build blockers fixed in a scratch copy and ~5,248 passing Jest tests, with 7 failing suites (84 tests) that were present at their baseline. **These results were reported by Claude and were not reproduced in this sandbox**.

## What was preserved from ChatGPT CP50

The full Twilio/Resend at-most-once provider and signed callback pipeline; owner-reviewed Marketing Suite audience/consent evidence, templates and campaign execution routes (default-off); financial budgets, reconciliation and owner approvals; ledger-backed store-credit identity, holds, split-tender finalization/refunds/return restoration; Live Analytics and private AI Operations. Migrations `038`–`064` are source files **not applied**.

## Verification actually executed in this sandbox

- `git apply --check` and `git apply` of Claude's final patch against CP50 complete source: **pass, no overlapping patch conflicts**.
- `npm run qa:consolidated-offline`: **pass** with all existing and newly added offline checks, route manifest, migration-chain source tests and source syntax scanning. All providers/DB/checkout operations in these tests are mocked or static.
- `node scripts/test-store-credit-customer-ui.mjs`: **5/5 pass**.
- `node scripts/test-store-credit-tender-reporting.mjs`: **6/6 pass**, including tested server-side GA4 payload math and stubbed provider transport.
- `node scripts/test-live-analytics-privacy.mjs`: **6/6 pass** (including credit-enabled unknown proof handling).
- Recovery artifact hash/archive verification performed separately during package creation.

**Cannot execute here:** `npm ci`, `npm test` (full Jest), `npm run type-check`, `npm run build`, `npm run cf:build`, real SQL migrations/concurrency, Stripe test-mode end-to-end checkout/refund, Resend/Twilio staging callbacks, R2 upload and actual browser/WebKit tests. This runtime lacks locally cached npm packages, cannot resolve the npm registry, and has no PostgreSQL server or staging credentials. Do not substitute these offline results for release approval.

## Required staging release verification, in this order

All steps require a **separate nonproduction worktree / staging accounts**, and a separately provisioned nonproduction PostgreSQL database. Nothing below authorizes production use.

1. Extract the combined full-source archive **once** into an empty staging worktree. Never layer CP08, CP50 or Claude patch onto it again. Review this handoff, `FINAL_HANDOFF.md`, and `proposals/BUILD_BLOCKERS_CP08.md`.
2. Install dependencies and verify: `npm ci`, `npm run qa:consolidated-offline`, `npm run type-check`, `npm test -- --runInBand`, `npm run build`, then `npm run cf:build`. Fix **all** actual failures rather than relying on previous baseline counts. Test custom WebP loader / srcset in the OpenNext output. Do not run deploy commands.
3. Review migration chain `038`–`064` against an isolated copy of the actual pre-migration schema, then apply **only to isolated nonproduction PostgreSQL**. Validate rollback plan and transaction/locking concurrency; no Neon production connection string may be used.
4. With explicit owner consent and **test/sandbox provider keys only**, exercise Stripe Checkout + store credit hold/finalize/late payments/expiry/retries/return restoration; signed Twilio/Resend callback correlation (using test callbacks), suppression, uncertainty and recipient consent; AI and marketing budgets. **Do not send real customer messages.**
5. Test CMS product create/edit/publish, R2 uploads, policy drafts, Merchant data, responsive Admin tables with nonproduction representative rows, Safari on a real phone, GA4 consent and reporting, analytics end-to-end, SEO crawl, and OpenNext image loading.
6. Obtain legal review + owner approval for publishing policies, real product shipping weights/dimensions, required Merchant product attributes, default OG/share image and hero poster/video choice. These are product decisions, not code guesses.
7. Only after satisfactory staging results request separate explicit owner approval for any production migration, provider activation or deployment. The current source leaves marketing sending and store-credit redemption disabled unless intentionally configured.

### Stage-only feature flags / configuration cautions

- Store-credit customer email verification uses `STORE_CREDIT_IDENTITY_EMAIL_ENABLED=true` plus a private account pepper, Resend test credentials and verified sender. Actual email would be sent by the start endpoint; do **not** turn this on with real/customer provider keys without approval.
- Split-tender activation uses `STORE_CREDIT_SPLIT_TENDER_ENABLED=true`, requires verified sessions and `STRIPE_MODE=test`; do not enable before isolated migrations and test credentials.
- Marketing execution routes require multiple explicit owner approval and default-off flags. No bulk audience and no Twilio registration status may be interpreted as provider opt-out permission. Recipient status must be checked independently.
- Claude's CMS/product content toggles and Merchant feed toggle default OFF. Product publishing requires real shipping weights/dimensions.

## Recovery / merge hygiene

The **full source archive is the authoritative merged source**, not a patch to apply to the live repo. An optional incremental change patch starts from the already-merged CP50+Claude **local snapshot** `733db1f` and is **not a patch against bare `07ac61f` or CP08**. The full source ZIP is sufficient for all subsequent work. See `MANIFEST_SHA256.json` provided with the recovery archive for file-by-file verification.

No deployment, production migration, customer send, payment, policy publishing or third-party production configuration change was performed in this development session.
