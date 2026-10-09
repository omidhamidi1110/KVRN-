# KVRN cumulative development checkpoint 05 — return-credit proposal safeguards

## Baseline and limits
- Owner-confirmed production Git `07ac61f`, Worker `kvrn`, Neon migrations 027–037. All changes in this checkpoint are **local source only**. **No production writes, migration runs, provider calls, marketing sends, payments or deployment.**
- Cumulative: Checkpoint 05 incorporates every previous checkpoint; **do not stack ZIPs**.

## New changes since Checkpoint 04
- `lib/store-credit-proposal.ts` adds a pure default-deny *review readiness* evaluator for **discretionary**, not statutory, return store credit. It requires approved completed/inspected returned merchandise, verified paid order in USD, documented return request within the 14-day window, trustworthy net merchandise snapshots, confirmed absence of any order cash refund, return refund allocation, chargeback, previous store credit and excessive proposed amount. Unknown is always blocking. A passing result is not authorization to issue credit, and the function is not called by a production API.
- Unapplied schema `041_store_credit_liability_foundation.sql` now adds a unique `(account_id,hold_key)` terminal-event index so the same hold cannot both be captured and released, plus a cent range constraint for each event. A future transactional writer must also prove that a matching hold exists and balances suffice.
- Offline tests `scripts/test-store-credit-proposal-safety.mjs` cover those rules without connecting to Neon or Stripe. Wired into `qa:credit-offline` and static development gates.

## What is deliberately NOT built or enabled
- No store-credit issuance, redemption, browser balance display, authentication, partial Stripe payments, returns settlement, migration apply, or financial reclassification.
- The SQL migration is a DRAFT, not verified with PostgreSQL concurrency. It must undergo database/return-accounting audit before staging or production. Strong transaction locks, exact settlement evidence, tax and refund rules, idempotency, fraud protection, and user identity verification are mandatory before activation.
- Store-credit program cannot replace statutory cash/repair/replace remedies. Obtain legal review.

## Testing
- Run `npm run qa:consolidated-offline` for source guards, offline consent, Merchant feed, credit accounting/proposal assertions and route contracts. Full Jest, build, DB tests and browser/provider E2E still require a fully installed staging environment.
