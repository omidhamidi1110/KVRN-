# KVRN CP57 — Local-only Cloudflare Worker runtime verification

**Source ancestry:** CP55 merged staging → CP56 SQL 065 and test harnesses → CP56.1 safe PostgreSQL runner cleanup → CP57 additive edge smoke harness. **No production approval.**

## Owner-verified prior gates, Oct 8 2026

- CP55: 5,355 Jest tests green, 64/64 PostgreSQL migrations green, TypeScript, offline QA and Next.js build previously green.
- CP56: `npm run cf:build` successful; `.open-next/worker.js` 2,278 bytes; 383 static assets; no deployment.
- CP56.1: isolated transaction/integrity tests 12/12 passed; `CLEANUP PASS`, exit 0. Preserved CP55 migration database unchanged.
- Extended finance/marketing/identity replay verification: 14/14 integration gates passed, exit 0; forensic clone `kvrn_cp56_fin_9e7d2085` preserved.
- Historical data fixture: populated 037→065 migration passed with all 9/9 historical IDs intact and stock/economic/subscriber/affiliate values preserved; forensic clone `kvrn_cp56_upgrade_a73071e3` preserved.
- Existing Cloudflare artifact audit passed: wrapper, OpenNext Worker, WebP assets. No deployment.

## CP57 addition (no edits to prior files)

`scripts/cp57-local-edge-smoke.mjs` performs actual local Cloudflare/Miniflare Worker smoke when executed in the installed Codespaces staging directory. It creates a temporary safe Wrangler config with absolute Worker and asset paths, no Cloudflare account ID, no routes, no crons, no R2, no provider bindings/secrets, and no CLI auth credentials. Runs installed `node_modules/.bin/wrangler dev --local --ip 127.0.0.1` only. `process.env` for Wrangler is an explicit allowlist; all GET probes target `127.0.0.1`, use redirect=manual, and never submit forms, payments, emails or messages. Temporary config and child process are cleaned up. The original `wrangler.toml` is never modified. Logs: `/tmp/kvrn-cp57-local-edge.log`.

Live runtime probes include homepage, shop, coded PDP, FAQ, privacy, robots, GA config without runtime ID, two unauthenticated admin APIs, invalid media path, missing R2 binding, and the product WebP file. Any unexpected 4xx/5xx, admin auth bypass, missing file or dead Worker fails the run.

**Already verified in authoring environment:** `node --check`, 12/12 simulated localhost routes, negative mock that deliberately returns 200 from `/api/admin/products` (runner correctly rejects), and strict Codespaces path guard. **NOT yet verified:** actual Wrangler process and OpenNext runtime in Codespaces. The synthetics exercise only the test harness, not KVRN itself.

## Exact Codespaces steps

Upload `KVRN_CP57_PATCH.zip` to `/workspaces/KVRN-/` then:

```bash
cd /workspaces/KVRN-
unzip -oq KVRN_CP57_PATCH.zip -d cp57-patch
python3 cp57-patch/CP57_APPLY_PATCH.py
cd /workspaces/KVRN-/kvrn-merged-staging
node scripts/cp57-local-edge-smoke.mjs
```

The script prints one PASS/FAIL per route; expected `CP57 LOCAL EDGE RESULT: 12/12 checks passed` and cleanup. On failure, inspect `tail -n 70 /tmp/kvrn-cp57-local-edge.log`. **Do not run** `wrangler deploy`, `wrangler dev --remote`, `npm run deploy`, or touch production Neon/Stripe/Twilio/Resend/R2.

## Remaining release gates

Local Worker runtime smoke does not verify real Cloudflare Access edge configuration, R2 upload/transform roundtrips, staging Stripe callbacks/webhooks, private Admin CMS workflows using a database, or real mobile Safari. These must be tested later with appropriately isolated staging dependencies and separate owner approval for any external services. Nothing in this checkpoint authorizes a release.

**Recovery:** `KVRN_CP57_CUMULATIVE_FULL_SOURCE.zip` is a full independent code snapshot; it must NOT be extracted over the existing Codespaces staging directory. Only the additive CP57 patch should be applied to staging.
