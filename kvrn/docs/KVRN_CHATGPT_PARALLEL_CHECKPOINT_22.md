# ChatGPT backend checkpoint 22 — 2026-10-08

**Owner-confirmed production is still `07ac61f`; development-only, not deployed.**
Claude separately owns Admin/CMS/SEO/frontend work beginning at shared Checkpoint 08. This ChatGPT checkpoint contains all of its prior backend work and should **not** be installed in production or merged automatically with Claude's independent edits.

## New: paid-checkout store-credit capture proof (migration 057, NOT APPLIED)

- Added `db/migrations/057_store_credit_verified_capture.sql` with an append-only proof mapping one credit hold, one capture ledger event, a single order/reservation, and verified paid Stripe references.
- The PostgreSQL capture transaction takes the same lock as hold creation and expired-session release, detects terminal/capture/release conflicts, rejects uncertain/reversed orders, and reconciles gross frozen merchandise/shipping/tax/discount math against Stripe cash plus credit.
- Added `lib/store-credit-checkout-capture.ts`, which reads Stripe **test-mode** Checkout and PaymentIntent/Charge finality. It is gated by `STORE_CREDIT_CHECKOUT_CAPTURE_ENABLED=true` **AND** `STRIPE_MODE=test` and has no public route or automatic caller.
- Added 13 offline behavioral and schema checks under `scripts/test-store-credit-checkout-capture.mjs`.

### Critical dependency before the capture can ever be used

The existing `finalize_order` expects Stripe cash to equal the full gross checkout amount. Store-credit split tender changes that invariant. The current Checkout handler and finalize function have **not** been changed. There is no customer credit redemption feature yet. Before launching this, a separately audited transactional split-tender checkout, frozen gross-vs-cash order accounting, refund/dispute allocation, account-ownership proof, webhook idempotency and staging Stripe test are mandatory. Never treat capture being coded as permission to redeem credit. No production migrations (038–057) have been applied.

All other prior restrictions remain: no live marketing, production data writes, real charges, external AI or production deployment without owner approval.
