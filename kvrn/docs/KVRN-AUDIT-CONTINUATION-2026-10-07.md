# KVRN merged AI OS + Task 6 — adversarial audit continuation, pass 1

**Source:** `91f8655` archive supplied October 7, 2026. **Target:** one merged AI workforce + Admin/Product/CMS/commerce codebase. **Status:** source-level patch made; NOT committed, deployed, migrated, or approved for production. All rollout/autonomy/marketing flags remain OFF. No existing migrations changed.

## Confirmed fixes in this patch

1. **Affiliate compliance fail-open (`app/api/admin/affiliates/compliance/route.ts`).** Failed document lookup was replaced with an empty list, suggesting no active policies. A failed read now makes the GET fail visibly rather than misrepresenting active legal documents.
2. **AI Chief governor failures (`lib/ai/chief.ts`).** The governor was called after approved action processing, with its errors swallowed. The governor now runs first. If it fails, no approved actions are processed in that cycle. Maintenance errors are recorded/logged and cause the Chief cron to return a failure, **after** attempting the daily brief.
3. **Atomic AI autonomy downgrade (`lib/ai/governance.ts`).** The agent downgrade, admin audit record, and Chief-visible governance alert now share one database statement. An audit or alert failure rolls back the downgrade; concurrent owner changes still prevent an outdated downgrade.
4. **Media-admin mutations (`app/api/admin/media/[id]/route.ts`).** Metadata update + audit are atomic and report missing rows. Hard delete + audit are atomic, with a second in-DB usage/collection check immediately before deletion. If R2 cleanup fails after database deletion, the response exposes `storageCleanupPending: true` and the private admin audit retains keys for manual cleanup, rather than silently dropping the error.
5. **External connector state (`lib/ai/integrations/repository.ts`).** A connection state update now uses `RETURNING id` and throws when its row is missing. A successful fetch can no longer silently masquerade as a persisted Ready state in that situation.

## Verification run on patched source

- `npm run qa:adversarial` — **PASS**, 15 source-level regression assertions. Also invoked through `lib/__tests__/adversarial-continuation.test.ts` when Jest is available.
- `npm run qa:contracts` — **PASS**: 225 routes/pages, 21 routed features, 23 durable contracts.
- `npm run qa:ai-boundaries` — **PASS**: 54 AI/control-plane source files.
- `npm run qa:ai-imports` — **PASS**: 54 source files.
- `npm run qa:ai-readiness` — **PASS**.
- Global TypeScript compiler's `transpileModule` syntax check — **PASS** for the modified TypeScript modules and the new Jest test file. This is **not** a full type-check.
- `npm run qa:change-coverage` — **SKIPPED** by the existing guard: this source-only archive has no `.git` or comparable base SHA.
- `npm ci --offline` — **BLOCKED** (`ENOTCACHED`, missing `youch-core` tarball). Network npm install also failed to make progress and was stopped. This environment therefore **did not run Jest, full `tsc --noEmit`, Next build, OpenNext build or real DB tests.**
- SQL CTE changes were inspected against migrations `001`/`036`; **not tested on a real migrated Neon/Postgres database**. A realistic test database must validate runtime/constraint/locking behavior before deployment.

## Still open / next audit focus

- **Unreviewed success/degradation paths**: `lib/product-service.ts` duplicate-media usage sync has a broad catch after creation; the bulk-action summary audit INSERT can be swallowed; `lib/ai/events.ts` swallows failure when marking an event as failed; `lib/ai/agents/video-performance.ts` swallows terminal action-write failures. Determine if these require atomic outbox/repair state rather than converting a committed business change into a misleading HTTP retry.
- **Concurrency/integration:** audit non-atomic post-commit media-usage sync, affiliate cross-workflow races, provider snapshots and state transitions; test with concurrent database clients and induced failures.
- **Production prerequisites:** verify migration `027`–`037` on a restored realistic copy and production migration ledger; final TypeScript/Jest/Next/OpenNext suite in Codespaces; staging auth/browser/Stripe Radar/webhook + checkout and Cloudflare Workers tests; verify that actual repository-root `.github/workflows/deploy.yml` is active.
- **Do not activate:** AI inference until authenticated Gateway + hard cap are verified; autonomous outbound/support/recovery/review/creator sends; automatic ad spend/storefront/PO/money/legal/destructive actions. Keep the real production Stripe transaction for final end-to-end launch QA.

## Source and delivery

This patch is based on `91f8655`; **it does not claim a new Git commit**. Apply it to the exact merged branch (after safeguarding local edits), review the diff, then commit/test through the actual repository. The original uploaded ZIP was not modified. Two packaging choices: full merged source with the patch, or a small overlay containing only changed/new files. Never apply the overlay to Claude's older Task 6-only source.
