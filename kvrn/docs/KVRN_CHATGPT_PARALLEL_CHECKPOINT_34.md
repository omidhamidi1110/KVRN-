# KVRN ChatGPT Parallel Checkpoint 34 — Signed Delivery Correlation

Cumulative from Checkpoint 08 plus all ChatGPT work through Checkpoint 33. Original owner production baseline `07ac61f` is UNCHANGED. **Development-only.** Claude's independent Admin/CMS/SEO work is not included; merge after owner review.

## New since Checkpoint 33
- `lib/marketing-signed-twilio-outcome.ts` and the existing signed Twilio status route: after the normal signature verification and transactional status update, a separately gated handler can match a `delivered` status to an earlier acknowledgement in migration `060`, comparing a keyed provider-ID digest and exact recipient stored in Neon. Does not infer non-submission from `failed` or `undelivered`; no resend/settlement.
- `lib/marketing-signed-resend-outcome.ts` and the existing signed Resend marketing webhook: a similarly gated handler can match `email.delivered`, only with exactly one recipient, to the prior email claim and provider ID. Existing complaint/bounce/unsubscribe suppression path runs before the new delivery-only logic.
- The signed webhook handlers do not expose recipient PII or provider IDs in response bodies, and return retryable failures for uncertain persistence. A callback arriving BEFORE the provisional receipt is persisted may remain unknown and need reconciliation. This is safer than retrying a possibly delivered message.
- Offline tests for both signed callback paths are part of `qa:marketing-provider-transport` and `qa:consolidated-offline`.

## Not finished / external owner gates
- No production or staging database migrations were executed. `060` is still unapplied; `038–059` remain unapplied.
- Both new callback handlers default OFF and require `MARKETING_PROVIDER_OUTCOME_RECONCILIATION_ENABLED=true` plus their own `MARKETING_SIGNED_TWILIO_OUTCOME_ENABLED` or `MARKETING_SIGNED_RESEND_OUTCOME_ENABLED` switches. Keep OFF in production until schema and signature/DB integration tests pass.
- The marketing sender still has no trusted persisted-claim recipient resolver and no live owner-approved execution trigger. Twilio A2P status and Postscript imported consent require provider-side validation.
- Full TypeScript check, Next build, DB transaction/concurrency tests, signed live provider tests, browser E2E, and Shopify-like Admin merge are deferred to Codespaces staging. Do not equate passing standalone contract tests with tested integration.
- Store-credit customer checkout remains disabled, without an end-to-end financial finalizer; do not use store credit as a Stripe discount. Existing checkout/payment/ledger logic untouched.

## Offline validation
`npm run qa:marketing-provider-transport`
`npm run qa:consolidated-offline`

No Cloudflare deployment, provider sends, real Stripe charges, emails, policy publication, customer-data exports, or production writes occurred.

## Important release gate
All signed-outcome paths are still default-OFF. The existing Stripe finalizer remains based on full Stripe collection; do not treat split-tender quotes or credit capture helpers as a working customer checkout until the canonical order/Stripe reconciliation workflow has been revised and tested in isolation. The sending path still lacks a trusted persisted-claim resolver and provider suppression proof; no user or AI-initiated sends.
