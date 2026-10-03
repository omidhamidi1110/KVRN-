# Customer funnel analytics (first-party)

Five stages, one cohort: **visit → product view → add to cart → checkout started → purchase**.
Admin view: `/admin/analytics` (7d / 30d / 90d, default 30d). API: `GET /api/admin/analytics/funnel?range=30d` (`requireAdmin`).

## Storage
No migration. Reuses `analytics_sessions` / `analytics_events` from migration 011/012 (migration 022 remains the last one).
Idempotency without a schema change: `analytics_events.id` is the primary key, and every event gets a deterministic UUID
(sha256 of `kvrn-funnel-v1:<key>`) inserted with `ON CONFLICT (id) DO NOTHING`.

| Event | Key | Written by |
|---|---|---|
| `session_start` | `ss:<sid>` | browser → `POST /api/analytics/event` |
| `product_viewed` | `pv:<sid>:<productId>` | browser → same endpoint |
| `add_to_cart` | `atc:<sid>:<eid>` | browser → same endpoint (after the cart reducer accepted the add) |
| `checkout_started` | `cs:<reservationId>` | **server only**: checkout handler, after the Stripe session is created AND attached |
| `purchase_completed` | `pc:<orderId>` | **server only**: Stripe webhook, after `finalize_paid_order` |

## Trust model
The browser can only submit `session_start`, `product_viewed`, `add_to_cart`, in a strict allowlisted shape
(unknown field = whole event rejected). Product/variant ids are resolved server-side from slug/sku; the add value is the
server's `price_cents × quantity`. The browser never supplies money, ids of rows, names, emails or free text.
Purchase value is `orders.total_cents` copied by SQL (includes shipping and tax). A purchase can only attach to the
session that has a `checkout_started` row for that order's own reservation.

## Privacy / consent
* Obeys the existing cookie preferences (`kvrn_cookie_prefs_v2`, `analytics === true`, not expired).
  No choice yet, "deny", Do Not Track, or Global Privacy Control ⇒ nothing is stored and nothing is sent.
* Anonymous id = random UUID in `sessionStorage` (per tab, no cookie, gone when the tab closes).
* No IP, user agent, fingerprinting, or cross-site tracking is stored. Landing path is sanitised (no query string);
  only `utm_source`, `utm_medium` and `utm_campaign` (short plain tokens) and a normalised referrer origin are kept as first-touch fields. `utm_content` and `utm_term` are not captured by the browser and are refused by the server; any other UTM key is refused too.
* Admin paths / internal API paths are rejected; bots are not stored; 500 events per session cap.
* Policy wording (Privacy / Cookies pages) should be updated to describe this during legal polish.

## Reading the numbers
* Only consenting visitors are counted. Coverage answers: "of the orders whose `paid_at` is inside the window, how many
  have a `purchase_completed` event?" (same paid-order cohort for numerator and denominator, so it cannot exceed 100%
  and a late/healed event cannot move an order between windows). The admin page words it as:
  "X of Y paid orders in this window are linked to a tracked analytics session. Untracked orders may reflect
  declined/no analytics consent or unavailable analytics data." The raw purchase-event total (events created in the
  window) is reported separately.
* Money-path writes (`checkout_started`, `purchase_completed`) are best-effort and hard-bounded: each is raced against a
  2.5 s timer (`MONEY_PATH_ANALYTICS_TIMEOUT_MS`, plain `setTimeout`, no runtime-specific API). A timeout or failure is
  logged without ids/PII and the checkout / webhook carries on; a late rejection is swallowed. A missed purchase heals
  on Stripe's retry (deterministic event id).
* `add_to_cart` records the quantity the cart actually gained (the reducer clamps to `availableQuantity`); nothing is
  recorded when the cart did not grow.
* Stage counts are cumulative sessions that reached the stage **or later**, so rates never exceed 100%.
  Rates are `null` (shown as "—") when the denominator is 0, never a fake 0.
* Product table counts distinct sessions per stage.
