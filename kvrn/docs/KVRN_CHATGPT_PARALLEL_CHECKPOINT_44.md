# KVRN ChatGPT Backend Checkpoint 44 — Verified Customer Credit + AI Operations + Sequential Live Funnel

This is **one cumulative, development-only source checkpoint** from uploaded CP41. It contains CP42 + CP43 + CP44. Production is untouched and Claude's independent branch is not included.

## CP42 implemented
- Email-ownership proof for viewing private credit balance: hashed one-time 10-minute challenges, 30-minute HttpOnly verified sessions, revocation, and private balance API.
- Email transport code default OFF; no provider calls in tests; no customer-facing checkout redemption.
- Unapplied draft SQL migration `061_store_credit_verified_customer_identity.sql`.

## CP43 implemented
- Existing Admin private AI Operations store-credit insight now reconciles actual issued/held/captured ledger values, orphaned holds, expired unresolved holds, mismatched checkout links, payment proof issues and outstanding liability.
- Cannot characterize compromised financial numbers as available credit; read-only, no personal customer data.
- No Admin frontend files touched.

## CP44 implemented
- Backend Live Analytics `/api/admin/analytics/live` now reports a same-consented-session **sequential** funnel of product view -> cart -> checkout -> order-linked purchase, all within the previous 30 minutes.
- The original independent stage counts remain unchanged for compatibility; the new counts are additive fields on `LiveAnalyticsSummary.observedSequentialFunnel30m`.
- Sequential funnel statistics are undercounts when sessions cross the observation window or analytics consent is missing; not proven complete conversion rates.
- No frontend files touched; Claude may choose to display the new API fields during final integration.

## QA and integration caveats
- Consolidated offline QA passes after CP44; includes 18/18 credit identity tests, 13/13 new AI credit operations tests, updated private insights, and 5/5 live analytics privacy/accounting tests.
- TypeScript syntax parsing passes. Full `tsc` semantic checking, Next build, and actual isolated Postgres/Jest/Stripe/Resend/Twilio integration remain untested because complete dependencies and staging providers were unavailable. Migrations **038–061 are UNAPPLIED**.
- Stripe cannot currently account for a credit + cash split tender with the canonical paid-order finalizer. No store-credit redemption or bulk marketing sends should be activated until that integration is implemented/tested.
- Twilio advanced opt-out REST backread proof is not available in existing verified integration; SMS broadcast permission is deliberately still OFF.
- Before integration with Claude, **preview** the cumulative CP08->44 merge delta; preserve overlapping files and manually resolve conflicts. Do not deploy interim checkpoints.
