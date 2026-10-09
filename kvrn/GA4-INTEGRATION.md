# Google Analytics 4 integration

GA4 is an **optional, consent-gated, external** view of the storefront. KVRN's own first-party funnel
(`FUNNEL-ANALYTICS.md`, `/admin/analytics`) remains the system of record; GA is a separate system and its
numbers will not match exactly (ad blockers, sampling, processing delay, its own sessionisation).

## Environment variables
| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | **Cloudflare dashboard → Worker variable (RUNTIME)** | `G-XXXXXXXXXX`. Public. Missing or malformed ⇒ GA is off entirely (no script, no server send). **It must exist at runtime on the Worker. It is NOT needed — and is NOT read — at build time**, so it does not matter whether the Codespaces/CI build shell has it. The `NEXT_PUBLIC_` name is kept for continuity only; no source file inlines it (see below). |
| `GA4_MEASUREMENT_PROTOCOL_SECRET` | **Cloudflare secret** | Measurement Protocol API secret for the server-side purchase. Server-only: read in `lib/ga4-server.ts`, never logged, never in a payload, never sent to the browser. Missing or malformed ⇒ the server purchase is skipped (a non-PII log line); browser GA still works. |

### Runtime measurement-id architecture (why there is a config route)
KVRN builds locally (`next build` / OpenNext in Codespaces) and the measurement id is a Cloudflare **runtime** variable.
Next.js inlines every `process.env.NEXT_PUBLIC_*` reference **at build time**, so reading the id in `app/layout.tsx` (or any
client code) would bake whatever the build shell happened to contain into the browser bundle — an empty build shell would
permanently switch browser GA **off** while the server and the admin page (which read the runtime variable per request) said GA is
configured.

So no source file contains a literal `process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID` expression. Instead:

1. `GET /api/analytics/config` (`app/api/analytics/config/route.ts`, `force-dynamic`, `Cache-Control: no-store`) reads the variable from
   the Worker environment **per request** through `readPublicGaMeasurementId(env)` (`lib/ga-common.ts`) and returns
   `{ "measurementId": "G-…" | null }` — the validated public id and **nothing else**: not the Measurement Protocol secret, not
   whether a secret exists, no Cloudflare details, no other environment value. The real id is never hard-coded.
2. `<GaTracker />` takes no id prop. `lib/ga-client.ts` (`syncGa` → `ensureGaRuntimeId`) calls that route **only after effective
   analytics consent exists** (accepted AND no DNT AND no GPC). Before that no request is made at all. The answer is cached for the
   page lifetime (concurrent callers share one request; a transient failure is not cached) and `initGa()` stays idempotent.
3. `/admin/analytics` uses the same reader (`describeGaConfig` → `readPublicGaMeasurementId`) on the same runtime variable, so the
   admin status and what a consenting browser can actually initialise cannot disagree.

Deployment note: set `NEXT_PUBLIC_GA_MEASUREMENT_ID` as a Worker **variable** in the Cloudflare dashboard (runtime). Changing it needs no
rebuild. (`.github/workflows/deploy.yml` still passes it to the CI build; that value is now simply unused.)

## Consent behaviour (single source of truth: the existing cookie preferences)
GA reuses `analyticsConsentGranted()` from `lib/funnel-client.ts` — the same check the first-party tracker uses
(`kvrn_cookie_prefs_v2`, `analytics === true`, not expired, no DNT, no GPC). There is no second consent store.

**Effective consent = stored preference AND no Do Not Track AND no Global Privacy Control**, implemented once in the pure,
dependency-free `lib/consent-effective.ts` and shared by the funnel tracker, the GA client and the cookie-preferences context
(so there is no circular import). Consequences:
* Saving "analytics = yes" while DNT/GPC is on **never** sends `analytics_storage: 'granted'` to GA (`buildGtagConsentUpdate` sends `denied`).
* If a stored "yes" meets a DNT/GPC signal that appears later and GA is already running, `<GaTracker />` (`syncGa`) shuts GA down
  **immediately** (`disableGa()`), rather than waiting for the next send to notice.
* Normal accepted analytics with no opt-out behaves exactly as before; advertising signals stay denied.

| State | GA behaviour |
|---|---|
| No choice yet | **Nothing**: `gtag.js` is not loaded, `window.gtag`/`dataLayer` do not exist, no request to Google, nothing queued. |
| Accepted | `<GaTracker />` fetches the measurement id from the runtime config route, then creates the dataLayer, sets Consent Mode (`analytics_storage: granted`; `ad_storage`, `ad_user_data`, `ad_personalization` denied), configures GA with `send_page_view:false`, `allow_google_signals:false`, then loads `gtag.js`. |
| Declined | As "no choice": GA never loads. If it had loaded, see "withdrawn". |
| Withdrawn mid-session | Every send re-checks consent at call time, so the next event is dropped; `disableGa()` also sets GA's `ga-disable-<ID>` flag, sends Consent Mode `denied`, clears the view_item dedupe state and captured GA ids, and expires the `_ga*` cookies. Other tabs follow via the `storage` event. Re-granting re-enables GA (the script is not loaded twice). |
| Do Not Track | Treated as declined, even if analytics was accepted: GA does not load, the config route is not requested, Consent Mode is never `granted`; if DNT turns on mid-session GA is shut down immediately. |
| Global Privacy Control | Same as DNT. |
| "Targeted Advertising" toggle | Has no effect on GA: `ad_storage`, `ad_user_data` and `ad_personalization` are always `denied` (KVRN runs no ads). |
| Admin / `/api` / `/_next` routes | Never initialise GA and never send events, even if GA is already running. |

Previously the layout loaded `gtag.js` for every visitor with Consent Mode "denied" (Google still received
cookieless pings) and pre-defined `window.gtag`, so events fired before consent would have been queued and
flushed later. Both are gone: nothing Google-related is in the initial HTML.

## Event mapping
| GA4 event | Fired from | First-party counterpart | Notes |
|---|---|---|---|
| `page_view` | `<GaTracker />`, once per route (`gaPageView`, deduped per path) | `session_start` (once per session) | Automatic page_view is OFF, so the initial page is not double counted. `page_location` = origin + path + only `utm_source/medium/campaign` (safe tokens). `page_referrer` = origin only for another site. No other query string ever leaves the browser (e.g. `?session_id=` on the success page). |
| `view_item` | PDP effect | `product_viewed` | Once per product per tab session. Product-level (no variant yet). |
| `add_to_cart` | `CartContext.addItem`, only when the cart actually grew | `add_to_cart` | Quantity is the **actual delta** after stock clamping (`computeAddedQuantity`); nothing when already at the cap. |
| `begin_checkout` | `app/checkout/page.tsx` after the server created and attached the Stripe session and returned its URL | `checkout_started` | Never on a click. Failure paths return first. No coupon is sent. |
| `purchase` | **Server only**: Stripe webhook → `lib/ga4-server.ts` (Measurement Protocol) | `purchase_completed` | See below. The success page sends nothing. |

**Right after consent (the init window).** If a visitor accepts analytics while staying on a page, GA still has to fetch its runtime
config and initialise. `view_item`, `add_to_cart` and the custom events below therefore go through `runWhenGaReady()` (`lib/ga-client.ts`):
no effective consent ⇒ dropped at once (no config request, no queue, no storage); GA already active ⇒ sent synchronously (after making sure
the route's `page_view` exists); otherwise the send waits for `ensureGaReady()` (runtime id → consent re-check → `initGa` → route `page_view`),
re-checks consent again, and only then runs. Nothing is held in the data layer or storage while waiting, `view_item` stays once per product
per tab, and consent withdrawn / DNT / GPC arriving mid-wait means nothing is sent. **`begin_checkout` and the purchase never wait for GA**
(checkout wins; a not-ready `begin_checkout` is simply not sent).

### KVRN custom events (SMS popup)
Typed by `SmsAnalyticsEvent` in `lib/analytics.ts` (no cast anywhere); the only param is `event_category: 'sms_popup'` — never a phone number,
discount code or email.

| Event | Emitted when |
|---|---|
| `sms_offer_view` | popup becomes visible |
| `sms_offer_decline` | X / backdrop / Escape / NO THANKS (not when closing the "You're in" screen) |
| `sms_offer_reopen` | the persistent offer tab is clicked |
| `sms_deeplink_open` | the mobile `sms:` CTA is tapped |
| `sms_manual_submit` | manual phone form submitted (validation passed, request starting) |
| `sms_signup_success` | server answered success |
| `sms_signup_error` | server error, `success:false`, network failure or unparseable response |
| `sms_offer_accept` | declared but **reserved / not emitted**: there is no positive action distinct from the deep link or the manual submit |

Items: `item_id` = product slug on every event (so GA item reports join across the funnel), `item_variant` = variant SKU,
`item_name` = catalog product name, `item_brand` = `KVRN`, `price`/`value` in USD. Currency is explicit `USD`.
Integer cents are converted to GA's 2-decimal units only in `gaMoney()` (`lib/ga-common.ts`); an unknown amount is
omitted, never sent as 0.

## Purchase architecture and deduplication
* Canonical and server-side, sent from the webhook **after** `finalize_paid_order` committed the order. No browser purchase exists, so the
  browser cannot duplicate it.
* **Healing on Stripe retry/replay.** The send is attempted for the outcomes `order_created`, `already_processed` and `already_had_order` —
  the same outcomes that heal the first-party `purchase_completed` — whenever the event carries GA identifiers. A first send that timed
  out or failed therefore gets another chance on Stripe's retry. It is never attempted without a finalized order id (unpaid, failed,
  no-reservation and not-eligible outcomes have none) and the builder refuses any order whose `payment_status` is not `paid`
  (so a later-refunded order is not reported on a late replay). The 2.5 s bound and non-fatal behaviour apply to every attempt.
* **Deduplication.** `transaction_id` is **always the canonical KVRN order number** (never invented, never per-attempt), so every
  attempt for one order is byte-identical and Google collapses a purchase it already holds. There is no ledger and no migration:
  if Google already has it, the repeat is a no-op there; if it missed it, the repeat delivers it. Concurrent deliveries can send the
  same purchase more than once, which is harmless for the same reason and never affects order/payment correctness.
* Body is built from the **finalized order and its items in the database**: `value = total − shipping − tax` (GA convention:
  merchandise revenue net of discounts), `shipping`, `tax`, items with slug/sku/name/price/quantity. Nothing monetary comes from
  the browser or the Stripe event.
* **Discounts and item revenue.** Audit result: `order_items.unit_price_cents` is the **pre-discount** reservation snapshot
  (`finalize_paid_order`, migrations 002/019/022); the merchandise discount is recorded only on the order
  (`orders.discount_cents`), and `total = max(0, subtotal − discount) + shipping + tax`. To keep GA item revenue equal to `value`,
  the order's merchandise discount is allocated across the lines at the GA boundary only (`allocateDiscountAcrossLines`:
  proportional to each line, integer cents, largest-remainder, ties to the earlier line), so `Σ price × quantity = value`.
  Fractional per-unit prices (e.g. 3 units for 10.00 → 3.333333) exist only in the GA payload. A **shipping-only** discount is not a
  merchandise discount (`discount_cents` stays 0; it is already inside `shipping`), so it never reduces item revenue. If the figures do
  not reconcile exactly in integer cents (lines ≠ subtotal, discount > subtotal, `value` ≠ subtotal − discount, unknown amounts, more than
  50 lines) the item `price` fields are **omitted** (never fabricated) and `value` stays the canonical total-based figure; a non-PII log
  line records why. No KVRN order/COGS/discount/accounting record is read for write or changed, and the discount code is never sent.
* Attribution: the browser sends GA's own pseudonymous `client_id`/`session_id` with the checkout request **only while GA is active**
  (i.e. after consent). They are shape-checked (`digits.digits` / `digits`) and stored in Stripe session metadata
  (`ga_client_id`, `ga_session_id`) — no KVRN database change. No GA client id ⇒ the visitor wasn't running GA ⇒ **no purchase is sent**.
* No PII: no name, email, phone, address, payment ids, notes, discount code or `user_id`.

## Timeout and failure behaviour
The order read, payload build and HTTP call share one hard **2.5 s** bound (`GA_SERVER_TIMEOUT_MS`, plain `setTimeout` +
`AbortController`, no runtime-specific API) and run concurrently with the first-party purchase write, so the webhook is delayed by at
most one bound. Missing/malformed configuration, a missing client id, a non-USD/unpaid order, a DB error, a network error, a
timeout, a non-2xx answer and an unparseable response are all just a logged, non-PII "skipped" — the response body is never read.
A late rejection after the timeout is swallowed. Stripe's retry semantics never depend on GA (a miss is healed by the *next* delivery, but nothing waits for or fails on GA). The secret and the request URL are never logged.

## Admin
`/admin/analytics` shows two clearly separate panels: the KVRN first-party funnel (everything below) and Google Analytics 4 as an
external system — configuration **state** only (measurement ID present/valid, secret set/valid; never the secret) and a link out to
Google Analytics. No GA numbers are pulled in.

## Intentionally deferred
* GA Reporting API / OAuth / service accounts (no GA numbers inside KVRN Admin).
* A durable "GA purchase sent" ledger. Healing relies on Stripe's own retries/replays plus Google's `transaction_id` dedupe; if Stripe never
  redelivers after a missed send, that purchase can be reconciled from the first-party/Stripe records. A ledger would need a migration.
* A purchase for a visitor who withdraws consent while on Stripe's hosted page cannot be detected (the consent decision was made at checkout).
* Google Ads / Meta / any ad-tech, audiences, enhanced conversions, user_id.
* **Microsoft Clarity** is **disabled** in `app/layout.tsx` (Checkpoint 08): it must never initialize before effective analytics consent.
  `NEXT_PUBLIC_CLARITY_PROJECT_ID` is therefore not read anywhere. Re-enable only with a tested consent/revocation lifecycle (same gate as GA4:
  `analyticsConsentGranted()`, DNT/GPC respected). Until then no Clarity request is made for any visitor.
* The orphaned `components/ui/CookieBanner.tsx` (separate legacy consent key, not rendered) is left untouched.
* Privacy / Cookies page wording should be updated to describe the above.
