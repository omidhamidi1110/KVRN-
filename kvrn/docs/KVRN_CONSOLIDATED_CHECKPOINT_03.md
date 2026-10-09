# KVRN cumulative development checkpoint 03 — code-only SEO and Marketing Admin work

Owner production baseline remains 07ac61f. Local synthetic snapshot `83a2689` represents the source export, not a later production deployment. This cumulative recovery archive includes everything from checkpoints 01 and 02; **do not stack the checkpoint ZIPs**.

## Additional source implementation

1. Added a feature-gated public Google Merchant Center **product-level RSS** endpoint at `/feeds/google-products.xml` (not `/api/`, which is disallowed by robots). It is OFF unless both the Merchant feed flag and CMS product routing flag are enabled; no auto-submission or external calls. Feed data comes only from active, published, listed CMS products via the same canonical product data path as checkout. Unknown stock, unpublished/hidden products, missing images and invalid or absent prices are omitted. XML escaped, no PII, no fake GTINs, and a failed/empty feed returns 503 rather than claiming zero inventory. Merchant product variant grouping/GTIN/reviews, shipping/return settings, validation, account approval, crawl access, rates and feed submission are not yet complete.
2. Added Admin Marketing **release readiness** read-only display, showing explicit gates and default-off status. Copy review is not permission to send. Updated email day-cap text.
3. Registered the Merchant feed route in KVRN's existing QA feature-contract manifests and attached the offline Merchant assertions to product-specific test evidence. Added `npm run qa:marketing-offline` and `npm run qa:consolidated-offline` scripts.
4. Preserves all checkpoint 02 budget/DST/SEO work and consent work from checkpoint 01. SMS and Resend broadcasts remain disabled; migrations 038–046 remain unapplied. No store credit issuance/redemption is enabled.

## Local verification

- `npm run qa:consolidated-offline` — complete offline path, no DB or network; to be reported at package creation.
- `node scripts/test-google-merchant-feed.mjs` — 10/10 offline feed assertions passed.
- `node scripts/verify-route-contracts.mjs` — 243 routes/pages, 25 durable feature contracts verified.

Full Jest/TS typecheck, Next production build, Playwright/WebKit, real Postgres, provider/Stripe/Google integration, finance E2E, security review and owner approval remain mandatory before deployment. **Not a production release.**
