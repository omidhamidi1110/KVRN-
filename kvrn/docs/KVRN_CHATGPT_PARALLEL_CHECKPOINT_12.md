# KVRN ChatGPT backend Checkpoint 12 — 2026-10-08

## Baseline and safe state
Cumulative changes from owner-exported Git `07ac61f`, including all shared Checkpoint 08 work and ChatGPT parallel backend CP09–CP12. Claude is independently developing Admin/CMS/SEO. These changes are NOT deployed, and migrations 038–049 are NOT applied. Keep outbound marketing, store-credit transactions and high-autonomy AI disabled until staged financial/provider verification and owner approval.

## Added since Checkpoint 11
- `lib/live-analytics.ts`: privacy-safe independent thirty-minute observed funnel counts (not a sequential/conversion cohort); strict visitor UTM-source display sanitizer; unsafe/unknown paid-order gross is rendered as unknown rather than misleading zero.
- `app/admin/live/LiveViewClient.tsx`: explicitly labels recent-event funnel, not a guaranteed count of online customers, and displays unknown money totals conservatively.
- `scripts/test-live-analytics-privacy.mjs` plus package command: five local domain/SQL-mock tests for PII withholding, unknown money, event-only counts and source sanitation.

## Verified locally
- `npm run qa:consolidated-offline`: PASS including Live View privacy checks, source syntax parsing and existing consent/marketing/finance and AI policy tests.
- NOT VERIFIED: full TypeScript type checking and Next build (incomplete exported dependencies), Jest, migrations and concurrent database behavior, Stripe integration, Twilio/Resend sending, browser/WebKit, Cloudflare or production.
- No customer PII, provider credentials, real money, production migrations, live messages or deployments used.

## Merge plan
Compare ChatGPT and Claude changes against common CP08 base; resolve conflicts manually, especially files in `app/admin` and package/test registries. Run isolated staging migrations in numerical order and complete checkout/financial reconciliation tests before owner approval of any production changes. A cumulative recovery ZIP is not a release artifact.
