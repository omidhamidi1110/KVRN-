# KVRN NEXT CHAT HANDOFF — 2026-10-08, ChatGPT development checkpoint 41

## Which ZIP to use
- **KVRN_CURRENT_CHATGPT_SOURCE_CP41_2026-10-08.zip** is the entire ChatGPT-side working source tree, materialized from the shared CP08 source with the validated CP41 ChatGPT-only delta overlaid. It is for coding/review in the new chat; do **not** deploy directly.
- **KVRN_CONSOLIDATED_CHATGPT_PARALLEL_CHECKPOINT_41_2026-10-08.zip** is the cumulative recovery *patch* against the owner's 07ac61f repository, including CP08 changes and everything subsequently developed by ChatGPT. It is not the complete original repository. Contains 309 modified/added file changes, manifest, staged files, and application script.
- **KVRN_CHATGPT_ONLY_DELTA_CP41_FROM_SHARED_CP08_2026-10-08.zip** is a conflict-aware 156-file delta *after CP08* specifically for eventually merging with Claude's independent Admin/CMS/SEO work. Use preview mode first, never blindly overwrite Claude's files.

## Established production baseline and safety rules
- Last user-confirmed production Git commit: `07ac61f` on branch `kvrn-audit2-verified-integration` (Cloudflare Worker `kvrn`, previously identified Worker version `b06eff32-03d9-4265-8198-2867a9c3871e`). New code is **local only**; never assume a newer production commit.
- Neon production migrations **027–037 completed**. Do not rerun. New migration drafts **038–060** exist in this ChatGPT branch but are **NOT applied**; a preflight/hash guard exists, which is not a database migration test.
- Never deploy, run production migration, change stock/order/price/refunds/payouts, send texts/emails, use live Stripe payments, or enable external AI without explicit user approval.
- SMS/email marketing and store-credit customer redemption are not production-ready; default-off gates stay off. Preserve Stripe finalization, FIFO, COGS, double-entry/ledger invariants, unknown-not-zero expense semantics, and suppression records.
- The user wants ChatGPT itself to code this half, no Claude on this half. Claude separately owns **Admin responsiveness, CMS, storefront policy/FAQ, Google-first SEO, GA4, Merchant, frontend performance/accessibility**. ChatGPT owns **Twilio/Resend Marketing Suite, consent/budgets/delivery, store credit, financial backend safety, Live View, AI Ops, backend tests**. Merge later from common CP08 with conflict review. Do not merge until Claude's actual files are supplied.
- User requests continuous progress with cumulative checkpoints and a **single final integration/install**. An interrupted chat cannot continue running; save recovery ZIP frequently.

## Current ChatGPT-side state (CP41)
Source work includes: hardening SMS two-step consent (JOIN->YES), STOP suppression, Postscript dry-run import checks; email affirmative consent/unsubscribe/suppression, signed Resend webhooks, provider check bounds; versioned campaign templates/drafts, owner approval, audience evidence previews, snapshots, editorial calendar; budget reservations and settlement logic, delivery-plan recipient claims, at-most-once guarded one-shot Twilio/Resend adapters, signed callback correlation and provider outcome recovery; first-party Live View aggregates; store-credit liability ledger foundations, read-only reconciliation, return issuance, test-mode holds/capture/release, split-tender/refund calculators, owner Admin UI, reconciliation/audits; read-only AI operational insights for inventory/payment exceptions/affiliate payout integrity; disabled Merchant feed, SEO audit, fallback legal copy, CMS formatting, earlier Admin responsive changes in CP08.

These include serious *foundations*, NOT completed functional marketing sending or customer-facing full split-tender checkout. Existing Stripe order finalizer assumes Stripe cash equals the full order amount; do not bridge store credit by inserting a discount. Need staged accounting rewrite with cash-plus-credit and real tests.

## Verification to date
- `npm run qa:consolidated-offline` passed at CP41, including consent, costs, marketing state, SQL-migration draft hashes and source-route contracts.
- ZIP archives checksum/integrity verified. This assembled full-source ZIP is independently verified against every file SHA-256 in CP41's merge manifest.
- Full semantic TypeScript, Jest/Next build, browser WebKit, isolated PostgreSQL migration concurrency, Stripe and provider integration, and production end-to-end checks are *not complete*. Earlier typecheck attempts blocked by missing dependencies in exported tree.
- No new production changes.

## Next safe coding tasks (not done)
1. Prioritize **full split-tender integration** through checkout, order snapshots, cash-vs-credit reconciliation, refund behavior, Stripe idempotency, and inventory semantics, with isolated DB tests; don't alter production finalizer blindly.
2. Complete end-to-end marketing dispatch orchestrator under explicit owner approval and consent, reconciling budget/callback outcomes; do not create an autonomous live sender. Verify recipient provider opt-out and legal/quiet hours before sends.
3. Complete read-only AI Ops/workflow features and backend QA, then merge Claude changes via `preview_or_apply.py` *preview* first.
4. Full isolated test/build/migration verification and provider-staging checks; legal review and user approval before any publishing/deployment.

## Important instructions for next assistant
Read this entire document and inspect the uploaded **full source ZIP** and the latest relevant audit/spec files before editing. Do not infer changed production state. Keep a cumulative checkpoint and a *ChatGPT-only delta from shared CP08* so merging does not silently overwrite Claude work. Report actual tests rather than describing unverified code as complete. Confirm any critical provider docs when integrating. Never ask the user to install intermediate checkpoints. The user values speed but financial integrity and messaging consent are non-negotiable.
