# KVRN V49.4 — Final Migration and Deployment Corrections

## Files Changed / New

| File | Change |
|------|--------|
| `db/migrations/002_reservations_orders_v49.sql` | Rewritten — collision-free constraint names, reservation_id FK on movements |
| `lib/reservations.ts` | Updated — typed `failReservation` return, injectable service |
| `lib/stripe-client.ts` | Updated — `isValidStripeTestSecretKey` with length/char check, `isValidWebhookSecret` |
| `lib/site-origin.ts` | New — `getSiteOrigin()` using `new URL()`, HTTPS enforcement |
| `lib/checkout-status.ts` | Unchanged |
| `app/api/checkout/session/route.ts` | Updated — `getSiteOrigin()`, awaited cleanup, typed release, URL validation |
| `app/checkout/success/page.tsx` | Updated — clears cart on paid, truthful copy for all states |
| `lib/__tests__/reservations.test.ts` | Rewritten — per-test isolated fixtures, 30 unit + 4 integration |
| `package.json` | No duplicate `@opennextjs/cloudflare`; exact pins |
| `package-lock.json` | Regenerated |
| `.env.example` | `ENABLE_STRIPE_TEST_CHECKOUT=false` default, correct sections |
| `DELETE-FILES-V49.4.txt` | Delete commands for old webhook route |
| `README-V49.4.md` | This file |

## Delete Command

```bash
rm -f app/api/webhooks/stripe/route.ts
rmdir app/api/webhooks/stripe 2>/dev/null || true
rmdir app/api/webhooks 2>/dev/null || true
```

## Migration Command

```bash
psql "$DATABASE_URL" -f db/migrations/002_reservations_orders_v49.sql
```

Migration 002 has NOT been run. Run exactly once on Neon.

## Preflight Query (run BEFORE migration)

```sql
SELECT relname FROM pg_class WHERE relname IN (
  'orders','order_items','shipments','inventory_reservations',
  'orders_pkey','order_items_pkey','shipments_pkey',
  'orders_stripe_payment_intent_id_key','orders_stripe_checkout_session_id_key'
) ORDER BY relname;
```

## Post-Migration Verify

```sql
SELECT relname FROM pg_class WHERE relname IN (
  'orders_legacy_v45','order_items_legacy_v45','shipments_legacy_v45',
  'reservations','reservation_items','orders','order_items','shipments'
) ORDER BY relname;
-- Should return 7 rows
```

## Environment Variables

### Cloudflare Secrets (set in Workers & Pages → kvrn → Settings → Variables and Secrets)

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Neon connection string |
| `STRIPE_SECRET_KEY` | `sk_test_...` only |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from Stripe dashboard |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain |
| `CF_ACCESS_AUDIENCE` | Cloudflare Access audience tag |
| `ADMIN_EMAIL_ALLOWLIST` | Comma-separated admin emails |

### Cloudflare Ordinary Variables

| Variable | Value |
|----------|-------|
| `SITE_URL` | `https://kvrn.omidhamidi1110.workers.dev` |
| `ENABLE_STRIPE_TEST_CHECKOUT` | `false` until webhook verified, then `true` |

## Safe Deployment Order

1. Keep `ENABLE_STRIPE_TEST_CHECKOUT=false`
2. Overlay V49.4 files, run DELETE-FILES-V49.4.txt commands
3. Run `npm ci && npm test && npm run type-check && npm run build`
4. Run migration preflight query on Neon
5. Apply migration 002: `psql "$DATABASE_URL" -f db/migrations/002_reservations_orders_v49.sql`
6. Deploy to Cloudflare with checkout disabled
7. Create Stripe Sandbox webhook destination: `https://kvrn.omidhamidi1110.workers.dev/api/stripe/webhook`
8. Select events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
9. Add `STRIPE_WEBHOOK_SECRET` to Cloudflare secrets
10. Send a signed test delivery from Stripe dashboard — confirm HTTP 200 response
11. Set controlled test stock via `/admin/inventory`
12. Set `ENABLE_STRIPE_TEST_CHECKOUT=true`
13. Complete a real checkout through the KVRN storefront with sandbox card `4242 4242 4242 4242`
14. Verify DB state (queries below)

**Do not enable checkout before STRIPE_WEBHOOK_SECRET is installed and verified.**

## Webhook URL

```
https://kvrn.omidhamidi1110.workers.dev/api/stripe/webhook
```

## Stripe Events

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

## SQL Verification After Successful Payment

```sql
-- Reservation completed
SELECT id, status FROM reservations ORDER BY created_at DESC LIMIT 1;
-- status = 'completed'

-- Order paid
SELECT order_number, payment_status, total_cents FROM orders ORDER BY created_at DESC LIMIT 1;
-- payment_status = 'paid', total_cents = 8000

-- Immutable snapshots
SELECT sku, product_name, size, quantity, unit_price_cents
FROM order_items WHERE order_id = (SELECT id FROM orders ORDER BY created_at DESC LIMIT 1);

-- Inventory deducted
SELECT sku, stock_on_hand, reserved_quantity
FROM product_variants WHERE sku LIKE 'KVRN-D001-%';

-- Audit trail (reservation_id column)
SELECT movement_type, quantity_delta, reservation_id
FROM inventory_movements ORDER BY created_at DESC LIMIT 5;

-- Webhook recorded
SELECT stripe_event_id, processed, result
FROM webhook_events ORDER BY created_at DESC LIMIT 1;
-- processed = true, result = 'order_created'
```

## Rollback

```sql
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS reservation_items CASCADE;
DROP TABLE IF EXISTS reservations CASCADE;
DROP SEQUENCE IF EXISTS order_number_seq;
DROP FUNCTION IF EXISTS reserve_inventory(JSONB, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS attach_stripe_session(UUID, TEXT, BIGINT);
DROP FUNCTION IF EXISTS release_reservation_for_event(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS release_reservation_by_id(UUID, TEXT);
DROP FUNCTION IF EXISTS finalize_paid_order(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS mark_awaiting_payment(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS release_expired_reservations();
-- Restore legacy tables
ALTER TABLE inventory_reservations_legacy_v45 RENAME TO inventory_reservations;
ALTER TABLE order_items_legacy_v45 RENAME TO order_items;
ALTER TABLE orders_legacy_v45 RENAME TO orders;
ALTER TABLE payments_legacy_v45 RENAME TO payments;
ALTER TABLE checkout_sessions_legacy_v45 RENAME TO checkout_sessions;
ALTER TABLE shipments_legacy_v45 RENAME TO shipments;
-- Remove reservation_id from inventory_movements if needed
ALTER TABLE inventory_movements DROP COLUMN IF EXISTS reservation_id;
```

## Known Limitations

- Email confirmation not yet implemented (V50)
- Shipping carriers not yet implemented (V50)
- Refunds not yet implemented (V50)
- Admin orders UI not yet implemented (V50)
- `release_expired_reservations()` called synchronously on checkout; a Cloudflare cron trigger recommended for production
- Cloudflare Access domain transfer pending

## Actual Command Results

```
npm ci          ✓ Clean install
npm test        30 unit passed · 4 integration skipped (TEST_DATABASE_URL absent) · 0 failed
                NOTE: DB migration/concurrency/payment behavior NOT verified in this environment
npm run type-check  ✓ 0 TypeScript errors
npm run build   ✓ Compiled successfully · 36 static pages generated
```

## Confirmations

- `open-next.config.ts` — unchanged
- `wrangler.toml` — unchanged (`account_id = "5c2f1f1df8ff752572878665e985280b"`)
- `@opennextjs/cloudflare` appears exactly once (`devDependencies: 1.19.10`, no caret)
- `wrangler: 4.92.0`, `next: 15.5.18`, `react: 18.3.1`, `react-dom: 18.3.1` — all exact
- `jest: 29.7.0`, `ts-jest: 29.4.12`, `@types/jest: 29.5.14` — all exact
- `ENABLE_STRIPE_TEST_CHECKOUT=false` default in `.env.example`
- No live Stripe mode; `sk_live_` rejected at startup
- No secrets in any file
- Only one webhook route: `app/api/stripe/webhook/route.ts`
- Product URLs unchanged: `/products/kvrn-phantom-hoodie`, `/products/kvrn-phantom-sweatpants`
