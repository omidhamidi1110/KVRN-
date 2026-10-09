# KVRN ChatGPT parallel development — Checkpoint 17

**Cumulative update to CP16; shared owner Git baseline `07ac61f`.** All previous ChatGPT work included. No live deployment, no production migrations, no actual payments or messages.

## New since CP16

1. `lib/store-credit-split-tender.ts` + tests: an integer-only, USD merchandise-only credit-tender quote with preserved pre-tender shipping/tax and canonical discounts, strict identity/cart/tax evidence, credit balance checks and zero-cash checkout block. This is a pure model and is NOT yet wired to real Stripe Checkout or the order-financials ledger.
2. Migration `054_marketing_budget_cost_reconciliation.sql` + helper and offline tests: resolves worst-case SMS/email budget reservations only with unique immutable verified-provider cost evidence (charged) or authoritative proof that a provider definitely did not send. Unknown cost/status stays reserved; no customer messages or scheduled jobs are created. Default-off `MARKETING_COST_RECONCILIATION_ENABLED` gate. Provider evidence insertion, webhook reconciliation and send pipeline remain unfinished.
3. QA contracts updated; `npm run qa:consolidated-offline` extended with 12 split-tender and 9 cost-reconciliation tests, all passing.

## Still required

- Store-credit: verified ownership and balance lookup, Stripe partial tender checkout and cash-tax accounting, terminal hold capture/release, refunds/disputes, customer service and staging financial invariants.
- Marketing: approved provider account, proof-backed provider-cost evidence, recipient-local quiet hours, opt-out recheck, broadcast execution, safe ambiguous-send recovery, compliance review, integration tests.
- AI Operations, provider deployment, full build, TypeScript semantics, PostgreSQL concurrency, browser tests, security/financial audits all remain pending.

Never apply migrations 038–054 to production without owner approval, safe migration plan and pre-migration Neon backup. Do not rerun completed production 027–037. Keep all new feature flags OFF until tested.
