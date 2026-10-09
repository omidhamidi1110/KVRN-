# KVRN — ChatGPT backend Checkpoint 49 (cumulative, development only)

Contains ALL ChatGPT backend additions through CP49, based on common CP08 ancestor. Claude's independently developed Admin/CMS/SEO branch has NOT been merged. No production migrations, deployment, messages, provider changes or payments.

## Added: reviewed email campaign execution, without an automated send queue

The prior checkpoints implemented verified recipient identity and ephemeral evidence, owner campaign approval and budget reservations, guarded Twilio/Resend single-attempt adapters, signed provider receipts/outcomes, and the one-recipient execution endpoint. CP49 integrates these into a manually initiated email campaign workflow.

`GET /api/admin/marketing/execute-approved-campaign?planId=<uuid>` returns a contact-free review preview: exact recipient count, whether every staged email recipient still has an approved plan, current consent, unclaimed status, current independent recipient proof, and an SHA-256 fingerprint binding each recipient's approval, budget reservation, short-lived evidence and personalized email hash. The fingerprint is only returned for a currently reviewable audience; no customer contact or message body is returned.

`POST /api/admin/marketing/execute-approved-campaign` accepts only the plan UUID, previously returned exact-audience fingerprint, and exact owner confirmation `I AUTHORIZE THE EXACT REVIEWED EMAIL CAMPAIGN`. It requires authenticated configured owner, same-origin bounded JSON, all single-recipient delivery release switches, and an additional `MARKETING_OWNER_CAMPAIGN_EXECUTION_ENABLED=true`. This is **off by default**. Actual production also requires `KVRN_MARKETING_PRODUCTION_OWNER_APPROVED=true`. Nothing was enabled during this development.

The POST fetches the authoritative current audience again, refuses changed/failing evidence, and then submits up to three independent attempts concurrently through the existing claim-before-provider coordinator. PostgreSQL at-most-once claim protection, per-recipient owner approval, provider permission, quiet hours, jurisdiction, price and budget checks remain separately mandatory before each send. A partially failed campaign is reported with private member IDs and `claimed_unknown` for exceptions that could have occurred after a claim; no retry or continuation is scheduled. Provider acceptance is not equated with delivered or billed, and no budget reservation is automatically released. The endpoint intentionally supports EMAIL only; SMS continues blocked pending authoritative opt-out / Twilio A2P proof.

## Test results and unfinished work

`npm run qa:consolidated-offline` passes, including 9 new mocked campaign execution tests, 8 manual one-recipient tests, 7 batch audience evidence checks, 7 global marketing delivery insight tests and the cumulative suite. All provider/DB interactions in tests are mocked: this is functional source, **not a staging-verified release**.

Migration drafts 038–064 remain unapplied. Required: PostgreSQL migration and concurrency integration, Stripe test-mode split-tender/redemption+refund end-to-end verification, real signed provider callback and billing tests under explicit owner staging authorization, Twilio clearance, complete Next/Jest/build/Cloudflare QA and final conflict-safe Claude merge. No customer messages, payments, deployment or provider changes occurred.
