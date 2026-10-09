# KVRN ChatGPT Checkpoint 41 — Read-only Affiliate Integrity in AI Operations

**Development only; NOT release-ready.** Cumulative since ChatGPT CP40 on shared CP08 source. Owner-confirmed production remains `07ac61f`; Claude is separately editing Admin/CMS/SEO. No deployment, provider send, production writes, migrations, payout, or Stripe transaction.

## Implemented
- `lib/ai/affiliate-integrity-insight.ts`: fixed, aggregate-only query of canonical affiliate commission statuses and recorded payouts, with independently aggregated counts and payout-line reconciliation. No customer/affiliate identifiers, contact details, arbitrary SQL, mutation, or external model call. Missing schema, invalid amounts and inconsistent status buckets fail closed. Incomplete commissions never masquerade as known income; mismatched payouts produce unknown monetary totals. The figure is stored minor units and is NOT verified bank settlement or net profit.
- `lib/ai/private-insights.ts`: new `affiliate-integrity` tool, integrated into a six-source deterministic Operations brief. Status includes unknown / warning when integrity cannot be established.
- `app/admin/ai/insights/PrivateInsightClient.tsx`: selection for new insight under existing authenticated Admin route.
- `scripts/test-ai-affiliate-integrity.mjs`: ten runtime contract and invalid-data tests, no DB connection. Updated private insights tests to assert six tools and no data egress.
- `package.json`: registers new tests in `qa:ai-private-insights` and hence the cumulative offline suite.

## Verification
- `npm run qa:ai-private-insights`: PASS 13 prior/updated private-insight tests and 10 affiliate tests.
- `npm run qa:consolidated-offline`: PASS; 23 draft migrations 038–060 remain hashed but UNAPPLIED.
- Full semantic TypeScript / Next build / Jest / PostgreSQL / provider testing not performed in this export (missing installed dependency definitions and deferred staging integration). SQL count accuracy requires isolated PostgreSQL regression tests.

## Remaining blockers
- Customer-facing store credit checkout is NOT enabled; old canonical `finalize_paid_order()` only accepts full cash charge and needs a separately audited split-tender finalization path, order snapshots, Stripe tax and refund handling in isolated staging.
- Marketing transports are still default-off. Twilio Advanced Opt-Out/reassignment checks, A2P, and provider idempotency+consent integration remain unverified.
- No claims of verified affiliate net profit or bank-reconciled paid balance. Claude's side must be merged using a conflict-detecting delta from common CP08.
