# ChatGPT KVRN backend cumulative checkpoint 24 (2026-10-08)

Owner's production baseline remains `07ac61f`; these source changes have NOT been deployed. All new Neon migrations 038–058 are unapplied. This ChatGPT development branch is separate from Claude's Admin/CMS/SEO work; resolve overlaps in a three-way merge.

## Added staging-only marketing at-most-once claim architecture

`db/migrations/058_marketing_at_most_once_claim.sql` adds private, append-only:

- Per-recipient provider/suppression, region, timezone, frequency, final-message and actual-pricing **evidence records**, expiring within five minutes; evidence hashes do not contain raw contacts.
- A single, transactional claim per recipient and plan. Lock order matches the existing serialized budget and staged-plan functions. Requires unexpired explicit owner approval, current campaign version, current double-opt-in/consent, verified evidence from **every** recipient, actual summed per-recipient worst-case prices covered by the reserved budget, local-time window, and the contact frequency limit.
- `unknown` attempt state *before* any prospective external API call; duplicate idempotency claims fail rather than retrying the provider.
- Immutable provider-result references. Unknown outcomes remain blocking indefinitely until independently verified; previous accepted sends are frequency-limited.

**No sender was installed.** No HTTP provider API, marketing cron worker, authenticated reviewer workflow to generate trusted evidence, or permission to send is available. The DB policy remains `dispatch_enabled=false`. This is an execution safety prerequisite, not the finished dispatch feature.

New `scripts/test-marketing-at-most-once-claim.mjs` has 16 offline checks. Added to `npm run qa:consolidated-offline`.

All previous work, including ChatGPT CP23 live-read marketing release audit and CP22 test-mode store credit capture writer, is included cumulatively. Full Jest/Next/PG/Stripe/Cloudflare/Twilio/Resend browser E2E testing remains deferred pending Codespaces dependency setup and owner/provider approval.
