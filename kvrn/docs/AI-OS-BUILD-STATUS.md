# KVRN AI OS — Parallel Build Status

Build date: 2026-10-07
Source baseline: repository commit `5cce4f1`
Merged migrations: `036_ai_os_foundation.sql`, `037_security_hardening.sql`

## Implemented in this parallel build

- 11-agent registry and server-side autonomy/model-role controls.
- Chief Operator as the only AI Pushover gatekeeper.
- Guaranteed deterministic daily Chief summary attempt after the configured local hour.
- Quiet hours, dedupe, retry/lease recovery, push ceiling, and emergency bypass rules.
- AI Operations Admin dashboard: Overview, Approvals, Agents, Activity, Alerts, Spend, Performance, QA, Evals, Social, Research, Supply, Connections, Settings.
- Append-only action/model/audit records and owner approvals.
- Atomic worst-case monthly budget reservation with $4 operational cutoff and $5 absolute owner ceiling.
- Central provider router; provider/model calls outside the boundary fail CI.
- Cloudflare AI Gateway support including preferred Gateway stored-provider-key mode.
- Haiku 5.5 bulk role, Gemini 3.8 Flash video role, Sonnet 5.5 business role, GPT-6.1 Sol finance role, GPT-6 Luna evaluation challenger.
- Manual Haiku-vs-Luna synthetic support-triage evaluation arena.
- Prompt/external-content sanitization and PII/secret minimization.
- Support inbound shadow triage and owner escalation.
- Lifecycle abandoned-checkout candidate monitor (no outbound send yet).
- Neutral post-delivery Review Growth eligibility queue (no sentiment gating; no outbound send yet).
- Growth/CRO anomaly monitor with sample thresholds and governed CRO experiment proposals.
- Ads/Social health monitor and controlled short-video analysis path.
- Creator/Affiliate pipeline health monitor.
- Public Market Intelligence target management, SSRF-safe fetch, change hashing, and evidence-only AI analysis.
- Product/Inventory velocity, supply lead-time/MOQ/safety-stock planning, and governed reorder recommendations; no automatic PO placement.
- Finance/Attribution/Risk monitoring using canonical KVRN financial calculations, reconciliation state, ad spend, and first-party attribution evidence.
- Search Console / Merchant / Meta / TikTok evidence connector adapters, disabled until credentials/permissions are connected.
- SEO/Commerce/Data health monitor.
- Engineering/QA feature registry, per-feature results, deployment reporting, route contract guard, AI-boundary guard, local-import guard, and changed-feature test-evidence guard.
- Production-safe browser smoke path for storefront → PDP → cart → checkout entry; it never submits a payment.
- Deterministic agent performance metrics and automatic **downgrade-only** autonomy governor; no agent can auto-promote itself.
- Existing KVRN Pushover sources can be migrated behind Chief with `AI_CHIEF_NOTIFICATION_GATE`; rollout defaults remain off.
- All AI/external research/external sync production flags default OFF.

## Intentionally gated until final Claude merge / provider connection

These are not omissions; activating them before the canonical CMS/policy/consent endpoints exist would create unsafe duplicate logic.

- Autonomous customer-support replies.
- Cart/browse/checkout recovery sends.
- Native review request delivery and review merchandising integration.
- Creator/affiliate outbound messaging/DM execution.
- Automatic CRO storefront changes or experiment deployment.
- Automatic ad-budget changes.
- Any inventory purchase/PO execution.
- Any money movement, legal-policy change, credential/security change, destructive DB operation, or arbitrary SQL.
- Live Meta/TikTok/Search Console/Merchant sync until credentials and permissions are connected.
- Paid model inference until Gateway/provider configuration is verified and `AI_ENABLED=true` is deliberately enabled.

## Local verification completed

Passed in the isolated build:

- `git diff --check`
- AI route/feature contract guard
- AI provider/Pushover boundary guard
- AI local-import guard
- AI readiness guard
- deploy workflow YAML parse
- TypeScript syntax transpile pass across the AI control plane
- changed/new file secret-pattern scan

## Verification that must run after clean dependency install

This environment could not complete a clean npm install because the package registry became unavailable during the build. Therefore **do not claim** the following have passed until they run in Codespaces/CI after the merge:

- `npm ci`
- `npm run type-check`
- `npm run test:ci`
- `npm run build`
- OpenNext Cloudflare build
- production smoke/browser suites against a deployed integration build

The source-level guards are intended to catch a large class of mistakes before that final compile/regression pass, but they do not replace it.

## Repository-root GitHub Actions note

The `5cce4f1` archive has its existing workflow under `kvrn/.github/workflows/`. GitHub requires workflows under the repository-root `.github/workflows/` directory. The delivery package includes a synchronized repository-root workflow overlay; that root workflow must be retained in the final merged repository.

## Final merge sequence

Use `docs/AI-OS-RUNBOOK.md`. Do not enable production AI until the merged `001`–`037` migration chain, full build/regression suite, and staging checks pass. Roll out AI in Shadow Mode first.
