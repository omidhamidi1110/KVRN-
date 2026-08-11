# KVRN V51.3 — Shipment + Tracking + Shipping Confirmation Email

## Overview

Adds the fulfillment path from processing → shipped: admin enters carrier and tracking number, one shipment row is created atomically, order status becomes shipped, and a shipping-confirmation email outbox row is created in the same transaction.

## New / Changed Files

| File | Change |
|------|--------|
| `db/migrations/005_shipping_v51.sql` | New — UNIQUE(order_id) on shipments, email_type extended, `mark_order_shipped()` |
| `lib/admin-orders.ts` | Extended — `ShipmentInfo` type, shipment in detail, `markOrderShipped()` method |
| `app/api/orders/[id]/route.ts` | Extended — PATCH `fulfillmentStatus: "shipped"` branch with carrier+tracking validation |
| `lib/email.ts` | Extended — `ShippingConfirmationData` type, `shippingConfirmationHTML()`, `shippingConfirmationSubject()` |
| `lib/transactional-email.ts` | Extended — `loadShippingEmailData()`, branch in `processOneEmail` for `shipping_confirmation` |
| `app/admin/orders/AdminOrdersClient.tsx` | Extended — Mark shipped form (carrier select + tracking input), shipment display |
| `lib/__tests__/reservations.test.ts` | Added V51.3 unit + DB integration tests |
| `README-V51.3.md` | This file |

## Migration 005

**PREFLIGHT — run before migrating to check for duplicate shipments:**
```sql
SELECT order_id, COUNT(*) FROM shipments GROUP BY order_id HAVING COUNT(*) > 1;
```
If this returns any rows, resolve duplicates manually before applying the migration.

**Test database first (migration 004 must already be applied):**
```bash
set -a && source .env.local && set +a
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_shipping_v51.sql
```

**Production (PRODUCTION_MIGRATION_URL only — never DATABASE_URL):**
```bash
psql "$PRODUCTION_MIGRATION_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_shipping_v51.sql
```

## Shipment Transition Rules

| From | To | Result |
|------|----|--------|
| processing | shipped | ✅ Allowed — creates shipment + email row |
| unfulfilled | shipped | ❌ 409 invalid_transition |
| shipped | shipped | ✅ Idempotent — already_shipped |
| delivered | shipped | ❌ 409 invalid_transition |
| cancelled | shipped | ❌ 409 invalid_transition |

## PATCH /api/orders/[id] — Shipped Body

```json
{
  "fulfillmentStatus": "shipped",
  "carrier": "UPS",
  "trackingNumber": "1Z999AA10123456784"
}
```

- `carrier`: required, non-empty, max 50 chars, not silently truncated
- `trackingNumber`: required, non-empty, max 100 chars, not silently truncated
- Any extra fields: rejected 400
- Payment status, customer data, totals: immutable

## Email Type Extension

`transactional_emails.email_type` now accepts both:
- `order_confirmation` (V51.1)
- `shipping_confirmation` (V51.3)

Idempotency key: `shipping-confirmation/<order_id>`

One shipping-confirmation row per order guaranteed by `UNIQUE(order_id, email_type)`.

## Atomicity Guarantee

`mark_order_shipped()` PL/pgSQL commits:
1. Create shipment row (UNIQUE guard prevents concurrent duplicates)
2. Update `orders.fulfillment_status = 'shipped'`
3. Insert `transactional_emails` row for `shipping_confirmation`

All three commit together or all roll back. Email failure after commit cannot reverse shipped status.

## No Label Purchasing / Carrier API

V51.3 is manual entry only. Shippo/EasyPost label purchasing is deferred to a later phase.

## Build Results

```
npm run type-check     ✓ 0 TypeScript errors
npm test --runInBand   176 unit passed
                       34 DB integration tests skipped — TEST_DATABASE_URL absent
                       0 failed
npm run build          ✓ Compiled · 35 static pages
```

**DB integration tests skipped. Migration 005 + shipment atomicity NOT verified until
TEST_DATABASE_URL tests run with migrations 001–005 applied.**

## V51.1 + V51.2 Preserved

- Order-confirmation outbox and Resend adapter: unchanged
- Admin order list/detail/processing: unchanged
- `processOneEmail` for `order_confirmation`: regression-tested
- Cloudflare Access admin auth: unchanged
- `ENABLE_STRIPE_TEST_CHECKOUT=false`: unchanged

## Deployment

Via existing GitHub → Cloudflare production pipeline. Do not overwrite `open-next.config.ts` or `wrangler.toml`. Do not deploy manually.
