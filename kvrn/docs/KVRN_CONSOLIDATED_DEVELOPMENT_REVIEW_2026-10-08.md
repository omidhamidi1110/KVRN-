# KVRN — Consolidated local development review (October 8, 2026)

## Boundary
This is a **local source branch**, not a production update. Owner-confirmed starting source: `07ac61f`; live Worker: `kvrn`; migrations 027–037 already applied. Do not rerun them. No Cloudflare deployment, live database access/mutation, real payment, customer marketing send, affiliate payout, or external AI action was performed.

## Integration approach
The owner wants **one installation/release package**, not seven separate source overlays. Maintain one accumulated diff and one preproduction test cycle, while retaining internal feature flags and release gates. Combining delivery artifacts does NOT mean enabling unsafe functions together.

| Workstream | Current integrated source contribution | Still blocked before production |
|---|---|---|
| Admin responsive | Shared shell width and table-scroll hardening from Phase 1 | Real authenticated iOS Safari/Chromium evidence at 320–1440; original screenshot black-strip root cause not yet proven |
| Policies/consent/CMS | Legacy alias redirects, messaging routes fail closed until approved CMS policy, privacy preferences share real consent store, Clarity injection removed, CMS legal display simplified, contact and tracking fallback corrections | Import Oct 6 verbatim owner copy as CMS drafts; counsel approval; legal feature/policy parity; publish + rollback test; no old indexed aliases |
| Postscript/Twilio | `scripts/postscript-consent-dry-run.mjs` reads CSV locally and returns **aggregate counts only**; suppression precedence; no subscriber import | Actual original Postscript CSV, consent provenance/brand, 53/8 figure validation, signed webhooks, advanced opt-out, double opt-in, actual A2P approval, dry-run human review |
| Marketing suite | `lib/marketing-dispatch-policy.ts` strict deterministic preflight with unknown-price/spend rejection, explicit consent/approval/cost checks and suggested limits | Atomic durable budget reservations, queue/idempotency, Resend broadcasts, consent sync, UI, priced provider models, webhooks, true send pipeline and provider approval; ALL sends disabled |
| Store credit | `lib/store-credit-domain.ts` pure accounting: issue/hold/capture/release and idempotency/invariant tests | Append-only DB ledger migration **>037**, serializable checkout/Stripe/returns/finance integration, staged tests, counsel review, owner schema approval; issuance/redeem DISABLED |
| CMS/products/affiliates | Existing product/CMS/affiliate code preserved without rewrite | Actual staging e2e, live variants state, migrations/flags/permission proof; payout disabled |
| Google SEO/GA4 | Removed filter query URLs from XML sitemap; existing GA client and consent wiring preserved | GSC owner/property verification, merchant feeds/structured data audit, GA4 DebugView test, indexing/robots/canonical review, source-of-truth parity |
| Live analytics/AI Ops | Existing analytics and AI-budget infrastructure untouched | Active-session identity and retention design, live dashboard, provider/private inference decision, role/eval gates, data/privacy and financial safety tests |
| QA/performance | Existing source QA + new offline unit tests, opt-in staging-only 320–1440 browser audit | Dependencies, full Jest/build/lint/type-check, staging test DB/R2, authenticated WebKit, CWV benchmarks, recovery drill |

## Local code safety limitations
- Marketing policy preflight is **not** a payment/billing reservation and cannot authorize send by itself; provider integrations must use a concurrent-safe DB reservation, and recheck the current recipient suppression, quiet hours and immutable audience immediately before dispatch.
- Store-credit domain code is **not** wired to customers, orders, Stripe or Neon. It cannot issue customer credit. A future migration must be staged only, formally approved, additive, auditable and financially reconciled before use.
- The consent CSV tool prints no subscriber identifiers, never sends and never writes database rows. It is only a preliminary quality gate, **not** evidence of lawful opt-in.
- October 6 policies are drafts supplied by owner. They were not published here; do not assume storefront or CMS now displays the new legal content.
- The 119 MB source export does not include the production credentials, live provider account permissions, or live database; those must not be supplied to the model. Use Codespaces and provider-hosted secrets for owner-approved testing.

## One-time Codespaces final acceptance commands (only when final package is accepted)
```
node scripts/verify-phase1-safety.mjs
node --test scripts/__tests__/postscript-consent-dry-run.test.mjs
npm ci
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
```
Read-only responsive browser QA requires a **separate isolated staging URL** and optionally an authenticated Playwright storage-state file kept only in Codespaces:
```
KVRN_QA_STAGING_URL=https://your-actual-staging-host npm run qa:responsive
```
The script refuses `kvrn.shop` production and will not test Admin without `KVRN_QA_STORAGE_STATE`.

## Release gate
Before deploying, reconcile Wrangler root vs production environment and remote secret/config drift. Run an isolated database copy, fix any test failures, verify feature flags remain OFF, audit customer-facing policies, perform backup/restore proof and request **explicit owner approval**. The first live paid Stripe order is separately gated until final QA, per owner instruction.
