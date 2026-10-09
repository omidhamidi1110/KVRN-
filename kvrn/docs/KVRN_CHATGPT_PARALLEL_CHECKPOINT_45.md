# KVRN — ChatGPT backend checkpoint 45 (development only)

Owner source: user-provided ChatGPT CP41 plus local cumulative CP42–44. Claude's isolated Admin/CMS/SEO branch has NOT been merged. This checkpoint supersedes CP44 for ChatGPT's work.

## Added: end-to-end store-credit checkout in Stripe test mode (unverified staging SQL)

- Customer-supplied `storeCreditCents` optionally triggers the separately email-verified credit identity and actual SQL account balance read. The customer cannot choose an account ID.
- Uses canonical reserved product pricing, merchandise promotion, and final shipping rate. Credits cannot exceed net merchandise; a test-verified Stripe USD cash minimum is mandatory. Bundles and all-credit checkouts are not yet supported. Existing no-credit checkouts retain their original behavior.
- Creates a serialized credit ledger hold, a fixed coupon representing merch promotion plus credit, and a durable pre-provider one-shot marker. A Stripe session-creation timeout never automatically releases a possibly chargeable reservation. Ambiguous provider calls require owner reconciliation. Stripe webhook `checkout.session.expired` attempts credit release only after independent final expiration evidence.
- Migration **062** is an UNAPPLIED test-only addition to canonical `finalize_paid_order`: payment amount matches real cash due, original merchandise discount and frozen FIFO remain unchanged, and `kvrn_credit_capture_verified_checkout` records the separate credit tender and proof inside the same DB transaction.
- Migration **063** (UNAPPLIED) provides owner-only restoration of originally captured credit tender for physically inspected returns; it accounts for Stripe cash refunds, actual purchased item quantity, 14-day return rules and original ledger capture proof. `/api/admin/store-credit/restore` never sends email or calls Stripe.
- Added offline tests for these mechanisms. **There has not been a PostgreSQL migration execution, live provider test, Stripe test transaction, Jest suite or full Next.js build.** This is NOT production-ready. In particular Stripe promotion display, charge/refund reconciliation and provider ambiguity recovery require isolated integration testing.

## API/frontend handoff for Claude

Existing `/api/checkout/session` optionally accepts an **integer** `storeCreditCents` USD cents, AFTER customer successfully verifies their email through `/api/store-credit/identity/*` and the secure credit-identity cookie exists. Credit may only cover merchandise net of promotions, not shipping/tax; cash payment must meet Stripe's externally verified minimum. Checkout with credit is disabled by default and only allowed when `STRIPE_MODE=test` and all credit feature flags are enabled. Do not allow a frontend to assume success from a client redirect; order/credit capture comes only from Stripe's signed webhook and immutable DB proof. A simple UI can display the verified credit balance and a field for customer-requested cents, but DO NOT enable until staging integration is approved.

Owner return endpoint accepts the same strictly validated body shape as `/api/admin/store-credit/issue` (`returnId`, `requestedCents`, `deliveredAt`, `deliveryEvidenceRef`, `requestKey`, `confirmInspectedReturn`) but credits the original customer's actual captured store-credit account and requires separate `STORE_CREDIT_RETURN_RESTORE_ENABLED=true`, owner, `STRIPE_MODE=test` and SQL 063.

## Validation completed

`npm run qa:consolidated-offline`: PASS (at checkpoint 45); includes 26/26 SQL draft checksums, 10/10 split-tender tests, 10/10 return-restoration tests, route contracts, type syntax and all inherited QA. Tests use mocked SQL/provider; no real Stripe/payment, no Twilio/Resend sends, no production DB writes.

## Major outstanding backend work

- Isolated Postgres migration and concurrency verification for 038–063; full app build; Stripe test-mode checkout+webhook+refund+return E2E; ambiguous provider-payment recovery.
- Marketing fresh per-recipient delivery evidence, provider cost accounting, QA with signed callbacks; batch execution gated off; outbound SMS remains blocked pending authoritative Twilio permission and A2P registration.
- Merge with Claude, integration regressions, owner review, final approved installation; production is untouched.
