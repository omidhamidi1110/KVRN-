# KVRN CP58.1 — browser QA corrections based on actual Codespaces logs

Baseline: CP58. All verified CP55–CP57 and CP56.1 evidence preserved; 065 and all application source remain unchanged.

## Diagnosed failures

- PDP `networkidle` waits exceeded 20 seconds: browser QA now loads with `domcontentloaded` and checks the actual HTTP status plus visible UI. The underlying reason for non-idle network is **not** proven.
- Mobile shop HTML duplicates desktop/mobile link elements: select first **visible** product link.
- `/messaging-terms` and `/messaging-privacy` intentionally return 404 with `KVRN_SMS_POLICY_PUBLIC_ENABLED=false`. Local runner tells the responsive QA to expect these 404 responses, counting them as route-policy passes; unexpected status still fails. Standalone responsive QA still expects a public success unless explicitly configured.
- Local Worker has **no Neon binding** and the PDP fails closed without verified inventory. Rather than mocking stock or weakening checks, report the inventory HTTP response when Add-to-Bag cannot be tested and keep CP58 marked incomplete. A real isolated DB/inventory staging integration is separately required.
- Cloudflare workerd broken pipe in log: investigate if recurrent, but it did serve many routes successfully; do not treat it as definitively explained by browser cancellation.

## Execute

```bash
cd /workspaces/KVRN-/kvrn-merged-staging
node scripts/cp58-local-browser-qa.mjs --self-test
node scripts/cp58-local-browser-qa.mjs --public-only   # verify public UX and 11 viewport widths; cart/checkout explicitly SKIPPED
# Once a separate safe staging database/inventory is available, run full suite:
node scripts/cp58-local-browser-qa.mjs             # fail-closed if live stock unavailable
```

**No deployment, production access, real payments, R2 writes, or provider messaging.** Browser QA guards continue to block non-local origins. Tests are not allowed to declare a full pass if cart or checkout was skipped.
