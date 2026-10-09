# KVRN — ChatGPT backend Checkpoint 47 (cumulative, development only)

Continuation after CP46. Includes all CP41–CP46 changes, with CP08-based conflict-aware Claude merge. Claude branch is unmerged. No deployment, production DB migration, customer SMS/email, payments, or provider config changes.

## New: global Marketing Suite delivery health in AI Operations
- Added `lib/ai/marketing-delivery-insight.ts`, a fixed read-only SQL aggregate of staged/cancelled plans, original audience items, at-most-once claims, final verified provider outcomes, provisional acknowledgements/rejections/uncertain results, missing provisional receipts and still-valid recipient evidence; reconciles counts and computes age of oldest unknown outcome.
- `getPrivateInsight('marketing-delivery')` works in the existing owner-only private insights API; the seven-topic `operations-brief` now includes marketing delivery. Claude owns frontend presentation; no Claude UI code edited.
- Read-only report does not treat a provisional provider acceptance as verified delivery, does not release budgets or authorize retries. If migrations are missing or SQL inconsistent, returns unavailable instead of a false zero.

## New: batch evidence preparation for owner-reviewed Resend contacts
- `POST /api/admin/marketing/recipient-evidence-batch` accepts 1–50 *individually owner-reviewed* recipients and reuses the CP46 single-recipient verified-preparation path. The API is owner-only, same-origin protected, JSON size limited, feature-gated, and cannot transmit email.
- Uses up to four concurrent independent current provider/consent/approval/legal/timezone/budget evidence checks; no retry and no automatic delivery. Validates exact allowlist, unique members and legal-review confirmation. Partial failures are returned per member ID without raw email, phone, provider contact, pricing source or error text.
- The batch is a workflow tool, not a safe-to-send signal: signatures/evidence expire in four minutes; every message still needs the existing atomically locked claim and final resolver recheck, with a staging test required.

## Tests / activation status
- New `scripts/test-ai-marketing-delivery.mjs` 7/7; updated `scripts/test-ai-private-insights.mjs` 15/15; new `scripts/test-marketing-email-batch-review.mjs` 7/7.
- `npm run qa:consolidated-offline` passed (strict SQL/type syntax/route checks and all inherited offline suites). DB and provider access mocked. Entire Next build, Jest, Postgres, Stripe test payments, signed real provider receipts, Cloudflare Worker staging and concurrency tests still unverified.
- Migrations 038–064 unapplied; stage them only after exact hash-pinned compatibility rehearsal. Resend/Twilio marketing sending and store-credit live payments remain disabled pending owner authorization and end-to-end validation.

## Next integration blockers
- Execute real isolated Postgres migration+SQL concurrency tests, then test Stripe cash+credit payment and return restoration against test-mode Stripe (with explicit user authorization before changing any connected service).
- Validate webhook behavior, refunds, session expirations and at-most-once delivery at actual provider sandbox/test endpoints. SMS still requires authoritative Twilio opt-out/reassigned-number clearance and A2P approval. Email campaigns require owner-approved legal jurisdiction and provider-priced costs.
- Merge only via CP08 ancestor comparison with Claude's current branch after both parts are complete; do not overwrite her files or deploy directly.
