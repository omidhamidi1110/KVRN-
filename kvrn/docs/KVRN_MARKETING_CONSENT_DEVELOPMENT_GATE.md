# KVRN Marketing consent — code-side review checkpoint (October 8, 2026)

**Status: development only. Nothing in this file authorizes subscriber import, contact sync, marketing send, migrations, or production deployment.** Production baseline remains `07ac61f` (Worker version separately verified by owner). Changes must receive staged database and provider testing before approval.

## What this local code now enforces

- Both KVRN public email capture UIs require an affirmative **email-only** checkbox. Server endpoints validate an actual `true` boolean and limit request bodies and rates. Phone inputs are not interchangeable with email consent.
- Browser-submitted `source` names are only hints. The audited public-enrollment source is the **server route**; a caller cannot claim that a waitlist request originated in a different UI.
- Existing email opt-outs cannot be silently re-enrolled from a public request. Signup success copy acknowledges receipt of request instead of guaranteeing eligibility.
- Email consent *assertion* events append to proposed migration **044**; this is not proof that the registrant controls the email inbox. Preexisting provider imports are **not** retroactively verified.
- Local email unsubscribe uses signed, contact-bound tokens, with POST confirmation. Legacy bare-email GET URLs cannot unsubscribe others. Local suppression is updated before optional provider synchronization.
- Twilio STOP suppression remains active even when A2P, new subscriptions, and marketing sends are disabled. A verified STOP that **cannot be saved** returns HTTP 503 rather than being falsely acknowledged, allowing retry. SMS JOIN → YES consent verification remains gated behind A2P and two explicit switches.
- Inbound keyword handling also recognizes `OPT OUT`, `OPT-OUT`, `UNSUB`, `REMOVE`, and usual STOP synonyms as suppression requests. These never trigger enrollment.
- Resend contact sync is off unless `RESEND_MARKETING_CONTACT_SYNC_ENABLED=true`. Within a separately approved sync job, subscribed contacts require **another** switch `RESEND_MARKETING_OPT_IN_SYNC_ENABLED=true` plus a **fresh local consent-evidence query**. These do **not** authorize messages.
- Provider upserts never force `unsubscribed: false`. A provider response explicitly marked unsubscribed prevents segment/topic opt-in. Missing provider contact IDs require reconciliation and do not count as successfully synced suppressions.
- A provider opt-out cannot be marked synced without configured **both** Topic and Segment identifiers, successful Topic opt-out, and successful Segment removal. Failure remains queued for reconciliation.
- Suppressions are processed before opt-ins in the provider backlog. Subscriber status is rechecked after an external opt-in attempt, with immediate opt-out reconciliation if a STOP arrived mid-request. On a mid-flight STOP, a returned provider contact ID is preserved for future suppression even if the local status changed. This still cannot eliminate **all** cross-system timing races.
- Campaign review is **editorial only**. A version conflict refreshes the list but preserves unsaved copy and never silently rebases edits. No marketing dispatch route exists.
- Admin Marketing distinguishes local email subscriber rows from affirmative checkbox **assertions**. When migration 044 is unavailable, the assertion count is shown as **Unknown**, not zero. Neither number establishes mailbox control, verified provider eligibility, or authorization to send.

## Why no marketing can be enabled based on this code alone

Provider-level unsubscribe events must be synchronized into the KVRN local suppression ledger from authenticated provider events before any broadcast. Cross-system STOP races cannot be entirely eliminated with a status check; send-time eligibility and transactional audience locks are needed. Postscript suppression/consent provenance has not been validated; Twilio A2P/Advanced Opt-Out setup and keyword webhooks are untested. Resend deliverability, opt-out, bounce handling, and List-Unsubscribe compliance require provider verification. A trusted, atomic reservation for worst-case campaign spending, delivery reconciliation, and per-recipient quiet hours are not operating. Marketing send and AI autonomy remain blocked.

## Before staging release

1. Complete review of migrations 038–047 (in order) on an isolated Neon instance, including a rollback and fresh production backup plan for later approval. Nothing has been applied here.
2. Test concurrent subscribe/STOP scenarios, provider-level opt-outs and bounces, provider ID mismatch, missing DB tables and retries, and exhausted budgets in an isolated environment with sandbox contacts only.
3. Confirm every public form's consent wording/version and proof of consent purpose; require business/legal approval for production activation.
4. Verify provider webhook signature requirements from official documentation before implementing or connecting inbound provider event handlers.
5. Run `npm run qa:consent-offline`, `node scripts/verify-new-syntax.mjs`, then real `npm run type-check`, `npm test -- --runInBand`, `npm run build` and integration/browser tests in Codespaces.

**Rollout principle:** Subscriber counts are local records, not independently verified consent or permission to send. A valid opt-out must remain suppressed even when provider reconciliation is unavailable. Contact synchronization never replaces sending approval.

## Proposed Resend webhook foundation (migration 045, not applied)

The disabled `/api/resend/marketing-webhook` route accepts only a raw-body Svix-signed event after a 16 KB request limit and a five-minute signature timestamp tolerance. It extracts provider **global contact.unsubscribed**, complaints, provider suppressions, and explicit permanent bounces. It does not treat a transient bounce as a permanent opt-out. A signed event is applied by one transactional SQL function which atomically records its provider event ID, sets local marketing suppression, and appends audit history. Duplicate provider event IDs are no-ops. Existing order/transactional-email histories are not rewritten.

Key rotation: only an explicitly configured `RESEND_MARKETING_WEBHOOK_PREVIOUS_SECRET` can act as a second HMAC verification key; remove that configuration after the provider rotation window. Secrets must never be copied to Git, ZIPs, or logs. Both Twilio webhook endpoints enforce 4 KB **streaming** body limits; the delivery-status callback returns 503 on a storage error instead of losing a Twilio retry, and logs no recipient or message ID. `scripts/test-webhook-request-bounds.mjs` exercises oversized chunked bodies, UTF-8 byte counts and invalid encodings without a network connection.

**Not yet supported:** topic-only opt-outs if Resend does not emit the global `contact.updated` event, or all possible legacy multi-recipient payload formats. Those event shapes must be proven with provider fixtures in staging. Do not enable `RESEND_MARKETING_WEBHOOK_SUPPRESSION_ENABLED` until migration 045, HMAC verification, email topic handling, replay tests, provider failure retries, and owner approval are completed. The signing key `RESEND_MARKETING_WEBHOOK_SECRET` must exist only in secure server configuration.

Official reference behavior (reverify before release): https://resend.com/changelog/new-contact-webhooks and https://resend.com/changelog/managing-webhooks-via-api

## Offline checks (not integration sign-off)

`npm run qa:consent-offline` verifies the opt-in source and spend preflight invariants, Resend adapter and Svix verification, chunked-body limits, Postscript aggregate analysis and static mutation guards. These checks do not connect to Resend, Twilio, Neon, Stripe or customer data. The Postscript checker never imports any contact: it treats consent evidence as valid **only when the same active CSV row** identifies the KVRN brand and its signup timestamp/source; duplicate STOPs dominate. Full Jest, production-like SQL migration tests, WebKit and provider fixture tests are still pending in Codespaces/staging.

## Atomic budget reservation design (migration 046, NOT APPLIED)

Migration 046 adds a **default-disabled** DB policy and replaces the disabled
039 budget function with a serialized transaction. It requires an owner-approved
activation of the database switch even to reserve; **no application code exposes
that switch** and no sending worker has been enabled. The DB clamps supplied
caps to its own lower maximums, counts both reserved and settled actual costs,
rejects mismatched idempotency keys, requires an editorially reviewed campaign,
and caps an AI SMS subset separately. It uses a DB advisory transaction lock
so separate Neon HTTP requests do not bypass daily or monthly ceilings.

**Not sufficient to send:** future dispatch still needs immutable, consent-
verified recipient snapshots, provider-confirmed worst-case prices, per-recipient
frequency and local quiet hours, explicit approval, transactional outbox + durable
idempotency, refund/reconciliation of unused reservations, and authorized sandbox
E2E tests. Provider invoiced totals (including subscription/inbound/fees) require
independent reconciliation: they cannot be promised capped by this reservation.

The `scripts/test-marketing-budget-reservations.mjs` assertions are OFFLINE SQL
source checks, not evidence that migration046 runs on PostgreSQL or handles real
concurrent database connections. Migration046 requires separate isolated
PostgreSQL verification and explicit approval before any production change.

## Resend topic/identity hardening — local continuation

**Development-only, not released.** The current Resend global-Contact API supports
`GET /contacts/{id-or-email}`, `GET /contacts/{id}/topics`, and
`PATCH /contacts/{id}/topics` with JSON shaped as
`{"topics":[{"id":"...","subscription":"opt_in|opt_out"}]}`.

- Provider-level `unsubscribed: false` does **not** establish consent for a
  specific marketing Topic. Before opt-in, KVRN reads the current Topic state;
  explicit topic `opt_out`, unknown state, incomplete pagination, and errors
  all block external enrollment. After opt-in, a fresh Topic read and Contact
  read must confirm the intended opt-in and identity. These reads do not
  grant permission to send or override local STOP.
- Unsubscribe now attempts BOTH Topic opt-out and Segment removal even if one
  fails. Both must succeed and the provider must subsequently show an explicit
  Topic opt-out before Neon may mark synchronization complete. Local suppression
  remains active on failure, with retry required.
- If a suppression record lacks its Resend contact ID, KVRN can query by the
  email address and verify an exact identity match before applying the opt-out.
  An already saved provider ID is also compared with the local address before
  modification. Missing/mismatched IDs remain unsynced, never assumed safe.
- A provider topic-only unsubscribe may not emit the same `contact.updated`
  event as a global unsubscribe: the *read-side prevention* now stops an
  ordinary sync from overwriting an existing topic opt-out, but robust
  provider-originated topic-only STOP ingestion and send-time checks remain
  pending. Do not enable subscribed-contact sync or broadcast sends.

Resend reference: https://github.com/resend/resend-openapi/blob/main/resend.yaml
and https://resend.com/blog/unsubscribe-topics . Current API and event shapes
must still be checked in provider staging fixtures before activation.

## Resend topic-only opt-out persistence (proposed migration 047)

Topic-only unsubscribe events may not arrive as `contact.updated` with
`unsubscribed: true`, so a subscribed-contact synchronization that **reads an
explicit opt_out** from the authenticated Resend Topics API now raises a
separate reconciliation signal. The cron calls a one-statement SQL function
that changes the matching (UUID + email) Neon row to `unsubscribed`, stores the
verified contact ID, sets `sync_status=pending`, and appends an immutable
`resend_topic_reconciliation` consent event. It cannot enable marketing.
It then leaves provider reconciliation pending until both topic and segment
opt-outs complete. Database errors do not mark the record synced.

**This is defensive reconciliation, not a substitute for a provider-originated
opt-out webhook or verified send-time suppression.** Migration 047 is NOT
applied. It depends on migration 045 and has offline structural tests only;
its transaction, concurrency, permission, and migration-run behavior must be
verified with isolated PostgreSQL and provider fixtures before use.
