# KVRN ChatGPT backend Checkpoint 42 — Verified store-credit customer identity

**Local development only. No production writes, provider sends, payments, deployed changes or migrations were performed.**

Base: complete `KVRN_CURRENT_CHATGPT_SOURCE_CP41_2026-10-08.zip`; preserves prior CP08–CP41 work. Claude's Admin/CMS/SEO work is separate and not included.

## Completed in this checkpoint
- Migration `061_store_credit_verified_customer_identity.sql` (unapplied): 10-minute HMAC-account-key email challenges; one-time, row-locked redemption; hashed 30-minute HTTP-only identity sessions; revocation.
- New server-only identity service and four API routes to request verification, redeem token, read balance, and logout. Proof link carries token in URL **fragment**, with actual consumption by same-origin POST (avoids mail-scanner GET sign-ins). No raw account key / email / token is returned to public clients.
- Ledger-backed balance returns issued minus captured credit, with open holds deducted from spendable balance. Rejects malformed/negative/unsafe ledger totals. The balance is *not* an authorized checkout redemption.
- SMTP/Resend email request **code** is separately default-off (`STORE_CREDIT_IDENTITY_EMAIL_ENABLED`); provider is mocked in tests. No mail sent.
- `tsconfig.json` target ES2020 for existing BigInt usage in backend (Claude reported ES2017 build issue); semantic typecheck/build still pending complete dependencies.
- Registered new routes; removed four stale backup route entries for paths not present in the supplied CP41 source ZIP, without changing backup functionality.
- Updated migration hash preflight 038–061. Added 18 offline runtime and database-contract tests.

## Verified
- `npm run qa:consolidated-offline`: **PASS**, including all prior offline tests, route contracts and 18/18 new identity tests.
- Parsed 802 TS/TSX files; zero syntax errors. *Syntax parsing is not a semantic typecheck.*
- `node scripts/verify-unapplied-migration-chain.mjs`: 24/24 hashes and destructive SQL preflight; **does not execute PostgreSQL migrations**.
- No real provider or database integration tests have been run. Full TS, Jest, Next build and isolated PostgreSQL tests are not yet completed.

## Remaining financial integration work
- Redemption requires a safe, audited cash-plus-credit payment path with Stripe checkout/payment intent and tax, canonical reservation snapshots, `finalize_paid_order` compatibility, capture, refund/release, and inventory recovery. No such customer checkout path is enabled by CP42.
- A customer-facing `/store-credit/verify` page needs to call the new start/verify/balance endpoints. This is a separate frontend task for Claude or integration, not included here.
- Migrations 038–061 are **NOT APPLIED**. Never run on production without owner approval and isolated tests.

## Merge
- Full source ZIP represents **cumulative ChatGPT work** through CP42, not a production install.
- The CP41-only delta from shared CP08 remains the base conflict-aware merge package. Apply *its preview* against Claude's work; the supplemental CP41→CP42 delta includes strict CP41 preimage hashes for changed files. Do not force overwrites of Claude's tree.
