# KVRN ChatGPT Parallel Checkpoint 32 — Provisional Provider Transport Boundary

## Base and scope
- Cumulative source changes remain based on deployed `07ac61f` owner export, plus ChatGPT's prior Checkpoint 31. Local `git HEAD` is a synthetic import commit, NOT a new production release.
- Claude owns the Admin/CMS/SEO branch separately. This backend-only delta uses distinct module and migration names; merge by three-way review from shared Checkpoint 8.
- **Not a production deploy, not a marketing activation, not an applied migration.** Every new switch defaults OFF.

## New work since checkpoint 31
- `db/migrations/060_marketing_provisional_provider_receipts.sql`: immutable one-per-claim provisional provider receipt record. Correlates existing at-most-once claim and vendor; idempotent identical writes; conflicting evidence rejected; no raw provider ID, phone, email, message content or budget writes.
- `lib/marketing-provider-receipts.ts`: strict provider-reference checks, keyed SHA-256 digest, fail-closed DB writer, and provisional 2xx/4xx/5xx classification. A provider 2xx is **not** delivery evidence.
- `lib/marketing-claimed-provider-transport.ts`: guarded one-recipient transport boundary after a DB claim; checks exact approved copy hash (including email subject), current consent/approval/budget evidence, recipient-local time window, SMS STOP footer/A2P, and email unsubscribe link; never returns verified final status or permits an automatic retry.
- `lib/marketing-provider-one-shot-adapters.ts`: concrete Twilio and Resend single-call adapters; dedicated marketing Resend credentials; confirmed sender-domain syntax, no one-click header falsely claimed; provider receipt correlation.
- Three new offline suites plus `qa:marketing-provider-transport` incorporated into `qa:consolidated-offline`.

## Explicitly NOT done
- There is **no trusted DB resolver** implementing `resolveClaimedEnvelope`: no route or cron invokes the new transport. It must use the canonical claim, subscriber consent, provider suppression, budget, final message/country evidence, and signed unsubscribe token; NEVER accept envelope fields supplied in HTTP JSON. Until that is implemented and staging tested, do not enable provider switches.
- Provider-signed webhook correlation against the provisional keyed message digest is not yet implemented. Pre-existing `059` verified outcome recorder requires independent authentication/correlation before it can be used.
- Store-credit split-tender changes remain staging-only, and checkout's current full-Stripe finalizer has NOT been modified. No production mutation or live charges.
- No applied migrations 038–060, no live sends, no Stripe changes, no external AI execution, no public policy publication.
- Dependency installation, full Jest and Next production build, isolated PostgreSQL concurrency, Twilio/Resend sandbox, and browser integration all remain pending in Codespaces.

## Controls and staged validation
- Each of `MARKETING_SEND_ENABLED`, `MARKETING_PROVIDER_DELIVERY_ENABLED`, `MARKETING_OWNER_SEND_RELEASE_ENABLED`, and `MARKETING_PROVIDER_RECEIPTS_ENABLED` must be explicitly `true` for the claimed transport; Twilio additionally needs `TWILIO_A2P_APPROVED` and `TWILIO_MARKETING_SEND_ENABLED`; email needs `RESEND_MARKETING_SEND_ENABLED` and a dedicated `RESEND_MARKETING_API_KEY` and `RESEND_MARKETING_FROM` on the `kvrn.shop` domain. Keep all false in production.
- `MARKETING_PROVIDER_REFERENCE_PEPPER` is a distinct secret, at least 32 characters, NEVER committed or logged. Its stability is essential for later signed webhook correlation.
- Standalone tests: `npm run qa:marketing-provider-transport`.
- Full offline regression: `npm run qa:consolidated-offline`.
- Migrations: none run. If staging is approved, apply unrun migrations sequentially and verify SQL functions plus races there first; never repeat production 027–037.

## Next safe coding step
Implement a **server-private claim resolver** that atomically rechecks actual subscriber/provider suppression, owner approval, approved final message, recipient timezone/frequency, per-recipient verified cost and budget, and validated unsubscribe material. It must not use browser-supplied contacts. Then add signed Twilio/Resend callback correlation and full staging-based integration tests before enabling any sends. Subsequently complete store-credit checkout ledger/Stripe reconciliation in an isolated transaction test DB.
