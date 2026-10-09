# KVRN ChatGPT parallel-backend Checkpoint 09 — 2026-10-08

## Baseline and isolation
- **Shared starting point:** Checkpoint 08 created from the owner's verified Git `07ac61f` export. This cumulative ZIP includes Checkpoint 08 and all subsequent ChatGPT-side edits. It is **NOT the live Git commit** and is NOT a deployment.
- Claude is separately working on Admin responsiveness, CMS, product/editor/storefront, SEO/GA4, performance. This ChatGPT continuation owns marketing/consent, Store Credit/finance, Live Analytics, AI Operations/backend tests.
- This checkpoint must be merged by source-path/three-way review with Claude's independently exported branch; don't install both as independent complete websites or assume either branch represents production.

## New functionality since Checkpoint 08
1. `lib/marketing-audience-preview.ts` and `app/api/admin/marketing/audience-preview/route.ts`: Admin-authorized, no-store, aggregated-only draft audience evidence, limited to reviewed campaigns and supported opt-in segments. Independently rechecked SMS keyword proof or email checkbox assertions, excluding explicit local opt-outs. **Advisory counts only**; no addresses/phones exposed; unsupported customer-order join fails closed. These counts are NOT verified provider deliverability, current consent, or dispatch authorization.
2. `db/migrations/048_marketing_editorial_calendar.sql` (**unapplied**), `lib/marketing-editorial-calendar.ts`, and `app/api/admin/marketing/calendar/route.ts`: reviewed-copy editorial planning and cancellation with optimistic campaign-version requirements, bounded future UTC times, one active plan, append-only audit, immutable cancellation history. **This is not a dispatch scheduler or provider job queue.** The UI warns when planned copy is stale.
3. `app/admin/marketing/MarketingClient.tsx`: privacy-limited evidence previews and editorial calendar controls; no send actions.
4. `scripts/test-marketing-preview-calendar.mjs`: 11 offline behavioral/privacy/contract checks, linked to `npm run qa:consolidated-offline` and feature-route registry.

## Checks
- `npm run qa:marketing-preview` **PASS 11/11**.
- `npm run qa:consolidated-offline` **PASS** (all included source-level checks), 245 registered routes/pages, 25 durable feature contracts, 115 changed TS/TSX files parsed, 0 parse failures.
- `npm run type-check` **BLOCKED**: exported dependency tree contains placeholder/missing @types packages (`node-fetch`, `pg`, `react`, etc.). This does NOT establish TypeScript correctness. Full `npm ci`, Jest, Next.js build, real browsers, PostgreSQL and provider tests must run in an isolated Codespaces/staging environment.
- No secrets, customer exports, API calls, production writes, migrations, messages, payments, or deployments were performed.

## Next (ChatGPT-owned)
- Complete consent-aware immutable campaign audience freeze + approval gating, strict budget reservation and fully idempotent non-sending execution staging design, then verified provider integrations in isolated staging.
- Store-credit issuance and redemption with append-only liability ledger, refund/chargeback reconciliation, no double use; separate staging tests and explicit owner authorization before enabling.
- Live View consent/privacy correctness and read-only private AI Operations with bounded tools, authorization and budget guards.

## Merge instructions
- Treat this as cumulative source patch from `07ac61f`. Diff relative to the shared CP08 source to isolate ChatGPT-only changes before merging with Claude's branch. Never overwrite shared Admin/CMS files without a three-way review. Follow final deployment gate before any live changes.
