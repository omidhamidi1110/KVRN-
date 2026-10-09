# KVRN ChatGPT Checkpoint 38 — Provider-Permission and Credit Minimum Guards

**Development only. DO NOT DEPLOY.** Built on ChatGPT Checkpoint 37 and shared Claude/ChatGPT baseline Checkpoint 08. Owner-confirmed live source remains `07ac61f`; all schema drafts 038–060 remain unapplied.

## New implementation since 37

1. `lib/marketing-provider-permission.ts`: the read-only Resend permission probe now reads JSON with a streaming byte limit (not `Response.text()` after buffering), rejects invalid Content-Length, malformed JSON, invalid UTF-8, unknown pagination, duplicate topic evidence, and oversized/chunked responses. SMS stays independently provider-blocked.
2. `scripts/test-marketing-provider-permission.mjs`: 13 deterministic offline tests exercise the above, including 70KB and chunked streaming rejection; no real Resend network request.
3. `lib/store-credit-split-tender.ts`: the pure quote now requires a verified Stripe/account/currency minimum charge amount, and refuses positive cash remainders that cannot be charged. This is not proof that any account's current minimum is a particular number; the caller must independently verify it. The quote cannot issue, hold, redeem or spend credit.
4. `scripts/test-store-credit-split-tender.mjs`: 15 deterministic offline tests including the microcharge scenario.

## Validation and outstanding work

- `npm run qa:consolidated-offline`: PASS (includes newly expanded provider permission and split-tender checks, route contracts and TS/TSX syntax parsing).
- Migrations 038–060 remain *unapplied*; file hashes unchanged. No DB connections, provider messages, Stripe transactions or Cloudflare changes.
- Full Next build, application Jest, semantic TypeScript, browser tests and PostgreSQL concurrency/integration still require Codespaces/staging.
- Actual customer-facing store-credit checkout and production marketing dispatch are **not finished**. Existing Stripe order finalizer has intentionally not been changed pending a financially correct cash-plus-credit checkout design. Do not enable the flags just because these guards pass.
- Claude owns separate Admin/CMS/SEO modifications; merge with the Checkpoint 08 three-way checks and handle conflicts, not a blind patch application.
