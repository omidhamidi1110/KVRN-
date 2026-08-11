# KVRN V51.2 — Real Admin Order Management

## Overview

Replaces mock order APIs with real Neon-backed admin order management. Adds a production-ready admin orders dashboard. V51.1 transactional email outbox remains intact and untouched.

## New / Changed Files

| File | Change |
|------|--------|
| `lib/admin-orders.ts` | New — injectable `createAdminOrderService(sql)` with list, count, detail, transition |
| `app/api/orders/route.ts` | Replaced mock with real Neon + `requireAdmin` auth |
| `app/api/orders/[id]/route.ts` | Replaced mock with real Neon + `requireAdmin` auth + strict PATCH |
| `app/admin/orders/page.tsx` | New — admin orders page with metadata (noindex) |
| `app/admin/orders/AdminOrdersClient.tsx` | New — full admin dashboard UI |
| `lib/__tests__/reservations.test.ts` | Added V51.2 unit + DB integration tests |
| `README-V51.2.md` | This file |

## No Migration Required

V51.2 uses the existing schema from migrations 001–004. No new migration was added.

## Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/orders` | GET | requireAdmin | List orders with filtering/pagination |
| `/api/orders/[id]` | GET | requireAdmin | Order detail with items |
| `/api/orders/[id]` | PATCH | requireAdmin | `unfulfilled → processing` only |
| `/admin/orders` | GET | Cloudflare Access | Admin dashboard |

## GET /api/orders Query Parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `paymentStatus` | string | — | pending, paid, failed, refunded |
| `fulfillmentStatus` | string | — | unfulfilled, processing, shipped, delivered, cancelled |
| `search` | string | — | Matches order_number, customer_email, customer_name (ILIKE) |
| `limit` | integer | 50 | Hard cap 100; rejected if malformed |
| `offset` | integer | 0 | Rejected if malformed or negative |

## PATCH /api/orders/[id]

Only supported transition in V51.2:

```json
{ "fulfillmentStatus": "processing" }
```

Responses:
- `200` — updated or already_processing (idempotent)
- `400` — unsupported transition or extra fields
- `404` — order not found
- `409` — current status is shipped/delivered/cancelled

Any other body keys (paymentStatus, trackingNumber, etc.) are rejected with 400.

## Security

- Every order API route calls `requireAdmin(req)` before any DB access
- No order data returned before authentication
- Status values whitelisted; no arbitrary SQL from query params
- Search uses parameterized ILIKE — no string concatenation
- Pagination clamped and validated
- Generic 500 on DB errors — no raw DB messages exposed
- No shipment records created
- No email outbox rows created
- No Stripe mutations

## Admin UI

Accessed via `/admin/orders` through Cloudflare Access.

Features:
- Order list with filter by payment/fulfillment status and search
- Pagination (50 per page)
- Click any order to view detail panel
- Detail shows customer, address, items, totals, timestamps
- "Mark processing" button on unfulfilled orders (requires confirmation)
- Success/error feedback after transition

## Test Commands

```bash
# Clean install
npm ci

# Type-check
npm run type-check

# All tests (DB tests skipped without TEST_DATABASE_URL)
npm test -- --runInBand

# DB integration tests (apply migrations 001-004 to TEST_DATABASE_URL first)
set -a && source .env.local && set +a
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --runInBand

# Build
rm -rf .next .open-next
npm run build
```

## Environment Variables Required

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `DATABASE_URL` | Cloudflare secret | Neon production DB |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare secret | Admin Cloudflare Access |
| `CF_ACCESS_AUDIENCE` | Cloudflare secret | Admin Cloudflare Access |
| `ADMIN_EMAIL_ALLOWLIST` | Cloudflare variable | Comma-separated admin emails |
| `TEST_DATABASE_URL` | `.env.local` only | Integration test DB |
| `ENABLE_STRIPE_TEST_CHECKOUT` | Cloudflare variable | `false` — unchanged |

## Actual Test Results

```
npm run type-check     ✓ 0 TypeScript errors
npm test --runInBand   151 unit passed
                       25 DB integration tests skipped — TEST_DATABASE_URL absent
                       0 failed
npm run build          ✓ Compiled · 35 static pages
```

**DB integration tests were skipped. Order service DB behavior is NOT verified until
TEST_DATABASE_URL tests run against a database with migrations 001–004 applied.**

## V51.1 Preserved

- `lib/email.ts` — orderConfirmationHTML, orderConfirmationSubject
- `lib/resend-adapter.ts` — createResendAdapter, getEmailProvider
- `lib/transactional-email.ts` — loadOrderEmailData, processOneEmail, processPendingTransactionalEmails
- Migration 004 — transactional_emails outbox table
- Webhook processPendingTransactionalEmails call

## Not Implemented in V51.2

- Shipment records (V51.3)
- Shipping confirmation emails (V51.3)
- Tracking number input (V51.3)
- Order cancellation / refunds (future)
- processing → shipped transition (V51.3)

## Deployment

Via existing GitHub → Cloudflare production pipeline. Do not overwrite `open-next.config.ts` or `wrangler.toml`. Do not deploy manually.
