# KVRN ChatGPT parallel development — Checkpoint 15

**Source baseline:** deployed `07ac61f`, synthetic local Git baseline `83a2689`, continuing cumulative Checkpoint 14. **No production writes, no deployments, no migrations applied, no marketing sends, no Stripe charges.** Claude owns Admin/CMS/storefront/SEO; these changes only touch ChatGPT marketing/credit backend and supporting QA records.

## New in checkpoint 15

1. Migration `051_store_credit_checkout_holds.sql`: serialized, amount-checked, idempotent checkout credit **hold only**. It requires an active, non-expired reservation with a Stripe checkout session and an existing credit account, refuses insufficient/unknown balances, and enforces one hold per reservation. Does **not** issue, release, capture, charge or redeem credit. Schema is not applied.
2. Internal server helper `lib/store-credit-checkout-hold.ts` is default-off under `STORE_CREDIT_CHECKOUT_HOLD_ENABLED`. It requires separately verified account ownership and canonical checkout tender evidence. **No public/customer/Admin route currently calls it.** No customer credit can be spent under this checkpoint.
3. Migration `052_marketing_owner_approval.sql`: records explicit, one-hour, revocable owner approval for one staged campaign plan, fixed draft version and audience count <=50, hard max estimated spend <=$2, and immutable approval audit. It does **not** send or schedule delivery. Schema is not applied.
4. `lib/marketing-owner-approval.ts` and `/api/admin/marketing/owner-approvals`: Cloudflare Access Admin identity + separately configured owner email, strict same-origin bounded JSON, default-off `MARKETING_OWNER_APPROVAL_WRITES_ENABLED`, audit-safe revocation. An approval still does not reserve a budget or permit dispatch; outbound systems remain off.
5. QA feature route registry, scripts and command `qa:consolidated-offline` extended for these two new surfaces.

## Testing

- `node scripts/test-store-credit-checkout-holds.mjs`: 10/10 pass.
- `node scripts/test-marketing-owner-approval.mjs`: 10/10 pass.
- `npm run qa:consolidated-offline`: passes; 249 routes/pages registered, 128 TS/TSX syntax parsed.
- **Not tested:** PostgreSQL transactional/concurrent execution, Next build/TypeScript semantic type-check, provider integrations, browser flows, Stripe split-tender/checkout, emails, real recipient consent and real sending.

## Blockers and release instructions

These migrations are drafts requiring isolated PostgreSQL schema + concurrency tests and a financial/security review. Production migrations 027–037 already exist; **never rerun**. New 051 and 052 must be applied after 038–050 in staging only and not to production without explicit owner approval and backup. For store credit, build issuance from inspected returns plus verified-customer access and reconciled Stripe checkout before enabling the hold, and then add terminal capture/release with real payment evidence. For marketing, build explicit just-in-time consent/provider/region/price checks, budget reservations, delivery idempotency and owner authorization checks before any provider send. Do not treat these procedures as release-ready.

## Merge

This is a cumulative patch against the exported original baseline, **not a later live deployment**. Do not overwrite Claude's concurrent Admin/SEO work. Resolve changes to shared QA/package files manually, run full build and integration tests before any deployment.
