# KVRN V51.4 — Automatic Transactional Email Retry Worker

## Purpose

V51.4 adds reliable automatic retry processing for the transactional email outbox. The webhook (order confirmation) and admin shipping PATCH (shipping confirmation) already attempt one immediate send. V51.4 adds a Cloudflare Cron Trigger that processes due and stale rows automatically every 5 minutes.

## New / Changed Files

| File | Change |
|------|--------|
| `app/api/internal/transactional-email-retry/route.ts` | New — POST-only internal route with CRON_SECRET auth |
| `lib/transactional-email.ts` | Updated — stale `sending` recovery (15-min timeout) |
| `cloudflare-cron-wrapper.js` | New — minimal Cloudflare Worker wrapper adding `scheduled` to OpenNext |
| `wrangler.toml` | Updated — `main` → wrapper, `[triggers]` crons added, CRON_SECRET documented |
| `lib/__tests__/reservations.test.ts` | Added V51.4 unit + DB integration tests |
| `README-V51.4.md` | This file |

## Required Secret

```bash
# Set once — never commit the value
npx wrangler secret put CRON_SECRET
```

`CRON_SECRET` is read at runtime from the Cloudflare Worker environment. Never add it to `wrangler.toml`, `.env`, or any committed file.

## Cron Cadence

Every 5 minutes (`*/5 * * * *`). Each invocation processes a bounded batch of 25 due rows.

## How It Works

```
Every 5 min → Cloudflare Cron fires scheduled() in cloudflare-cron-wrapper.js
  → HTTP POST /api/internal/transactional-email-retry (with CRON_SECRET)
  → Route verifies secret (timing-safe comparison)
  → processPendingTransactionalEmails({ limit: 25 })
    → SELECT due rows (status=pending/failed, next_attempt_at ≤ NOW)
    → SELECT stale sending rows (updated_at < 15 min ago)
    → FOR UPDATE SKIP LOCKED (concurrent cron runs safe)
    → Send via Resend
    → Update outbox row (sent or failed+retry)
  → Returns { processed, sent, failed } — no PII
```

## Retry Schedule

| Attempt | Delay |
|---------|-------|
| 1 | Immediate (webhook/admin) |
| 2 | +5 minutes |
| 3 | +30 minutes |
| 4 | +2 hours |
| 5 | +12 hours |

After 5 attempts, `next_attempt_at` is NULL and the row is not selected again.

## Stale Sending Recovery

If a Cloudflare Worker is terminated after marking a row `sending` but before setting `sent` or `failed`, the row could be stuck. V51.4 treats rows in `sending` state with `updated_at < NOW() - INTERVAL '15 minutes'` as due for retry. The deterministic idempotency key (`order-confirmation/<order_id>` or `shipping-confirmation/<order_id>`) is preserved, making retries safe at Resend.

Fresh `sending` rows (updated within 15 minutes) are never reclaimed — they are still being processed.

## Security

- `CRON_SECRET` required to call route — no secret → 503
- Wrong secret → 403 (timing-safe comparison)
- No PII in response (`{ processed, sent, failed }` only)
- No retry failure can alter order/payment/inventory/shipment state
- `Cache-Control: no-store` on all responses

## Why `cloudflare-cron-wrapper.js` Exists

The OpenNext-generated worker (`.open-next/worker.js`) exports only a `fetch` handler. Cloudflare Cron Triggers require a `scheduled` export. This minimal wrapper spreads the OpenNext worker's fetch handler and adds `scheduled`. `wrangler.toml` points `main` to this file instead of directly to the generated output.

The wrapper is plain JavaScript because it references `.open-next/worker.js` which only exists after `npm run build`. Wrangler bundles it at deploy time.

## wrangler.toml Changes

- `main` changed from `.open-next/worker.js` to `cloudflare-cron-wrapper.js`
- `[triggers]` section added with `crons = ["*/5 * * * *"]`
- `CRON_SECRET` documented in secrets comment block
- All other config preserved (`account_id`, `keep_vars = true`, all vars/environments)

## Deployment Steps

```bash
# 1. Set CRON_SECRET secret (once)
npx wrangler secret put CRON_SECRET

# 2. Build
npm ci && npm run type-check && npm test -- --runInBand
rm -rf .next .open-next
npm run build   # generates .open-next/worker.js (required by wrapper)

# 3. Deploy via GitHub → Cloudflare pipeline (existing workflow)
git add -A && git commit -m "chore: V51.4" && git push origin main

# 4. Enable Cron Trigger in Cloudflare dashboard
# Workers & Pages → kvrn → Triggers → Cron Triggers
# Verify "*/5 * * * *" appears — enable if not already active
```

## Preview vs Production

Preview (`kvrn-preview`) and production (`kvrn`) are separate workers. Set `CRON_SECRET` separately for each if you want preview retry processing:
```bash
npx wrangler secret put CRON_SECRET --env preview
```
Ensure preview uses a separate `TEST_DATABASE_URL` if cron is enabled there, to avoid hitting production data.

## Immediate Attempts Preserved

- Webhook (order created): still calls `processPendingTransactionalEmails({ limit: 1 })` immediately
- Admin PATCH (order shipped): still calls `processPendingTransactionalEmails({ limit: 1 })` immediately
- Cron is supplemental — processes retries and any rows missed by immediate attempts

## Test Commands

```bash
# Type-check
npm run type-check

# All tests (DB tests skipped without TEST_DATABASE_URL)
npm test -- --runInBand

# DB integration tests (migrations 001–005 must be applied to TEST_DATABASE_URL)
set -a && source .env.local && set +a
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --runInBand

# Build
rm -rf .next .open-next && npm run build
```

## Build Results

```
npm run type-check     ✓ 0 TypeScript errors
npm test --runInBand   194 unit passed
                       40 DB integration tests skipped — TEST_DATABASE_URL absent
                       0 failed
npm run build          ✓ Compiled · 35 static pages

Cloudflare scheduled event behavior cannot be tested locally.
Source and config correctness have been verified; build passes.
DB retry/recovery behavior NOT verified without TEST_DATABASE_URL.
```

## Caveats

- Cloudflare Cron Triggers must be enabled in the Cloudflare dashboard after first deployment
- Cron events are not testable locally with `wrangler dev`
- `processOneEmail` uses `FOR UPDATE SKIP LOCKED` — concurrent cron invocations process different rows
- Cron does not duplicate sends because idempotency is enforced in Resend and in the outbox state machine
