# KVRN V50.6 — Checkout Status and Visual Polish

## Changed / New Files

| File | Change |
|------|--------|
| `app/api/checkout/status/route.ts` | Rewritten — thin wrapper using injectable handler; returns only 3 public fields |
| `lib/checkout-status-handler.ts` | New — `createStatusGetHandler(deps)` factory; testable, no PII, read-only |
| `lib/format-money.ts` | New — `formatCheckoutPrice(cents)` shows decimals for non-whole-dollar amounts |
| `app/checkout/page.tsx` | Fix 2: `formatCheckoutPrice` for shipping/total; Fix 3: `checkout-input` class; Fix 4: mobile summary centering |
| `app/globals.css` | Fix 3: `.checkout-input` with visible border, focus darkening, error override |
| `lib/__tests__/reservations.test.ts` | Added: 25 V50.6 unit tests |
| `README-V50.6.md` | This file |

## What Each Fix Does

### Fix 1 — Checkout Status API

`/api/checkout/status?session_id=cs_test_...` now returns exactly:

```json
{ "reservationStatus": "completed", "orderNumber": "KVRN-001001", "paymentStatus": "paid" }
```

- Validates the complete session ID; never truncates
- Returns 400 for missing or invalid session_id
- Returns 404 for unknown-but-valid session
- Returns 500 (generic) on DB failure — no internal error detail exposed
- `Cache-Control: no-store` on all responses
- No PII, no UUIDs, no PaymentIntent IDs, no Stripe calls
- Works when `ENABLE_STRIPE_TEST_CHECKOUT=false`

### Fix 2 — Exact money formatting

New `lib/format-money.ts` → `formatCheckoutPrice(cents)`:

| Cents | Display |
|-------|---------|
| 8000 | `$80` |
| 1999 | `$19.99` |
| 2999 | `$29.99` |
| 9999 | `$99.99` |
| 10999 | `$109.99` |

Applied to shipping options, order-summary shipping, and order-summary total. Product prices retain the global `formatPrice` formatter.

### Fix 3 — Visible checkout input borders

All checkout inputs use `className="checkout-input"` (replaced `input-base` which had no border definition in globals.css). Includes optional phone after SMS opt-in.

CSS in `app/globals.css`:
- Normal: `1px solid #D1CCBF` (light warm gray)
- Focus: `border-color: #1A1A1A` (near-black)
- Error: `border-color: #B91C1C` (red override)

### Fix 4 — Centered mobile order summary

Order summary card changed from `flex: 0 0 340px` (fixed desktop width leaking into mobile) to `flex: 1 1 280px; maxWidth: 380; width: 100%; margin: 0 auto`. Equal left/right gutters at 320–430 px; desktop right-column behavior preserved via `flexWrap: wrap`.

## Manual Acceptance

### Status API (use existing paid sandbox session)

```
GET /api/checkout/status?session_id=<cs_test_...>
```

Expected:
```json
{ "reservationStatus": "completed", "orderNumber": "KVRN-001001", "paymentStatus": "paid" }
```

Reopen the existing success URL — must show:
- **Payment confirmed.**
- Order KVRN-001001
- Your order has been received.

### Money formatting

With $80 item, standard shipping:
- Standard option: `$19.99`
- Summary shipping: `$19.99`
- Summary total: `$99.99`

Express shipping:
- Express option: `$29.99`
- Summary total: `$109.99`

### Borders

Check email, phone (after opt-in), first name, last name, address, apartment, city, state, ZIP — all should show `1px solid #D1CCBF`; focus darkens to near-black.

### Mobile summary

At 320, 375, 390, 430 px — equal left/right gutters, no horizontal scroll, card centered.

## Build Results

```
npm run type-check     ✓ 0 TypeScript errors
npm test --runInBand   101 unit passed · 12 DB skipped · 0 failed
npm run build          ✓ Compiled · 36 static pages

DB integration tests skipped — TEST_DATABASE_URL absent.
DB behavior is NOT verified until integration tests run against a database
with migrations 002 and 003 applied.
ENABLE_STRIPE_TEST_CHECKOUT=false preserved.
```
