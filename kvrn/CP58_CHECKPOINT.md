# KVRN Checkpoint 58 — isolated browser/runtime verification

**Base:** CP57 merged staging (owner-verified 12/12 local Worker routes). **No production actions authorized.**

## Changes from CP57

- `scripts/cp58-local-browser-qa.mjs`: one-shot localhost Worker + real Chromium customer-journey and responsive QA runner. Reuses the already-built `.open-next` output, uses an ephemeral Wrangler configuration with no account, routes, cron, R2, provider secrets or production bindings, and tears down processes/config even on failure. Uses an empty HOME for the Worker. Refuses the original website directory and environments with `.env` or `.dev.vars`.
- `scripts/browser-smoke.mjs`: blocks *all* cross-origin browser requests (not only `kvrn.shop`) and accepts both the PDP button/link implementations of the Size Guide. Cart and checkout-entry cannot count as verified when size selection is unavailable.
- `scripts/browser-responsive-audit.mjs`: blocks all cross-origin browser requests. Optional `KVRN_QA_CHROMIUM_EXECUTABLE` supports an already-installed Chromium without changing project dependencies.

## What is known versus pending

- Owner's previous evidence: CP55's 5,355 Jest checks and 64 migrations passed; CP56 12/12 concurrency and extended 14/14 passed; 037→065 populated migration passed; Cloudflare build and artifact audit passed; CP57 12/12 local Worker requests passed.
- CP58 runner self-test and baseline browser guard checks passed in isolated authoring environment; full Playwright + real Wrangler browser run **has not yet executed in owner's Codespaces**.
- The local browser QA never submits checkout payments or sends contact forms, SMS, email or provider requests. It cannot prove live provider integration, Cloudflare Access, Safari/WebKit, actual R2 bucket writes or a production release.

## Codespaces after patch installation

```bash
cd /workspaces/KVRN-/kvrn-merged-staging
node scripts/cp58-local-browser-qa.mjs --self-test
node scripts/cp58-local-browser-qa.mjs
```

If optional Playwright or Chromium isn't installed, the runner **fails before launching the Worker**. For a QA-only environment, the owner may choose to install `playwright` without updating package.json/lockfile and provision Chromium with Playwright; verify resulting dependency and browser cache before rerunning. Browser logs/report:
- `/tmp/kvrn-cp58-browser.log` and `/tmp/kvrn-cp58-browser.json`
- `/tmp/kvrn-cp58-responsive.log`
- `/tmp/kvrn-cp58-worker.log`

Do not count partial or `not_applicable` cart/checkout checks as end-to-end success.
