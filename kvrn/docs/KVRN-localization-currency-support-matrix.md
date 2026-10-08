# KVRN — Localization and Currency Support Matrix

Status at delivery. Source of truth in code: `lib/i18n/currency-policy.ts` (`currencySupportMatrix()`, `CURRENCY_BLOCKERS`, `PAYABLE_AUDIT_PASSED = ['USD']`). The Admin tab **Content → Languages & currency** renders the same matrix live.

## 1. Bottom line

* **USD is the only payable checkout currency.** English/USD checkout is unchanged.
* All nine other currencies (EUR, GBP, CAD, AUD, AED, JPY, CNY, MXN, SAR) are **display-only estimates**, shown as "≈ …" with a "charged in USD" note, and only when an owner has configured an FX rate in Admin (`site_settings` key `i18n.fx`). There are **no built-in exchange rates** any more.
* Turning on `KVRN_FLAG_MULTI_CURRENCY_CHECKOUT`, or enabling a currency in Admin, **cannot make anything payable** today. The checkout handler fails closed (HTTP 500) if the policy ever resolves to a non-USD charge.
* Reason: making a foreign currency payable requires changing frozen financial SQL and formulas (order finalization, reservation pricing, refunds, disputes, fees, affiliate math, analytics). This batch forbids that, so the deliverable is the audit, the plan and a detector.

## 2. Currency matrix

| Currency | Displayable now | Payable now | Why not payable |
|---|---|---|---|
| USD | Always | **Yes** | Base and settlement currency |
| EUR, GBP, CAD, AUD, MXN | Only if enabled in Admin **and** a rate ≤ 30 days old exists (8–30 days = shown with a stale warning; >30 days = not used, falls back to USD) | No | Blockers 1–10 below |
| JPY | Same rule | No | Blockers 1–10, plus JPY is zero-decimal in Stripe: KVRN's integer-cent maths would need a per-currency minor-unit table |
| AED, SAR, CNY | Same rule | No | Blockers 1–10, plus support was not verified against the account's Stripe presentment list (no Stripe call was made, by design) |

If no rate is configured, prices simply show in USD.

## 3. The ten blockers (all must be solved before any currency is payable)

| # | Key | What blocks it | Work required |
|---|---|---|---|
| 1 | `order_finalize` | Frozen `finalize_paid_order` raises `CURRENCY_MISMATCH` for any non-`usd` session | New finalize path that records presentment currency/amount and USD base separately |
| 2 | `reservation` | Frozen `reserve_inventory` rejects non-`usd` and snapshots USD prices | `reserve_inventory_v2`-style variant carrying presentment currency |
| 3 | `refunds_disputes_fees` | Every Admin aggregate sums `amount_cents` with no currency filter | Currency-aware aggregation + base-currency normalization from Stripe balance transactions |
| 4 | `reporting_currency` | USD is the implicit reporting currency, never declared | Declare reporting/base currency and show it on every financial page |
| 5 | `discounts` | Stripe fixed-amount coupons exist in USD only | Per-currency coupon amounts or percentage-only for foreign currency |
| 6 | `shipping` | Shippo rates and `shipping_options` are USD; converting would double-convert; there is one USD free-shipping threshold | Keep one canonical USD threshold; present converted messaging only |
| 7 | `analytics` | Server GA4 purchase is refused for non-USD orders | Send value/currency consistently |
| 8 | `affiliates` | Commission, payout and clawback maths run on USD cents | Commission on USD base amount |
| 9 | `abandoned_recovery` | Recovery supports USD only | Persist presentment currency |
| 10 | `stripe_api` | `stripe@16.12` (API 2024-06-20) has no Adaptive Pricing create parameter; line-item `price_data` has no `currency_options` | SDK/API upgrade, or enable Adaptive Pricing in the Stripe Dashboard (an account setting KVRN cannot enable from code) and reconcile the resulting settlement data |

Migration 035 adds `i18n_currency_anomalies()`: a read-only list of any non-USD rows already present in orders, refunds, disputes, dispute balance transactions, payment exceptions and abandoned checkouts. It must return **zero rows** now and is the early-warning check if anything ever creates a foreign-currency record.

## 4. Language matrix

| Locale | Dictionary | Direction | Stripe Checkout `locale` | Review status |
|---|---|---|---|---|
| en | 420/420 keys (source) | LTR | `en` | source |
| es | 420/420 | LTR | `es` | AI-assisted, unreviewed |
| fr | 420/420 | LTR | `fr` | AI-assisted, unreviewed |
| ar | 420/420 | **RTL** | `auto` (Stripe SDK type excludes `ar`) | AI-assisted, unreviewed |
| zh | 420/420 | LTR | `zh` | AI-assisted, unreviewed |
| hi | 420/420 | LTR | `auto` (not supported by the SDK type) | AI-assisted, unreviewed |
| pt | 420/420 | LTR | `pt` | AI-assisted, unreviewed |
| de | 420/420 | LTR | `de` | AI-assisted, unreviewed |
| ja | 420/420 | LTR | `ja` | AI-assisted, unreviewed |
| ko | 420/420 | LTR | `ko` | AI-assisted, unreviewed |

* `makeFallback` is gone. A test enumerates every key for every locale; a locale is "ready" only if all keys exist and are non-empty, and an incomplete locale cannot be enabled in Admin (and is never served even if an old setting lists it).
* Shipped defaults: all locales default to USD and only USD is enabled, so choosing a language does not change the price currency until the owner configures `i18n.config`.
* Preferences: cookies `kvrn_locale` and `kvrn_currency` (SameSite=Lax, Secure in production, one year, not HttpOnly because the client selector writes them, no sensitive data). The server reads them in `app/layout.tsx` to set `<html lang dir>` and seed the providers — no English or price flash.
* Language → default currency: choosing a language applies that locale's configured default currency; the currency selector overrides it; choosing a language again re-applies the default.

## 5. Translated vs not translated

| Translated through dictionaries (all 10) | Translated through the CMS (per-language status, English fallback labelled) | Still English |
|---|---|---|
| Navigation, footer, announcement fallback, existing coded homepage wording (not editable), shop, collections, PDP, selectors, bundle strings, bag/cart, checkout handoff, waitlist, About, Contact, order tracking, cookie consent, success/error/empty/loading/validation | Product pages (name, description, SEO/share), policies, size guides, content blocks, FAQ, generic pages, About/Contact content, announcement, navigation, footer, collections, SEO/share text | Coded legal/FAQ/shipping/size-guide fallback prose (shown with an "English only" notice until a translation is published), SMS popup, affiliate portal, server API error strings, page metadata for CMS pages, the related-product name inside "Complete the set" |

Never translated by language (commerce facts): SKU, inventory, product identity, price source, weight/dimensions, cost/COGS.

Machine-generated text can never be `published` (database constraint). Legal/policy languages require a deliberate publish with an acknowledgement.

## 6. RTL (Arabic)

`dir=rtl` set on `<html>` from the server; logical classes in new code; a scoped `[dir=rtl]` stylesheet for byte-pinned components; cart and wishlist drawers slide from the correct side; numbers, prices and inputs stay LTR. Known gap: the cookie-consent toggle thumb is not mirrored. Needs a human visual pass on PDP, cart, forms, content pages, accordions and the preview.

## 7. Estimates and FX configuration

* Admin → Languages & currency → FX: rates (USD → X), `as_of`, `source`. Fresh ≤ 7 days; stale 8–30 days (still used, flagged); expired > 30 days (not used). KVRN never invents a rate.
* Stripe-hosted Checkout always charges USD in this release; the checkout page states "charged in USD" next to estimates.

## 8. Free shipping and shipping

One canonical USD free-shipping rule remains. No per-currency thresholds. Shippo amounts are never converted.

## 9. Owner to-do before any future currency is enabled

Declare a reporting currency; implement blockers 1–9; decide Adaptive Pricing vs explicit presentment; run `i18n_currency_anomalies()` on a staging branch after Stripe test-mode foreign-currency payments, refunds and disputes; reconcile fees from balance transactions; only then change `PAYABLE_AUDIT_PASSED` (a code change with its own audit).
