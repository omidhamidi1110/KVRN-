# KVRN ChatGPT Checkpoint 40 — Split-tender Refund Allocation Preflight

**Developer checkpoint only. Do not deploy, apply migrations, process payments, or enable marketing sends.** This is cumulative from ChatGPT Checkpoint 39, originally based on shared Checkpoint 08; owner-confirmed production Git is still `07ac61f`.

## New code since 39

- `lib/store-credit-refund-allocation.ts`: pure, exact-integer allocation preflight for refunds on orders paid with both Stripe cash and a store-credit liability. Keeps restored credit separate from cash returned to a card. Requires independently verified paid tender amounts, approval, settled prior refunds, and no unresolved disputes. Rejects any allocation that would double-refund either source. This only validates a proposal and `executionAuthorized` is always false.
- `scripts/test-store-credit-refund-allocation.mjs`: 15 offline tests, including double settlement, partial refunds, unsupported currencies, unverified evidence, amount mismatch and integer overflow.
- `package.json` adds `qa:credit-refund-allocation` to the cumulative offline QA suite.

## Previous changes preserved

Checkpoint 39 adds signed RFC 8058 one-click marketing unsubscribe with POST-only revocation, normal browser confirmation page, no mutation from GET/HEAD, 14 tests; Checkpoint 38 adds bounded Resend permission reads and independently verified Stripe minimum cash remainder check. Entire earlier development is cumulative.

## Tests and hard blockers

- `npm run qa:consolidated-offline`: PASS, including refund-allocation 15/15, unsubscribe 14/14, provider-permission 13/13 and 23 locked 038–060 migration hashes; no database connection.
- Cannot claim production-ready stored-value checkout or refunds: no real account ownership verification, checkout frontend/tender bridge, canonical Stripe/Neon atomic finalizer support, cash/credit refund transaction writer, tested Stripe callbacks, or application/staging tests.
- Marketing transports remain default-off and unverified with providers; cannot send without explicit approval. Nothing deployed, no real charges or messages.
- Claude's CMS/Admin/SEO branch must be merged with the ChatGPT-only delta since shared Checkpoint 08; do not blindly overlay this cumulative patch.
