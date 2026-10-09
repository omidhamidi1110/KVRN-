# KVRN ChatGPT Checkpoint 39 — Marketing Email One-Click Unsubscribe

**Development / recovery only. Do not deploy.** Builds cumulatively on ChatGPT Checkpoint 38 from shared Claude/ChatGPT Checkpoint 08, owner live Git 07ac61f. No production writes, provider sends, payments, or migrations.

## New since Checkpoint 38

- RFC 8058-compatible KVRN marketing email `List-Unsubscribe` and `List-Unsubscribe-Post` headers, using a server-generated contact-specific HMAC token; distinct from the human confirmation-page URL in the email body.
- `app/api/marketing/one-click-unsubscribe/route.ts`: POST-only unsubscribe endpoint; GET/HEAD cannot change consent; exact-form, bounded body; signed token verified; idempotent existing marketing suppression writer; a DB write failure returns retryable non-2xx status. No subscriber details in responses. Works independently of a marketing-send activation flag.
- `lib/marketing-one-click-unsubscribe.ts`: URL and one-click form validation, source of header target.
- `scripts/test-marketing-one-click-unsubscribe.mjs`: 14 offline tests combining contract checks and executable route behavior with mocked DB writes. No network/provider API called.
- Updated `lib/marketing-provider-one-shot-adapters.ts`, its tests, route-contract registry, and consolidated offline suite.

## Prior Checkpoint 38 work preserved

Bounded streaming Resend contact/topic permission reads; verified Stripe-account cash minimum in pure store-credit split-tender quote; all prior backend and Checkpoint 08 source changes.

## Verification and limitations

`npm run qa:consolidated-offline`: PASS (rerun after changes); 038–060 unapplied migration draft hashes remain pinned and unchanged. Full Next/Jest, TypeScript semantic/build, staging Postgres, browser, Stripe/Resend/Twilio integration remain to be tested with installed dependencies.

**NOT FINISHED:** real split-tender checkout with audited Stripe/Neon ledger; provider clearance for SMS, production marketing scheduler, provider-ready sending, final AI integrations, and Claude's separately assigned CMS/SEO work. This ZIP is not the final merged release.
