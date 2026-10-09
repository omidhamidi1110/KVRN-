# KVRN Checkpoint 35 — Real Server-Private Recipient Resolution and Claim Composition

**Development only. All migrations 038–060 remain UNAPPLIED. No production deploy or sends.** The owner production baseline is still `07ac61f`; local Git HEAD is a synthetic source-import commit. Claude is independently building the Admin/CMS/SEO half from Checkpoint 8.

## Backend work since Checkpoint 34

- `lib/marketing-claimed-recipient-resolver.ts`: reads a **persisted** marketing claim and its immutable evidence, frozen snapshot, owner approval, budget reservation, and canonical SMS/email subscriber directly from private Neon tables. Rechecks the current local consent event history, approval and reservation state, recipient identity, approved exact message digest, price ceiling, and current UTC budget period. Uses server-side email HTML escaping and a contact-specific signed unsubscribe link. Rejects on unknown, expired, mismatched or revoked facts before contacting a provider.
- `lib/marketing-provider-permission.ts`: independent read-only Resend contact and specific marketing-topic permission check; provider unsubscribe wins and unknown/error blocks. **SMS provider clearance intentionally returns false** until an authoritative Twilio opt-out/reassignment process is provided and tested. Do not interpret A2P approval or local JOIN→YES as enough by itself.
- `lib/marketing-server-execution.ts`: composes the read-only precheck, the existing migration-058 database atomic claim, claimed-recipient resolver, one-shot Twilio/Resend adapter, and migration-060 provisional receipt recorder. Always treats immediate network results as unknown, with no duplicate retry or cost settlement. There is **no route, scheduled job, AI action or other caller**; no live sends can start from installing the source alone.
- Offline tests added for the private resolver, provider permission, and integrated composition and registered in `qa:marketing-server-execution` and the consolidated suite.

## Deployment and compliance release blockers

1. SMS is intentionally **not deliverable** via the current provider-permission adapter. Production Twilio A2P status, Advanced Opt-Out semantics, reassignment safeguards, and legally verified consent must be checked first.
2. Email requires appropriate provider configuration, signed unsubscribe handling, per-recipient time zones, independent consent and budget evidence, and complete staging integration tests.
3. The evidence-row creation workflow has not yet been safely built and tested end-to-end for every recipient, so turning on flags alone must not create any marketing send path.
4. PostgreSQL migrations 038–060 and their locking/idempotency behavior need isolated tests first. **Never rerun 027–037 on production.**
5. Current Stripe checkout assumes cash equals full order total; store-credit checkout and cash-plus-credit ledger integration are NOT production ready. Existing Stripe finalization was not changed.
6. All external provider sends and AI autonomous actions remain disabled. No Cloudflare/Neon production writes or customer outreach occurred.

## Local testing

`npm run qa:marketing-server-execution`

`npm run qa:marketing-provider-transport`

`npm run qa:consolidated-offline`

Full Jest/Next build and PostgreSQL/provider/browser staging integration remain outstanding; syntax-only parser is not a full typecheck. **Do not activate or deploy this package.**
