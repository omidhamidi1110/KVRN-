# KVRN ChatGPT backend Checkpoint 46 — cumulative, development-only

Builds on CP45 (all prior work preserved). Claude's separate branch has NOT been merged. No production deploy, migrations, sends, payments, or provider changes.

## Added: Resend email delivery evidence and operational flow
- New owner-only `GET /api/admin/marketing/recipient-evidence?planId=<uuid>` returns staged email audience *IDs, evidence expiry/approved message hashes, owner approval/budget reference and previous-claim status* without exposing email, phone, provider contact IDs or raw evidence.
- `POST /api/admin/marketing/recipient-evidence`: owner attests independently reviewed jurisdiction/timezone evidence for a specific member; the backend verifies latest local opt-in, owner approval, current campaign version, quiet hours and recent attempts; performs a separate fresh read-only Resend contact/topic check; uses owner-verified server-side provider cost evidence; constructs deterministic signed List-Unsubscribe landing link; calculates recipient-specific final HTML copy hash; and inserts an immutable four-minute evidence row through SQL migration 064. No transport or automatic retry.
- Corrected the still-unapplied migration 058 claim's *audience aggregate* check: every recipient must have fresh evidence, but different recipients have different email message hashes because each unsubscribe token is personalized. The specific claimed recipient continues to require its exact hash. See `scripts/test-marketing-email-recipient-evidence.mjs`.
- Existing single-recipient, manually authorized LOCAL development marketing transport remains the only reachable sender. Bulk/production sends remain off. Twilio SMS still blocked until independent authoritative permission and A2P verification exist.
- One-shot claim, owner review, separate budget, fresh consent and signed provider callback remain mandatory; 064 does not bypass them. The owner attestation is not an automated legal determination or verification of deliverability.

## Dependencies / gates
`MARKETING_EMAIL_RECIPIENT_EVIDENCE_ENABLED=true` gates reviewer writes. `MARKETING_OWNER_APPROVAL_EMAIL` must match admin owner. `MARKETING_EMAIL_VERIFIED_WORST_MICROS`, `MARKETING_EMAIL_VERIFIED_PRICE_SOURCE`, and `MARKETING_EMAIL_PRICE_OWNER_VERIFIED=true` must reflect an independently reviewed actual provider worst-case price source; do not guess costs or activate in production. `MARKETING_PROVIDER_PERMISSION_CHECK_ENABLED=true`, Resend API key and contact/topic configuration required for live check. DB marketing dispatch policy remains independently default-disabled. No flags have been enabled by this work.

## Testing / limitations
`npm run qa:consolidated-offline` includes 10 recipient evidence tests and the inherited backend suite. All SQL files through draft 064 hash-pinned and unapplied. No isolated Postgres transactional test, authenticated provider read, Next production build, Jest regression test, signed provider callback E2E, or actual email delivery has run. **Not production-ready.**

## What remains
- Complete isolated migration/application testing and Stripe test-mode split-tender E2E with reconciliation of provider-uncertain sessions.
- Verified legal/timezone cost and Twilio opt-out status; SMS A2P approval; prove full delivery across signed callbacks, cost evidence and no-repeat scheduling in staging; production activation only by owner.
- Additional AI Operations integrations, final branch merge and full testing with Claude's CMS/SEO changes.
