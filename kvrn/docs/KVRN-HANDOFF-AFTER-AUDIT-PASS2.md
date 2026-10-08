# KVRN — Continued handoff after Audit Pass 2 (2026-10-07)

**The current deliverable is the Pass 2 source archive.** It contains both Claude Task 6 Admin/CMS/affiliates and the 11-department AI OS, the previous Audit Pass 1 fixes, and the new Audit Pass 2 corrections. It is **not a Git commit**: `91f8655` identifies the source ancestry; Pass 1/2 fixes were made after this checkpoint in the supplied ZIP copy.

- Complete current source: `KVRN-MERGED-AI-ADMIN-AUDIT2-COMPLETE-SOURCE.zip`.
- Changes since Pass 1: `KVRN-AUDIT-PASS2-OVERLAY.zip`.
- Detail: `docs/KVRN-SECURITY-AUDIT-PASS2.md` within complete source, also supplied as a separate report.
- Both workstreams remain merged; Claude's development occurred before ChatGPT's later merge/hardening.
- Code syntax/transpile 695 files PASS, existing AI/QA safety-contract checks PASS, new Pass2 contracts+input tests PASS.
- **Full npm install, type check, Jest, Next build, Cloudflare integration, Stripe and Neon tests unverified. No production deployment.**
- New fail-closed rate limits require production migration 037 + `PUBLIC_API_RATE_PEPPER` + Cloudflare client-IP header to be working **before this new source is deployed**. Without these, checkout and other routes will return 503.
- Restock signup was lying about success without persisting anything. It now returns 503 until a real feature is built. Hide any storefront UI promising restock alerts until then.
- Do not enable AI autonomous actions, lifecycle outbound sends or new CMS features until the tests and rollout gates pass.

## Original complete handoff preserved below

---

# KVRN — Complete AI OS / Task 6 Handoff (Merged Workstreams Verified)

**Handoff date:** 2026-10-07  
**Current branch:** `ai-os-build-5cce4f1`  
**Current HEAD:** `91f86555952f1729b3c9b3ecc0c91745850a1a41` (`91f8655`)  
**Working tree:** NOT CLEAN  
**Local baseline commit:** `3f82c71` = archive baseline corresponding to original KVRN source commit `5cce4f1`.

## 1. What this branch is

This is the current merged KVRN development branch containing:

1. The original `5cce4f1` KVRN baseline.
2. The KVRN AI Operating System foundation and hardening.
3. The Claude **Task 6** checkpoint that was handed off and merged into the AI-OS branch.
4. Post-merge AI/CMS/security integration work.
5. The latest security-hardening checkpoint (`91f8655`).

**Chronology clarified by the project owner on 2026-10-07:** Claude's Task 6 work, including the Stage 1 audit/fixes described in the earlier Claude handoff, happened **before** the subsequent ChatGPT AI-OS integration and security hardening. Do not assume a newer parallel Claude branch exists; request additional Claude snapshots only if concrete evidence of omitted work appears. The latest supplied merged reference is `91f8655`.

## 1a. Explicit combined-workstream confirmation — verified against attached source archive

Both major development streams are included in **one KVRN source archive** (`KVRN-ai-os-current-91f8655(1).zip`), rather than merely described in separate plans. ZIP integrity was checked and the following source files were confirmed present. This confirms file-level coexistence and concrete integration points; it is **not** a claim that the full app was compiled, deployed, or end-to-end tested.

**Stream A — ChatGPT AI workforce / AI Operating System:**
- Eleven main AI departments/agent roles, with the Chief Operator, centralized model routing, approvals, alerts, cost budgets, safeguards, and the Admin AI Operations interface (`app/admin/ai/`, `lib/ai/`, `app/api/admin/ai/`, `app/api/internal/ai-chief/`).
- AI database foundation and security hardening (`036_ai_os_foundation.sql`, `037_security_hardening.sql`).
- Model inference and autonomous/outbound actions remain gated pending complete QA and deliberate activation.

**Stream B — Claude Task 6 Admin overhaul / CMS / commerce:**
- Admin UI refresh; product listing, creation and editor, media library, R2/CMS surfaces; site/content collections; page/legal/support editing; bundles and Complete the Set; affiliate program and portal; fraud review and order tags; abandoned checkout; i18n, RTL and estimated foreign-currency displays.
- Located throughout `app/admin/products/`, `app/admin/media/`, `app/admin/content/`, `app/admin/financials/affiliates/`, `app/affiliate/`, `app/api/admin/products/`, `lib/product-*`, `lib/content-*`, and migrations `027`–`035`.
- Known original Task 6 gaps and unresolved consent/legal/security/test decisions remain subject to review. Do not infer all UI functions are complete, legally approved, or production-enabled from file presence alone.

**Evidence that they are integrated, not merely adjacent:**
- The shared `components/admin/AdminShell.tsx` navigation links to `/admin/ai`, `/admin/products`, `/admin/content`, `/admin/media`, `/admin/financials/affiliates`, and `/admin/abandoned-checkouts`.
- The AI Creator/Affiliate monitor in `lib/ai/agents/creator-affiliate.ts` queries Task 6 canonical `affiliate_applications`, `affiliate_profiles` and `affiliate_email_outbox` data alongside its AI prospect tables.
- SQL migration numbering is continuous across the Claude CMS/commerce set `027`–`035` and the AI OS/security set `036`–`037`.
- The handoff records the integration commits `732b0d7` and `4f8bbcb` and final hardening `91f8655`. The source ZIP does not contain `.git` history, so commit ancestry is documented by the handoff rather than independently proven by `git log` inside the ZIP.

**Verification boundary:** The archive passed ZIP integrity validation and the named files/integration points were inspected. No clean dependency install, complete type-check/test/build suite, staging browser review, production migration, live Stripe test, or Cloudflare runtime QA was performed as part of this verification. The final release remains **built/integrated at source level, not production approved**.

## 2. Commit chain to preserve

```text
91f8655 (HEAD -> ai-os-build-5cce4f1) Harden merged Task 6 security boundaries
4f8bbcb Integrate Task 6 with AI OS migration and QA contracts
732b0d7 Merge Claude Task 6 into hardened AI OS
c11afc8 (claude-task6-final) Integrate Claude Task 6 admin CMS commerce affiliates
5313618 Harden AI OS reliability, budget, providers, and alerts
dfb08c5 Build KVRN AI operating system foundation
3f82c71 (master) baseline 5cce4f1
```

Relevant checkpoints:

- `dfb08c5` — initial KVRN AI Operating System foundation.
- `5313618` — AI OS reliability, budget, provider, alert, queue, QA, security hardening.
- `c11afc8` — Claude Task 6 CMS/admin/commerce/affiliate checkpoint.
- `732b0d7` — merged Claude Task 6 into hardened AI OS.
- `4f8bbcb` — integrated Task 6 with AI migration numbering and QA contracts.
- `91f8655` — latest merged Task 6 security-boundary hardening.

Do **not** restart from `dfb08c5`. Resume from **`91f8655`** or a later descendant.

## 3. AI workforce implemented

The architecture contains 11 main departments:

1. Chief Operator
2. Growth & CRO
3. Ads & Social
4. Creator & Affiliate
5. Market Intelligence
6. Lifecycle Revenue
7. Customer Support
8. Product, Inventory & Supply
9. Finance, Attribution & Risk
10. SEO, Commerce & Data
11. Engineering, QA & Security

Specialized functions underneath them include Review Growth, Video Performance, Supply Planning, Feature Verification/Regression QA, model evaluation, market research, attribution health, external connector monitoring, and automatic autonomy downgrade.

## 4. Major systems completed

### AI Operations control plane
- `/admin/ai` AI Operations dashboard.
- Overview, Agents, Approvals, Activity, Alerts, Spend, Performance, QA, Evals, Social, Research, Supply, Connections, Settings.
- Server-side agent registry and autonomy controls.
- Append-only AI action/model/audit logging.
- Owner approval records and governed action executor registry.
- Red/high-risk actions cannot enter the AI execution approval path.
- Agents can automatically **lose** autonomy after poor performance/owner rejection; they cannot auto-promote.

### Chief Operator / Pushover
- Chief is the only AI notification gatekeeper.
- Minimum one deterministic daily executive Pushover after configured local hour.
- Daily brief can include revenue, orders, traffic/CVR, ad spend, contribution status, QA, support backlog, creator activity, approvals, alerts, AI activity, and AI spend.
- Daily brief does not require paid inference.
- Alert dedupe, leases, retries, stale-claim recovery, quiet hours, emergency bypass, normal push ceiling.
- High/Critical and owner-required items bypass normal push quota.
- Resolved incident is rechecked immediately before Pushover send to avoid stale pushes.
- Existing KVRN notification sources can be routed through Chief behind rollout flags.

### AI cost control
- Central `lib/ai/router.ts`; business agents cannot call providers directly.
- Atomic worst-case reservation before model calls.
- DB-level `$4` operational ceiling and `$5` absolute owner ceiling.
- In-flight reservations count against available budget.
- Expired ambiguous reservations are conservatively treated as committed spend, not silently released.
- Malformed/missing provider usage falls back to reserved worst-case cost.
- Text estimation intentionally over-reserves for safety.
- Production model calls require authenticated Cloudflare AI Gateway.
- Provider-native requests use BYOK-only defense (`cf-aig-no-wholesale: true`).
- Production activation requires explicit external cap confirmation and numeric `AI_EXTERNAL_BUDGET_CAP_USD <= 5`.
- No direct-provider production bypass.

### Model routing / provider hardening
- Haiku 5.5: routine/bulk tasks.
- Gemini 3.8 Flash: short video/social analysis.
- Sonnet 5.5: business/CRO/market reasoning.
- GPT-6.1 Sol: finance-heavy reasoning.
- GPT-6 Luna: manual evaluation challenger.
- Claude 5.5 request shape corrected (no unsupported sampling assumptions).
- Sol reasoning/output headroom hardened.
- Gemini video offsets/request path and conservative token reservation hardened.
- Provider JSON response size bounded.
- Slow/model-capable events are throughput-limited separately from deterministic queue work.
- Ambiguous crashed paid calls are not blindly replayed and double-billed.

### Security / prompt-injection / privacy
- External customer emails, reviews, DMs, webpages, and video metadata treated as untrusted data.
- Untrusted wrappers escape structural delimiter characters.
- No raw arbitrary SQL tool for agents.
- PII/secrets minimized before model use.
- Admin AI routes require admin authentication; internal Chief/QA/cron routes require internal secrets.
- Public research has SSRF defenses, redirect revalidation, bounded body/time, and hardened hostname handling.
- Meta tokens moved out of URL query strings.
- Public API rate limiting/security-hardening migration added in `037_security_hardening.sql`.
- AI boundary CI guard prevents provider calls outside approved layer and Pushover outside Chief.

### Reliability / queues / idempotency
- Event queue leases and stale-lease recovery.
- Exhausted final-attempt events become terminal and generate Engineering/QA visibility instead of remaining stuck forever.
- Approval/executor actions fail closed and are idempotent.
- Action completion ordering hardened so `complete` means downstream effects finished.
- Paid video/model failure does not automatically re-trigger an expensive call.
- Cheap deterministic monitors can process more frequently; slow/model-capable events are capped to one per Chief cycle.

### Support
- Inbound support shadow triage integrated with existing support inbox.
- Order/policy context can be retrieved through controlled tools.
- High-confidence architecture prepared, but autonomous customer-facing replies remain deliberately disabled until canonical final policy/template merge and live QA.

### Lifecycle / Review Growth
- Abandoned checkout candidate monitoring.
- Neutral post-delivery review eligibility queue.
- No sentiment gating / no positive-review manipulation.
- Actual outbound recovery/review sending remains intentionally gated until final canonical consent/templates/endpoints are verified.

### Growth / CRO
- Funnel anomaly detection with minimum sample thresholds.
- Does not create conclusions from tiny traffic samples.
- High-confidence findings can create governed Yellow experiment proposals.
- CRO approval records the decision; it does not directly alter storefront/pricing.

### Ads / Social
- Deterministic ad/social health monitoring.
- Controlled short-video analysis path through Gemini.
- Video duration/input limits hardened and finite/clamped.
- Signed/media URLs are hashed for idempotency/log identifiers instead of stored raw where avoidable.
- Meta/TikTok evidence connector adapters exist and are disabled until credentials/permissions are connected.

### Creator / Affiliate
- Creator/Affiliate pipeline monitoring integrated with the merged affiliate system.
- Claude Task 6 affiliate application, portal, compliance, payout readiness, documents, profiles and Admin surfaces are present in this branch.
- Outbound autonomous creator DMs/negotiation remain gated.

### Market Intelligence
- Admin research-target management.
- Approved public URL fetch, content hashing, change detection.
- No model call if content has not changed.
- SSRF/redirect/body/time defenses.
- Evidence-focused analysis with unknown/estimate distinction.

### Product / Inventory / Supply
- Deterministic inventory velocity/stockout monitoring.
- Supply profile support: lead time, MOQ, safety buffer, target cover.
- Reorder recommendations are governed; no automatic PO placement.
- Inventory incident dedupe/lifecycle auto-resolution.

### Finance / Attribution / Risk
- Uses existing canonical KVRN financial calculations; AI does not become the accounting engine.
- Contribution/profit/ad-spend/attribution/payment exception/reconciliation monitoring.
- Incomplete/unreconciled data is not presented to AI as exact profit truth.
- Sol is used only for material finance interpretation.
- Financial-risk alert lifecycle and overnight escalation hardened.

### SEO / Commerce / external evidence
- Google Search Console and Merchant evidence adapters.
- Merchant pagination follows `nextPageToken`; partial dataset is rejected rather than treated as healthy.
- Google refresh token is authoritative over temporary access token when available.
- External evidence snapshots are size bounded; oversized/partial evidence fails the sync.
- Provider integration is marked Ready only after required evidence is durably persisted.

### Engineering / QA / automatic feature verification
- QA feature registry and per-feature status/evidence.
- Route-contract guard: new routes/pages cannot silently appear without QA classification.
- Change-test-evidence guard: major behavior changes inside existing routes must be accompanied by QA/test evidence.
- AI boundary guard.
- Local AI import-resolution guard.
- AI readiness/safety-default guard.
- Real-browser smoke path: storefront → Shop/PDP → variant/control → cart → checkout entry; never submits a real payment.
- Mobile render/overflow checks.
- CI QA reporting to AI Operations.
- Current contract inventory around this checkpoint: 135 registered routes/pages and 13 durable feature-contract groups (rerun guards after any further merge).

### Claude Task 6 merged into this branch
Current branch also includes the Task 6 checkpoint for:
- CMS/content system.
- Product catalog/editor/admin product flows.
- Media library/R2-related surfaces.
- Bundles.
- Site/page/legal/support content CMS.
- Order tags/fraud review.
- Abandoned checkout surfaces.
- Affiliate program + portal + compliance/payout readiness.
- Localization/currency/i18n.
- Admin UI/system additions.

## 5. Migrations in the merged branch

The important current sequence is:

```text
027_cms_foundation.sql
028_product_catalog_cms.sql
029_bundles.sql
030_site_content_cms.sql
031_order_tags_fraud_review.sql
032_abandoned_checkouts.sql
033_affiliate_program_core.sql
034_affiliate_portal_compliance_payouts.sql
035_localization_currency.sql
036_ai_os_foundation.sql
037_security_hardening.sql
```

Do **not** renumber already-applied production migrations. Before production, verify which migrations actually exist in production and apply only verified unapplied ones using the project's normal migration process.

## 6. Latest hardening issues already found and fixed

The hardening pass caught real failures, including:

- AI events could remain `processing` forever after a Worker crash.
- Approved executor actions could remain `running` forever.
- Budget UI could omit in-flight reservations.
- Invalid pricing/env values could cause cost underestimation.
- A broken daily-summary subsystem query could cancel the whole Chief Pushover.
- Handlers could mark an action complete before its alert/downstream effect finished.
- External text could forge the old XML-like untrusted-data delimiter.
- Provider success with missing/malformed usage could be recorded as `$0`.
- Claude 5.5 requests could fail from incompatible sampling parameters.
- Sol reasoning requests needed different sampling/headroom treatment.
- Gemini video token reservation/offset/API assumptions needed correction.
- Video failure could trigger automatic paid retry.
- Merchant sync could silently read only a partial first page.
- QA payload and external evidence payloads needed hard size bounds.
- Signed video URLs could leak into idempotency keys.
- DB budget ceiling needed to be immutable at SQL level.
- Final-attempt stale queue events could remain dead forever.
- External budget-cap confirmation was only boolean and needed an explicit numeric cap.
- `ai_agents.updated_by` was referenced before schema support existed.
- Agent heartbeat/status was decorative instead of derived from real work.
- HIGH alerts could be incorrectly demoted by ordinary push quota.
- Connector state could race `Ready` against a failed evidence write via `Promise.all`.
- Incident dedupe keys could change with counts/SKUs and leave stale open alerts.
- Model/provider response parsing was unbounded.
- Budget month reset used UTC instead of owner business timezone.
- Runtime settings singleton lookup used the wrong key shape (`'global'` vs numeric singleton).
- Red/human-only actions could be represented in the same approval flow as executable Yellow actions.
- Meta pagination could treat a malformed continuation as a complete dataset.
- Bad owner timezone values could break budget/daily-summary queries.
- Missing Gateway stored provider credentials could fall through to Cloudflare Unified Billing unless BYOK-only was enforced.
- Production Gateway auth needed to be mandatory independent of credential mode.

These are all included in the current checkpoint.

## 7. Verification completed on this checkpoint

Source/dependency-independent checks completed during development:

- clean Git working tree at handoff
- `git diff --check`
- route/feature-contract guard
- AI provider/Pushover boundary guard
- local AI import guard
- AI readiness guard
- workflow YAML parse
- TypeScript syntax/transpile sweep across AI/control-plane source
- secret/conflict/TODO/FIXME scan on hardening diff
- best-effort AI migration write-column cross-check

## 8. What is NOT yet honestly verified

A prior local npm installation became incomplete because registry access failed. Therefore **do not claim** these have passed for the final merged branch until a clean Codespaces/CI environment runs them:

```bash
npm ci
npm run qa:contracts
npm run qa:change-coverage
npm run qa:ai-boundaries
npm run type-check
npm run test:ci
npm run build
```

Then run the exact OpenNext/Cloudflare build used by production deployment plus post-deploy smoke/browser tests.

## 9. Exact next work to continue in the next chat

Resume from `91f8655` and proceed in this order:

1. **Run the final adversarial source audit** that was in progress when this handoff was requested:
   - swallowed errors that could report false success;
   - unsafe concurrent `Promise.all` state transitions;
   - owner/Admin mutations that do not verify current row/state;
   - retry/idempotency paths that could duplicate external side effects.
2. Re-run all dependency-free AI/QA/readiness guards after any findings.
3. In a clean Codespaces/CI dependency environment, run the full `npm ci` → QA → type-check → Jest → Next build → OpenNext/Cloudflare build pipeline.
4. Fix **every** compile/test/build issue before enabling any production flag.
5. The owner confirmed Claude's Task 6 changes preceded the ChatGPT integration. Treat Task 6 as included in `91f8655`. Only if a concrete, demonstrably omitted Claude commit/ZIP is later discovered should it be diffed, selectively merged, and fully re-tested; do not reapply the older Task 6 ZIP by default.
6. Verify the repository-root `.github/workflows/deploy.yml` is the active GitHub Actions workflow in the real repo.
7. Provision/verify Cloudflare AI Gateway:
   - authenticated Gateway token;
   - stored provider keys or deliberate BYOK configuration;
   - **Require provider credentials / BYOK only**;
   - external hard cap at `$5` or lower;
   - `AI_EXTERNAL_BUDGET_CAP_USD=5` (or lower);
   - `AI_EXTERNAL_BUDGET_CAP_CONFIRMED=true` only after the real external cap is verified.
8. Connect model providers and external evidence APIs only after secrets are configured outside source control.
9. Manually run Haiku 5.5 vs GPT-6 Luna evals on KVRN cases and keep the cheapest model meeting required accuracy.
10. Deploy with all autonomy flags OFF; verify `/admin/ai`, QA reporting, Chief dry-run, budget tests, connector evidence and Pushover routing.
11. Enable `AI_ENABLED=true` in **Shadow Mode** only.
12. Progress agents one at a time from Shadow → Approval → Limited autonomy after measured reliability.
13. Keep autonomous support replies, lifecycle sends, review sends, creator DMs, ad-budget changes, storefront CRO changes, PO placement, money movement, legal changes, credential changes and destructive DB operations disabled until each exact executor/policy/consent path is separately reviewed and tested.
14. Perform final production QA and only then use the planned final real Stripe order as the comprehensive launch transaction test.

## 10. Critical rollout defaults that must stay OFF until explicitly activated

Do not casually change these while merging/testing:

- global AI inference enablement
- Chief legacy-notification routing gate
- external sync/research flags
- autonomous customer-facing support replies
- lifecycle/review outbound sends
- creator outreach sends
- automatic CRO/storefront mutation
- automatic ad-budget mutation
- inventory purchase/PO execution
- money movement/legal/security/destructive DB actions

The readiness guard is intended to enforce the important safe defaults.

## 11. Files directly touched by the AI-OS / hardening commits

This section is the union of files changed by the direct AI/hardening commits `dfb08c5`, `5313618`, `4f8bbcb`, and `91f8655`. It intentionally excludes the pure Claude Task 6 commit where possible.

- `.env.example` — M; commits dfb08c5, 5313618, 91f8655
- `.github/workflows/deploy.yml` — M; commits dfb08c5
- `app/admin/ai/AiOperationsClient.tsx` — A,M; commits dfb08c5, 5313618
- `app/admin/ai/page.tsx` — A; commits dfb08c5
- `app/affiliates/apply/ApplyClient.tsx` — M; commits 91f8655
- `app/affiliates/apply/page.tsx` — M; commits 91f8655
- `app/api/admin/ai/actions/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/agents/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/alerts/[id]/resolve/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/alerts/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/approvals/[id]/decision/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/approvals/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/budget/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/daily-brief/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/evals/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/market-targets/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/overview/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/performance/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/qa/route.ts` — A; commits dfb08c5
- `app/api/admin/ai/settings/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/supply-profiles/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/ai/video-analysis/route.ts` — A,M; commits dfb08c5, 5313618
- `app/api/admin/media/route.ts` — M; commits 91f8655
- `app/api/affiliate/auth/request/route.ts` — M; commits 91f8655
- `app/api/affiliate/auth/verify/route.ts` — M; commits 91f8655
- `app/api/affiliates/invite/route.ts` — M; commits 91f8655
- `app/api/bundles/quote/route.ts` — M; commits 91f8655
- `app/api/checkout/recover/route.ts` — M; commits 91f8655
- `app/api/internal/ai-chief/route.ts` — A,M; commits dfb08c5, 5313618, 91f8655
- `app/api/internal/marketing-sync/route.ts` — M; commits 91f8655
- `app/api/internal/qa-report/route.ts` — A,M; commits dfb08c5, 5313618, 91f8655
- `app/api/internal/stripe-fee-reconcile/route.ts` — M; commits 91f8655
- `app/api/internal/support-email-ingest/route.ts` — M; commits dfb08c5, 91f8655
- `app/api/internal/transactional-email-retry/route.ts` — M; commits 91f8655
- `cloudflare-cron-wrapper.js` — M; commits dfb08c5
- `components/admin/AdminShell.tsx` — M; commits dfb08c5
- `db/migrations/036_ai_os_foundation.sql` — R096; commits 4f8bbcb
- `db/migrations/037_security_hardening.sql` — A; commits 91f8655
- `db/migrations/900_ai_os_foundation.sql` — A,M; commits dfb08c5, 5313618
- `docs/AI-OS-BUILD-STATUS.md` — A,M; commits dfb08c5, 4f8bbcb, 91f8655
- `docs/AI-OS-RUNBOOK.md` — A,M; commits dfb08c5, 5313618, 4f8bbcb, 91f8655
- `docs/KVRN-production-setup-migration-rollout-rollback-plan.md` — M; commits 91f8655
- `lib/__tests__/affiliate-portal-auth.test.ts` — M; commits 91f8655
- `lib/__tests__/affiliate-program-http.test.ts` — M; commits 91f8655
- `lib/__tests__/affiliate-program-pure.test.ts` — M; commits 91f8655
- `lib/__tests__/ai-os.test.ts` — A,M; commits dfb08c5, 5313618, 4f8bbcb
- `lib/__tests__/public-api-rate-limit.test.ts` — A; commits 91f8655
- `lib/__tests__/security-hardening-stage2.test.ts` — A; commits 91f8655
- `lib/affiliate-application.ts` — M; commits 91f8655
- `lib/affiliate-auth-guard.ts` — M; commits 91f8655
- `lib/affiliate-auth.ts` — M; commits 91f8655
- `lib/affiliate-program-email.ts` — M; commits 91f8655
- `lib/affiliate-program.ts` — M; commits 91f8655
- `lib/ai/agents/ads-social.ts` — A,M; commits dfb08c5, 5313618, 4f8bbcb
- `lib/ai/agents/creator-affiliate.ts` — A,M; commits dfb08c5, 4f8bbcb
- `lib/ai/agents/engineering-qa.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/finance.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/growth.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/lifecycle.ts` — A,M; commits dfb08c5, 4f8bbcb
- `lib/ai/agents/market-intel.ts` — A; commits dfb08c5
- `lib/ai/agents/market-research.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/product-inventory.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/review-growth.ts` — A; commits dfb08c5
- `lib/ai/agents/seo-commerce-data.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/support.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/agents/video-performance.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/budget.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/capabilities.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/chief.ts` — A,M; commits dfb08c5, 5313618, 4f8bbcb
- `lib/ai/config.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/evals.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/events.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/executors.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/governance.ts` — A; commits dfb08c5
- `lib/ai/integrations/google.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/http.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/meta.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/repository.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/sync.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/tiktok.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/integrations/web-research.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/policy.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/providers.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/repository.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/router.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/sanitize.ts` — A,M; commits dfb08c5, 5313618
- `lib/ai/types.ts` — A,M; commits dfb08c5, 5313618
- `lib/content-public.ts` — M; commits 91f8655
- `lib/internal-cron-auth.ts` — M; commits 91f8655
- `lib/owner-notifications.ts` — M; commits dfb08c5
- `lib/public-api-rate-limit.ts` — A; commits 91f8655
- `package.json` — M; commits dfb08c5
- `qa/feature-contracts.json` — A,M; commits dfb08c5, 4f8bbcb, 91f8655
- `qa/route-contracts.json` — A,M; commits dfb08c5, 4f8bbcb
- `scripts/browser-smoke.mjs` — A; commits dfb08c5
- `scripts/build-qa-report.mjs` — A,M; commits dfb08c5, 4f8bbcb
- `scripts/smoke-test.mjs` — A; commits dfb08c5
- `scripts/verify-ai-boundaries.mjs` — A; commits dfb08c5
- `scripts/verify-ai-local-imports.mjs` — A; commits dfb08c5
- `scripts/verify-ai-os-readiness.mjs` — A,M; commits dfb08c5, 5313618, 4f8bbcb, 91f8655
- `scripts/verify-change-test-coverage.mjs` — A; commits dfb08c5
- `scripts/verify-route-contracts.mjs` — A,M; commits dfb08c5, 4f8bbcb
- `wrangler.toml` — M; commits dfb08c5, 5313618

## 12. Full merged changed-file inventory vs baseline

The branch as a whole differs from local baseline `3f82c71` in **517 files** because it contains both the AI OS and the merged Claude Task 6 implementation.

```text
M	.env.example
M	.github/workflows/deploy.yml
M	app/about/page.tsx
M	app/admin/AdminDashboardClient.tsx
A	app/admin/abandoned-checkouts/AbandonedCheckoutsClient.tsx
A	app/admin/abandoned-checkouts/page.tsx
A	app/admin/ai/AiOperationsClient.tsx
A	app/admin/ai/page.tsx
M	app/admin/analytics/AnalyticsClient.tsx
M	app/admin/backups/BackupsClient.tsx
A	app/admin/content/page.tsx
M	app/admin/discounts/AdminDiscountsClient.tsx
M	app/admin/financials/FinancialsClient.tsx
M	app/admin/financials/advertising/AdvertisingClient.tsx
A	app/admin/financials/affiliates/AffiliateApplicationsTab.tsx
A	app/admin/financials/affiliates/AffiliateAuditTab.tsx
A	app/admin/financials/affiliates/AffiliateComplianceTab.tsx
A	app/admin/financials/affiliates/AffiliatePayoutReadinessTab.tsx
A	app/admin/financials/affiliates/AffiliateProfilesTab.tsx
A	app/admin/financials/affiliates/AffiliateTermsTab.tsx
M	app/admin/financials/affiliates/AffiliatesClient.tsx
A	app/admin/financials/affiliates/api.ts
M	app/admin/financials/costs/CostsClient.tsx
M	app/admin/financials/disputes/DisputesClient.tsx
M	app/admin/financials/expenses/ExpensesClient.tsx
M	app/admin/financials/infrastructure/InfrastructureClient.tsx
M	app/admin/financials/integrity/IntegrityClient.tsx
M	app/admin/financials/inventory/InventoryClient.tsx
M	app/admin/financials/returns/ReturnsClient.tsx
M	app/admin/financials/shipping/ShippingClient.tsx
M	app/admin/inventory/AdminInventoryClient.tsx
A	app/admin/media/MediaLibraryClient.tsx
A	app/admin/media/page.tsx
M	app/admin/orders/AdminOrdersClient.tsx
A	app/admin/orders/FraudReviewPanel.tsx
A	app/admin/orders/OrderTagsPanel.tsx
A	app/admin/orders/orders-ui.ts
A	app/admin/products/ProductListClient.tsx
A	app/admin/products/[id]/BundleSection.tsx
A	app/admin/products/[id]/PreviewPane.tsx
A	app/admin/products/[id]/ProductEditorClient.tsx
A	app/admin/products/[id]/editor-shared.tsx
A	app/admin/products/[id]/page.tsx
A	app/admin/products/[id]/preview/PreviewClient.tsx
A	app/admin/products/[id]/preview/page.tsx
A	app/admin/products/[id]/sections/BasicsSection.tsx
A	app/admin/products/[id]/sections/ContentSection.tsx
A	app/admin/products/[id]/sections/HistorySection.tsx
A	app/admin/products/[id]/sections/MediaSection.tsx
A	app/admin/products/[id]/sections/PairingSection.tsx
A	app/admin/products/[id]/sections/PricingSection.tsx
A	app/admin/products/[id]/sections/PublishingSection.tsx
A	app/admin/products/[id]/sections/SeoSection.tsx
A	app/admin/products/[id]/sections/VariantsSection.tsx
A	app/admin/products/defaults/DefaultsClient.tsx
A	app/admin/products/defaults/page.tsx
A	app/admin/products/new/NewProductClient.tsx
A	app/admin/products/new/page.tsx
A	app/admin/products/page.tsx
M	app/admin/sms/AdminSmsClient.tsx
M	app/admin/support/SupportInboxClient.tsx
A	app/admin/system/SystemClient.tsx
A	app/admin/system/page.tsx
A	app/affiliate/layout.tsx
A	app/affiliate/login/LoginClient.tsx
A	app/affiliate/login/page.tsx
A	app/affiliate/login/verify/VerifyClient.tsx
A	app/affiliate/login/verify/page.tsx
A	app/affiliate/portal/DocumentView.tsx
A	app/affiliate/portal/PortalClient.tsx
A	app/affiliate/portal/page.tsx
A	app/affiliates/_components/DocumentBody.tsx
A	app/affiliates/apply/ApplyClient.tsx
A	app/affiliates/apply/page.tsx
A	app/affiliates/documents/[docType]/page.tsx
A	app/api/admin/abandoned-checkouts/route.ts
A	app/api/admin/affiliates/applications/[id]/route.ts
A	app/api/admin/affiliates/applications/route.ts
A	app/api/admin/affiliates/audit/route.ts
A	app/api/admin/affiliates/compliance/route.ts
A	app/api/admin/affiliates/documents/route.ts
A	app/api/admin/affiliates/emails/route.ts
A	app/api/admin/affiliates/invites/route.ts
A	app/api/admin/affiliates/payout-readiness/route.ts
A	app/api/admin/affiliates/payout-readiness/statement/route.ts
M	app/api/admin/affiliates/payouts/route.ts
A	app/api/admin/affiliates/profiles/[id]/route.ts
A	app/api/admin/affiliates/profiles/route.ts
M	app/api/admin/affiliates/route.ts
A	app/api/admin/affiliates/settings/route.ts
A	app/api/admin/affiliates/ugc/route.ts
A	app/api/admin/ai/actions/route.ts
A	app/api/admin/ai/agents/route.ts
A	app/api/admin/ai/alerts/[id]/resolve/route.ts
A	app/api/admin/ai/alerts/route.ts
A	app/api/admin/ai/approvals/[id]/decision/route.ts
A	app/api/admin/ai/approvals/route.ts
A	app/api/admin/ai/budget/route.ts
A	app/api/admin/ai/daily-brief/route.ts
A	app/api/admin/ai/evals/route.ts
A	app/api/admin/ai/market-targets/route.ts
A	app/api/admin/ai/overview/route.ts
A	app/api/admin/ai/performance/route.ts
A	app/api/admin/ai/qa/route.ts
A	app/api/admin/ai/settings/route.ts
A	app/api/admin/ai/supply-profiles/route.ts
A	app/api/admin/ai/video-analysis/route.ts
A	app/api/admin/cache-invalidations/route.ts
A	app/api/admin/content/[kind]/[id]/route.ts
A	app/api/admin/content/[kind]/[id]/translations/route.ts
A	app/api/admin/content/[kind]/[id]/usage/route.ts
A	app/api/admin/content/[kind]/[id]/versions/route.ts
A	app/api/admin/content/[kind]/route.ts
A	app/api/admin/content/collections/[id]/products/route.ts
A	app/api/admin/content/collections/[id]/route.ts
A	app/api/admin/content/collections/[id]/translations/route.ts
A	app/api/admin/content/collections/product-search/route.ts
A	app/api/admin/content/collections/route.ts
A	app/api/admin/content/i18n/route.ts
A	app/api/admin/content/preview-context/route.ts
A	app/api/admin/content/products/[productId]/size-guide/route.ts
A	app/api/admin/content/seo/route.ts
A	app/api/admin/feature-flags/route.ts
A	app/api/admin/media/[id]/route.ts
A	app/api/admin/media/route.ts
A	app/api/admin/orders/[id]/fraud/confirm/route.ts
A	app/api/admin/orders/[id]/fraud/refresh/route.ts
A	app/api/admin/orders/[id]/fraud/release/route.ts
A	app/api/admin/orders/[id]/fraud/route.ts
A	app/api/admin/orders/[id]/tags/route.ts
A	app/api/admin/orders/tags/[tagId]/route.ts
A	app/api/admin/orders/tags/route.ts
A	app/api/admin/products/[id]/action/route.ts
A	app/api/admin/products/[id]/collections/route.ts
A	app/api/admin/products/[id]/history/route.ts
A	app/api/admin/products/[id]/preview-data/route.ts
A	app/api/admin/products/[id]/route.ts
A	app/api/admin/products/bulk/route.ts
A	app/api/admin/products/bundle-candidates/route.ts
A	app/api/admin/products/defaults/route.ts
A	app/api/admin/products/options/route.ts
A	app/api/admin/products/route.ts
M	app/api/admin/shipments/[id]/cost/route.ts
A	app/api/affiliate/auth/logout/route.ts
A	app/api/affiliate/auth/request/route.ts
A	app/api/affiliate/auth/verify/route.ts
A	app/api/affiliate/commissions/route.ts
A	app/api/affiliate/documents/[docType]/route.ts
A	app/api/affiliate/me/route.ts
A	app/api/affiliate/onboarding/accept/route.ts
A	app/api/affiliate/onboarding/route.ts
A	app/api/affiliate/overview/route.ts
A	app/api/affiliate/payout-setup/route.ts
A	app/api/affiliate/payouts/[ref]/statement/route.ts
A	app/api/affiliate/payouts/route.ts
A	app/api/affiliate/profile/route.ts
A	app/api/affiliates/apply/route.ts
A	app/api/affiliates/invite/route.ts
A	app/api/bundles/quote/route.ts
A	app/api/checkout/recover/route.ts
A	app/api/checkout/recover/unsubscribe/route.ts
M	app/api/checkout/session/route.ts
A	app/api/internal/abandoned-checkout-sweep/route.ts
A	app/api/internal/affiliate-maintenance/route.ts
A	app/api/internal/affiliate-program-maintenance/route.ts
A	app/api/internal/ai-chief/route.ts
A	app/api/internal/cms-scheduler/route.ts
M	app/api/internal/marketing-sync/route.ts
A	app/api/internal/qa-report/route.ts
M	app/api/internal/stripe-fee-reconcile/route.ts
M	app/api/internal/support-email-ingest/route.ts
M	app/api/internal/transactional-email-retry/route.ts
M	app/api/inventory/route.ts
M	app/api/orders/[id]/route.ts
M	app/api/orders/route.ts
M	app/api/stripe/webhook/route.ts
M	app/checkout/page.tsx
A	app/checkout/recover/RecoverClient.tsx
A	app/checkout/recover/page.tsx
M	app/checkout/success/page.tsx
A	app/collections/[slug]/page.tsx
M	app/collections/project-kvrn/page.tsx
A	app/contact/ContactClient.tsx
M	app/contact/page.tsx
M	app/cookies/CookieControls.tsx
M	app/cookies/page.tsx
A	app/i18n-rtl.css
M	app/layout.tsx
A	app/legal/[slug]/page.tsx
M	app/legal/privacy/page.tsx
M	app/legal/terms/page.tsx
A	app/media/[...key]/route.ts
M	app/not-found.tsx
A	app/pages/[slug]/page.tsx
M	app/privacy/page.tsx
M	app/products/[slug]/PDPClient.tsx
M	app/products/[slug]/page.tsx
M	app/shop/page.tsx
M	app/sitemap.ts
M	app/support/faq/page.tsx
M	app/support/shipping-returns/page.tsx
A	app/support/size-guide/LegacySizeGuide.tsx
M	app/support/size-guide/page.tsx
M	app/support/track/page.tsx
M	app/terms/page.tsx
M	cloudflare-cron-wrapper.js
M	components/admin/AdminShell.tsx
M	components/admin/FinancialUI.tsx
A	components/admin/content/CollectionsPanel.tsx
A	components/admin/content/ContentHub.tsx
A	components/admin/content/EntityEditor.tsx
A	components/admin/content/LanguagesPanel.tsx
A	components/admin/content/ListPanel.tsx
A	components/admin/content/RichTextEditor.tsx
A	components/admin/content/SeoPanel.tsx
A	components/admin/content/TranslationsPanel.tsx
A	components/admin/content/VersionsPanel.tsx
A	components/admin/content/api.ts
A	components/admin/content/forms.tsx
A	components/admin/content/ui.tsx
A	components/admin/media/MediaPicker.tsx
A	components/admin/media/image-resize.ts
A	components/admin/ui/AdminUI.tsx
A	components/admin/ui/InfoTip.tsx
M	components/analytics/FunnelTracker.tsx
M	components/analytics/GaTracker.tsx
A	components/cart/BagBundleGroup.tsx
M	components/cart/CartDrawer.tsx
A	components/content/CollectionGrid.tsx
A	components/content/LocaleSwitch.tsx
A	components/content/SizeGuideClient.tsx
A	components/content/cms-views.tsx
A	components/content/render-richtext.ts
M	components/forms/WaitlistForm.tsx
M	components/homepage/HomepageClient.tsx
M	components/homepage/WaitlistBlock.tsx
A	components/i18n/PreferenceRefresher.tsx
M	components/layout/ConditionalFooter.tsx
M	components/layout/Footer.tsx
M	components/layout/Nav.tsx
M	components/layout/PageHero.tsx
M	components/product/ColorSelector.tsx
A	components/product/CompleteTheSetBundle.tsx
M	components/product/ProductCard.tsx
M	components/product/QuickAddModal.tsx
M	components/product/SizeSelector.tsx
M	components/shop/CollectionHero.tsx
M	components/shop/ShopClient.tsx
A	components/shop/ShopGrid.tsx
M	components/ui/AnnouncementBar.tsx
M	components/ui/CookieConsent.tsx
M	components/ui/CurrencySelector.tsx
M	components/ui/LanguageSelector.tsx
M	components/ui/StockBadge.tsx
M	components/ui/WishlistDrawer.tsx
M	context/CartContext.tsx
M	context/CurrencyContext.tsx
M	context/I18nContext.tsx
A	context/StorefrontSeed.tsx
A	db/migrations/027_cms_foundation.sql
A	db/migrations/028_product_catalog_cms.sql
A	db/migrations/029_bundles.sql
A	db/migrations/030_site_content_cms.sql
A	db/migrations/031_order_tags_fraud_review.sql
A	db/migrations/032_abandoned_checkouts.sql
A	db/migrations/033_affiliate_program_core.sql
A	db/migrations/034_affiliate_portal_compliance_payouts.sql
A	db/migrations/035_localization_currency.sql
A	db/migrations/036_ai_os_foundation.sql
A	db/migrations/037_security_hardening.sql
A	docs/ADMIN-COPY-AUDIT.md
A	docs/AI-OS-BUILD-STATUS.md
A	docs/AI-OS-RUNBOOK.md
A	docs/KVRN-affiliate-system-setup-and-legal-review-checklist.md
A	docs/KVRN-feature-flags-and-cache-invalidation-plan.md
A	docs/KVRN-localization-currency-support-matrix.md
A	docs/KVRN-production-setup-migration-rollout-rollback-plan.md
A	lib/__tests__/abandoned-checkout-db.test.ts
A	lib/__tests__/abandoned-checkout-handler.test.ts
A	lib/__tests__/abandoned-checkout-routes.test.ts
A	lib/__tests__/abandoned-checkout.test.ts
A	lib/__tests__/admin-routes-guard.test.ts
A	lib/__tests__/admin-ui-primitives.test.ts
A	lib/__tests__/admin-ui-refresh.test.ts
A	lib/__tests__/affiliate-portal-api.test.ts
A	lib/__tests__/affiliate-portal-auth.test.ts
A	lib/__tests__/affiliate-portal-compliance.test.ts
A	lib/__tests__/affiliate-portal-fixtures.ts
A	lib/__tests__/affiliate-portal-notifications.test.ts
A	lib/__tests__/affiliate-portal-payouts.test.ts
A	lib/__tests__/affiliate-portal-schema.test.ts
A	lib/__tests__/affiliate-portal-ui.test.ts
A	lib/__tests__/affiliate-program-db.test.ts
A	lib/__tests__/affiliate-program-http.test.ts
A	lib/__tests__/affiliate-program-pure.test.ts
A	lib/__tests__/ai-os.test.ts
A	lib/__tests__/audit-a-checkout.test.ts
A	lib/__tests__/audit-b-fraud-db.test.ts
A	lib/__tests__/audit-b-webhook-order.test.ts
A	lib/__tests__/audit-c-affiliate.test.ts
A	lib/__tests__/bundle-pure.test.ts
A	lib/__tests__/bundles-checkout-handler.test.ts
A	lib/__tests__/bundles-db.test.ts
A	lib/__tests__/bundles-render.test.ts
A	lib/__tests__/cms-foundation-db.test.ts
A	lib/__tests__/cms-foundation.test.ts
A	lib/__tests__/content-admin-ui.test.ts
A	lib/__tests__/content-cms-equivalence.test.ts
A	lib/__tests__/content-cms-migration.test.ts
A	lib/__tests__/content-cms-public.test.ts
A	lib/__tests__/content-cms-pure.test.ts
A	lib/__tests__/content-cms-routes.test.ts
A	lib/__tests__/content-cms-service.test.ts
A	lib/__tests__/content-off-path.test.ts
A	lib/__tests__/content-richtext.test.ts
A	lib/__tests__/fixtures/content-off/about.html
A	lib/__tests__/fixtures/content-off/announcement.html
A	lib/__tests__/fixtures/content-off/contact.html
A	lib/__tests__/fixtures/content-off/cookies.html
A	lib/__tests__/fixtures/content-off/faq.html
A	lib/__tests__/fixtures/content-off/footer.html
A	lib/__tests__/fixtures/content-off/legal-privacy.html
A	lib/__tests__/fixtures/content-off/legal-terms.html
A	lib/__tests__/fixtures/content-off/nav.html
A	lib/__tests__/fixtures/content-off/privacy.html
A	lib/__tests__/fixtures/content-off/project-kvrn.html
A	lib/__tests__/fixtures/content-off/shipping-returns.html
A	lib/__tests__/fixtures/content-off/size-guide.html
A	lib/__tests__/fixtures/content-off/terms.html
A	lib/__tests__/fixtures/pdp-golden-kvrn-heavyweight-hoodie.html
A	lib/__tests__/fixtures/pdp-golden-kvrn-heavyweight-sweatpants.html
A	lib/__tests__/fixtures/pdp-golden-kvrn-phantom-hoodie.html
A	lib/__tests__/fixtures/pdp-golden-kvrn-phantom-sweatpants.html
A	lib/__tests__/fixtures/shop-golden-all.html
A	lib/__tests__/fixtures/shop-golden-hoodies.html
A	lib/__tests__/fixtures/shop-golden-sweatpants.html
A	lib/__tests__/fraud-review-db.test.ts
A	lib/__tests__/fraud-review-webhook.test.ts
A	lib/__tests__/fraud-review.test.ts
A	lib/__tests__/helpers/tsx-loader.ts
A	lib/__tests__/i18n-admin-db.test.ts
A	lib/__tests__/i18n-checkout-handler.test.ts
A	lib/__tests__/i18n-currency-db.test.ts
A	lib/__tests__/i18n-dictionaries.test.ts
A	lib/__tests__/i18n-preferences-currency.test.ts
A	lib/__tests__/i18n-rtl-render.test.ts
A	lib/__tests__/i18n-storefront-guards.test.ts
A	lib/__tests__/i18n-translation-overlay.test.ts
A	lib/__tests__/order-tags.test.ts
A	lib/__tests__/orders-ui.test.ts
A	lib/__tests__/pdp-render-harness.ts
A	lib/__tests__/product-cms-db.test.ts
A	lib/__tests__/product-cms-guards.test.ts
A	lib/__tests__/product-cms-logic.test.ts
A	lib/__tests__/product-cms-render.test.ts
A	lib/__tests__/public-api-rate-limit.test.ts
A	lib/__tests__/security-hardening-stage2.test.ts
M	lib/__tests__/support-inbox.test.ts
A	lib/abandoned-checkout-config.ts
A	lib/abandoned-checkout-email.ts
A	lib/abandoned-checkout-resume.ts
A	lib/abandoned-checkout-runtime.ts
A	lib/abandoned-checkout-token.ts
A	lib/abandoned-checkout-ui.ts
A	lib/abandoned-checkout.ts
M	lib/admin-orders.ts
A	lib/admin-status.ts
A	lib/affiliate-admin-client.ts
A	lib/affiliate-application-input.ts
A	lib/affiliate-application.ts
A	lib/affiliate-auth-guard.ts
A	lib/affiliate-auth.ts
A	lib/affiliate-compliance-ugc.ts
A	lib/affiliate-compliance.ts
A	lib/affiliate-maintenance.ts
A	lib/affiliate-payout-gate.ts
A	lib/affiliate-payout-provider.ts
A	lib/affiliate-payout-readiness.ts
A	lib/affiliate-payout-statements.ts
A	lib/affiliate-portal-bridge.ts
A	lib/affiliate-portal-http.ts
A	lib/affiliate-portal-notifications.ts
A	lib/affiliate-portal-privacy.ts
A	lib/affiliate-portal-ui.ts
A	lib/affiliate-portal-validation.ts
A	lib/affiliate-portal.ts
A	lib/affiliate-program-admin.ts
A	lib/affiliate-program-docs.ts
A	lib/affiliate-program-email.ts
A	lib/affiliate-program-http.ts
A	lib/affiliate-program-maintenance.ts
A	lib/affiliate-program-ui.ts
A	lib/affiliate-program.ts
A	lib/ai/agents/ads-social.ts
A	lib/ai/agents/creator-affiliate.ts
A	lib/ai/agents/engineering-qa.ts
A	lib/ai/agents/finance.ts
A	lib/ai/agents/growth.ts
A	lib/ai/agents/lifecycle.ts
A	lib/ai/agents/market-intel.ts
A	lib/ai/agents/market-research.ts
A	lib/ai/agents/product-inventory.ts
A	lib/ai/agents/review-growth.ts
A	lib/ai/agents/seo-commerce-data.ts
A	lib/ai/agents/support.ts
A	lib/ai/agents/video-performance.ts
A	lib/ai/budget.ts
A	lib/ai/capabilities.ts
A	lib/ai/chief.ts
A	lib/ai/config.ts
A	lib/ai/evals.ts
A	lib/ai/events.ts
A	lib/ai/executors.ts
A	lib/ai/governance.ts
A	lib/ai/integrations/google.ts
A	lib/ai/integrations/http.ts
A	lib/ai/integrations/meta.ts
A	lib/ai/integrations/repository.ts
A	lib/ai/integrations/sync.ts
A	lib/ai/integrations/tiktok.ts
A	lib/ai/integrations/web-research.ts
A	lib/ai/policy.ts
A	lib/ai/providers.ts
A	lib/ai/repository.ts
A	lib/ai/router.ts
A	lib/ai/sanitize.ts
A	lib/ai/types.ts
A	lib/bundle-admin.ts
A	lib/bundle-cart.ts
A	lib/bundle-checkout.ts
A	lib/bundle-ids.ts
A	lib/bundle-model.ts
A	lib/bundle-preview.ts
A	lib/bundle-pricing.ts
A	lib/bundle-public.ts
A	lib/bundle-types.ts
A	lib/cache-invalidation.ts
M	lib/cart-reducer.ts
M	lib/catalog.ts
M	lib/checkout-session-handler.ts
A	lib/cms-core.ts
A	lib/content-collections.ts
A	lib/content-defaults.ts
A	lib/content-http.ts
A	lib/content-locales.ts
A	lib/content-localize.ts
A	lib/content-public.ts
A	lib/content-richtext.ts
A	lib/content-schemas.ts
A	lib/content-seed-data.ts
A	lib/content-seed.ts
A	lib/content-seo-service.ts
A	lib/content-seo.ts
A	lib/content-service.ts
A	lib/content-shell.ts
A	lib/content-size-guide.ts
A	lib/content-storefront.ts
A	lib/content-urls.ts
M	lib/currency.ts
A	lib/feature-flags.ts
A	lib/fraud-review.ts
A	lib/i18n-admin-http.ts
A	lib/i18n-admin-service.ts
A	lib/i18n/checkout.ts
A	lib/i18n/config.ts
A	lib/i18n/currency-policy.ts
A	lib/i18n/fx.ts
A	lib/i18n/locales.ts
A	lib/i18n/messages/ar.ts
A	lib/i18n/messages/de.ts
A	lib/i18n/messages/en.ts
A	lib/i18n/messages/es.ts
A	lib/i18n/messages/fr.ts
A	lib/i18n/messages/hi.ts
A	lib/i18n/messages/index.ts
A	lib/i18n/messages/ja.ts
A	lib/i18n/messages/ko.ts
A	lib/i18n/messages/pt.ts
A	lib/i18n/messages/zh.ts
A	lib/i18n/preferences.ts
A	lib/i18n/server.ts
A	lib/internal-cron-auth.ts
A	lib/media-storage.ts
A	lib/media-usage.ts
A	lib/order-tags.ts
M	lib/owner-notifications.ts
A	lib/product-api.ts
A	lib/product-defaults.ts
A	lib/product-images.ts
A	lib/product-localize.ts
A	lib/product-model.ts
A	lib/product-price.ts
A	lib/product-public-shape.ts
A	lib/product-public.ts
A	lib/product-seo.ts
A	lib/product-service.ts
A	lib/product-variants.ts
A	lib/public-api-rate-limit.ts
M	lib/resend-adapter.ts
M	lib/reservations.ts
M	lib/shippo.ts
A	lib/site-settings.ts
A	lib/translations.ts
M	package-lock.json
M	package.json
A	qa/feature-contracts.json
A	qa/route-contracts.json
A	scripts/browser-smoke.mjs
A	scripts/build-qa-report.mjs
A	scripts/smoke-test.mjs
A	scripts/verify-ai-boundaries.mjs
A	scripts/verify-ai-local-imports.mjs
A	scripts/verify-ai-os-readiness.mjs
A	scripts/verify-change-test-coverage.mjs
A	scripts/verify-route-contracts.mjs
M	types/index.ts
M	wrangler.toml
```

## 13. Recovery / resume instructions

Preferred resume source: exact Git commit **`91f8655`** on branch **`ai-os-build-5cce4f1`**.

If Git history is unavailable, use the accompanying source archive generated from `91f8655`.

Do not resume from an older AI-OS ZIP if this exact checkpoint is available.

---

## 14. October 7 follow-on: adversarial audit pass 1 (after `91f8655`)

**This section supersedes the earlier claim that the adversarial audit was entirely pending.** Its first targeted source pass is now complete, while the full independent adversarial audit and integration testing remain open. The new source patch exists as a **working-copy overlay on top of `91f8655`, not a committed descendant**. Do not assign the patch a fabricated Git SHA or claim deployment.

Scope: reviewed false-success/error swallowing, unsafe write timing, stale admin mutations, connector-state readiness, and approval/governance ordering. Five areas received targeted fixes: fail-closed affiliate policy/document reads; Chief governor-before-approved-actions and visible failures; atomic agent downgrade+audit+alert; atomic media mutation+audit with R2 cleanup warning; and connector state updates that reject missing rows.

New regression evidence: 15 dependency-free source-level assertions (also incorporated into the Jest test suite), passing QA contracts, AI boundaries, AI import and readiness guards, plus source syntax transpilation. Actual `npm ci`, full Jest/typecheck/build, PostgreSQL failure injection, browser and Cloudflare testing **have not passed or have not been run**: the dependency registry was unavailable in this container, and no live DB/services were used.

**Patch documentation:** `docs/KVRN-AUDIT-CONTINUATION-2026-10-07.md` in the updated source archive. **New QA command:** `npm run qa:adversarial`.

**Next step:** apply the overlay or continue from the new merged-source archive, obtain a clean npm install in Codespaces, run all six QA/typecheck/Jest/Next/OpenNext commands, and test SQL changes with a restored realistic Neon database. Continue auditing the remaining swallowed error paths and concurrency conditions before enabling any feature flags. The original `91f8655` archive remains the historical baseline.
