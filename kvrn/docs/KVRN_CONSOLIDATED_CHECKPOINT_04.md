# KVRN cumulative development checkpoint 04 — financial read-model integrity

Production continues at owner-confirmed Git **07ac61f**. This is a **development-only** cumulative source recovery archive, not a completed seven-phase release. All prior checkpoint changes are included; **never stack checkpoint ZIPs**.

## New work since checkpoint 03

- Added `lib/store-credit-ledger-integrity.ts`, a pure, strict parser for PostgreSQL bigint-based liability totals. It refuses missing, negative, non-integer, internally inconsistent or unsafe values; it does not convert unknown balances to zero.
- Updated Admin store-credit read model and UI to show a financial-integrity warning and withhold balances when aggregate totals are not reliable. Issuance and redemption remain disabled, and the original order/Stripe/FIFO ledgers are unchanged.
- Added 9 offline financial aggregate integrity assertions (`scripts/test-store-credit-ledger-integrity.mjs`) to the consolidated offline QA command. Extended static safety guard.

## Latest offline checks

- `npm run qa:consolidated-offline` — PASS; 45/45 static development gates, 19/19 budget/SEO checks, 10/10 Merchant feed checks, 9/9 credit aggregate checks, 25 feature contracts, and 108 changed TS/TSX files with no syntax parse errors.
- No remote integrations, no Postgres access, no production migration, no live payment or marketing send.

## Mandatory remaining work

Actual issue/hold/redeem/release stored procedures, approved return settlement, customer identity proof, Stripe split payment/refund flows, idempotent order finalization, isolated Postgres tests, concurrency/reconciliation and legal review must be implemented and audited before store credit can be enabled. Full Jest/Next build/WebKit/provider QA remain pending in Codespaces.
