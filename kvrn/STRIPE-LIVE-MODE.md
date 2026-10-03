# Running KVRN on Stripe live mode

KVRN runs in Stripe **test** mode (default) or **live** mode. The mode is chosen
deliberately with a server-side variable; nothing is inferred from the key alone.

| Variable | Type | Test mode | Live mode |
|---|---|---|---|
| `STRIPE_MODE` | Cloudflare variable | unset, or `test` | **`live`** |
| `STRIPE_SECRET_KEY` | Cloudflare **secret** | `sk_test_…` | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare **secret** | `whsec_…` of the **test** endpoint | `whsec_…` of the **live** endpoint |
| `ENABLE_CHECKOUT` | Cloudflare variable | `true` to open | `true` to open |

Rules enforced in code (`lib/stripe-mode.ts`, `lib/stripe-client.ts`):

* A live key **without** `STRIPE_MODE=live` is rejected. A test key **with** `STRIPE_MODE=live` is rejected.
* An unrecognised `STRIPE_MODE` (anything but `test`/`live`) is rejected, never defaulted.
* Restricted keys (`rk_…`) and malformed keys fail closed in both modes.
* Checkout is **closed by default**. It opens only when `ENABLE_CHECKOUT` is exactly `true`.
  The legacy `ENABLE_STRIPE_TEST_CHECKOUT` still works, but only in test mode and only while
  `ENABLE_CHECKOUT` is unset; it can never open live checkout.
* No secret is ever sent to the browser; error messages name variables, never values.

## Turning live checkout on (do this in the Cloudflare dashboard, not in `wrangler.toml`)

`wrangler.toml` is not changed by this patch and still sets `ENABLE_STRIPE_TEST_CHECKOUT = "false"`.
That is harmless: `ENABLE_CHECKOUT`, when present, takes precedence. `keep_vars = true` keeps
dashboard-set variables across deploys.

1. In Stripe (live mode) create the webhook endpoint `https://kvrn.shop/api/stripe/webhook` with events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
   `refund.created`, `refund.updated`, `charge.refund.updated`, `charge.dispute.created`,
   `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
   `charge.dispute.funds_reinstated`.
2. Set secrets: `npx wrangler secret put STRIPE_SECRET_KEY` (the `sk_live_…` key) and
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` (the live endpoint's `whsec_…`).
3. Set variable `STRIPE_MODE` = `live`.
4. Deploy, confirm the webhook endpoint shows successful deliveries, then set `ENABLE_CHECKOUT` = `true`.

To close checkout instantly: set `ENABLE_CHECKOUT` = `false` (or delete it, and keep the legacy flag `false`).
To return to test mode: set `STRIPE_MODE` = `test` (or remove it), restore the `sk_test_…` key and the test
endpoint's `whsec_…`.

## Payments that cannot be finalized

If Stripe reports a successful payment that KVRN cannot safely turn into an order, the payment is
recorded in `payment_exceptions` (migration 022) and logged as `[WEBHOOK][PAYMENT_EXCEPTION]`.
Review with `GET /api/admin/payment-exceptions` (Cloudflare Access protected). Refund the customer in the
Stripe Dashboard, then close the row with
`PATCH /api/admin/payment-exceptions/<id>` `{ "resolution": "refunded", "note": "re_… issued" }`
(`resolution` is `refunded`, `fulfilled_manually` or `dismissed`; a note is required and the change is audited).
