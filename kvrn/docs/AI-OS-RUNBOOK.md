# KVRN AI Operating System — Merge & Rollout Runbook

Baseline: KVRN commit `5cce4f1`. The AI OS is intentionally additive and disabled by default.

## Non-negotiable controls

- KVRN code/database remain the source of truth for orders, inventory, discounts, accounting, financial reconciliation, commissions, and customer consent.
- Paid inference goes through `lib/ai/router.ts`; business agents may not call model providers directly. Production always requires Cloudflare AI Gateway; there is no direct-provider bypass.
- The Chief Operator is the only AI layer allowed to send Pushover notifications.
- A deterministic Chief daily Pushover is attempted once every business day after the configured local hour, even when AI inference spend is $0.
- Monthly AI inference is targeted near $0–$1 when quiet. DB-enforced modes begin at $2/$3/$3.50 and reserve against a $4 operational cutoff. $5 is the owner absolute ceiling and is not an operating target.
- External email, review, DM, webpage, and video text is untrusted data, never instructions.
- High-risk actions fail closed. No AI can place inventory POs, move money, alter legal policy, expose credentials, or run arbitrary SQL.
- Customer-facing Support, Lifecycle, Review Growth, Creator outreach, and other outbound autonomy stays shadow/disabled until the post-Claude merge verifies canonical policies, templates, consent, and endpoints.

## Merged migration rule

The Task 6 migrations occupy `027`–`035`; the AI OS follows as `036_ai_os_foundation.sql`, and the post-merge security audit adds `037_security_hardening.sql`. Before any production migration:

1. Re-run the complete `001`–`037` chain in a disposable database.
2. Run `027`–`036` against a restore-tested staging copy of current production data.
3. Verify the Task 6 anomaly checks plus the AI-OS readiness guards.
4. Never edit or renumber migrations already applied to production.

## GitHub Actions repository-root fix

The `5cce4f1` archive stores the existing workflow at `kvrn/.github/workflows/deploy.yml`, but the Git repository root is the directory above `kvrn/`. GitHub requires workflow files under the repository-root `.github/workflows/` directory. The AI-OS delivery therefore includes a synchronized root workflow at `.github/workflows/deploy.yml`. During the final merge, keep the repository-root workflow authoritative; the nested copy may remain only as documentation/backward reference or be removed after confirming no tooling depends on it.

## Required verification after the Claude merge

Run from the KVRN app root after a clean `npm ci`:

```bash
npm run qa:contracts
npm run qa:change-coverage
npm run qa:ai-boundaries
npm run type-check
npm run test:ci
npm run build
```

Then run the OpenNext/Cloudflare build used by the deployment workflow. Do not enable AI if any guard, type check, regression suite, or build fails.

## Safe rollout sequence

1. **Merge only** — merge AI OS code with all AI flags OFF.
2. **Schema** — renumber/apply the AI migration in test, then production after verification.
3. **Dashboard** — deploy `/admin/ai`; verify Cloudflare Access protects all Admin AI routes.
4. **QA reporting** — configure `QA_REPORT_SECRET`; verify failed CI and post-deploy smoke/browser results appear in AI Operations → QA.
5. **Chief dry run** — verify daily brief generation and alert dedupe while `AI_CHIEF_NOTIFICATION_GATE=false`.
6. **Gateway** — configure Cloudflare AI Gateway and provider credentials outside source control. Prefer Gateway stored keys. Enable **Require provider credentials / BYOK only** on the gateway so missing stored keys fail closed instead of falling through to Unified Billing. KVRN also sends `cf-aig-no-wholesale: true` on provider-native requests as request-level defense in depth. Never paste secrets into chat or commit them.
7. **External hard cap** — configure and verify the provider/Gateway hard monthly cap at the owner-required maximum before setting `AI_EXTERNAL_BUDGET_CAP_USD=5` (or lower) and then `AI_EXTERNAL_BUDGET_CAP_CONFIRMED=true`. Production inference remains blocked while this flag is false.
8. **Budget test** — lower the test cutoff temporarily and prove reservations block concurrent calls at the threshold; restore production controls to $4 operational / $5 absolute.
9. **Model eval** — manually run the Haiku 5.5 vs GPT-6 Luna support-triage arena. Keep the cheapest model that meets KVRN's accuracy requirement.
10. **Shadow mode** — set `AI_ENABLED=true` with agents in Shadow/Approval states only. Verify action logs, cost logs, no unexpected outbound actions, and PII redaction.
11. **Chief gate** — only after notification routing is proven, set `AI_CHIEF_NOTIFICATION_GATE=true`; verify legacy alert sources no longer bypass Chief.
12. **External evidence** — connect Meta/TikTok/Search Console/Merchant one at a time with `AI_EXTERNAL_SYNC_ENABLED=true` only after each credential and permission set is verified.
13. **Market research** — enable `AI_WEB_RESEARCH_ENABLED=true` only after approved targets are present.
14. **Outbound autonomy** — enable Support/Lifecycle/Review/Creator actions only after final policies, consent logic, templates, and destination APIs from the Claude merge are audited.
15. **Promotion of agents** — Shadow → Approval → Limited → Trusted only after measured KVRN eval/outcome performance.
16. **Final launch QA** — keep the existing plan: the final real Stripe purchase remains the comprehensive live-order launch test after the full site/Admin/financial system is complete.

## Secrets / configuration

Never commit real values. The build expects configuration documented in `.env.example`, including:

- Cloudflare AI Gateway base URLs/tokens or Gateway stored provider keys
- Anthropic/OpenAI/Google provider credentials where required
- `QA_REPORT_SECRET`
- existing `CRON_SECRET`
- Meta/TikTok/Google external integration credentials only when those connectors are enabled

Use secure provider/Cloudflare secret storage for production.

## Failure behavior

- Model/provider unavailable → deterministic site functions continue; AI action fails/logs safely.
- AI monthly operational cutoff reached → paid inference blocks; storefront/orders/accounting continue.
- Pushover unavailable → alerts/daily brief remain in AI tables and retry; dashboard remains source of record.
- External integration unavailable → prior evidence remains read-only; no invented values.
- Unknown/unsupported approved action → executor rejects it and Chief surfaces the block.
- CI regression → deployment stops; QA failure is reported to the AI dashboard when reporting credentials are available.

## Daily owner experience

The intended owner loop is:

1. Receive at least one Chief Pushover daily.
2. Open AI Operations only when the brief or an exception needs attention.
3. Approve/reject the small number of Yellow actions.
4. Leave routine Green actions and monitoring to the system.
5. Red actions remain human-only regardless of AI confidence.
