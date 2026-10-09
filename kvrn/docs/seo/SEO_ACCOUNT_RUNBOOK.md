# KVRN SEO / analytics account inventory & launch runbook

**Rules.** Statuses are exactly: `VERIFIED` (checked with evidence), `NOT CONFIGURED`, `ACCESS NEEDED`, `BLOCKED`, `NOT APPLICABLE`. This environment has **no** access to any external account, so nothing below is `VERIFIED` unless it is a statement about the code in this repo. **No external account has been changed.** Crawlable ≠ indexed ≠ ranking: no "indexed" or "ranking" claim is made anywhere.

## 1. Account inventory
| System | Status | Evidence / what the owner must do |
|---|---|---|
| Google Search Console property for `kvrn.shop` | **ACCESS NEEDED** | Not checkable from here. Owner: open Search Console → confirm a **Domain property** (DNS TXT) exists and that the owner account is *Owner*. Record verification method here. No verification meta tag or token exists in the code (searched `app/ lib/ components/`). |
| Search Console sitemap submitted | **ACCESS NEEDED** | Submit `https://kvrn.shop/sitemap.xml` (code serves it; 12 URLs locally). Record "Success"/"Couldn't fetch" and discovered-URL count. Do this only after the new build is live. |
| Search Console URL Inspection of key URLs | **ACCESS NEEDED** | Inspect `/`, `/shop`, one PDP, `/privacy`. "URL is on Google" ≠ ranking. |
| GA4 property + web data stream | **ACCESS NEEDED** | Code is ready (runtime id via `GET /api/analytics/config`, consent-gated, server purchase). Owner: confirm stream exists, copy the `G-…` id into the **Cloudflare Worker runtime variable** `NEXT_PUBLIC_GA_MEASUREMENT_ID` and create a Measurement Protocol API secret → Worker **secret** `GA4_MEASUREMENT_PROTOCOL_SECRET`. Admin → Analytics shows config *state* only (never the secret). |
| GA4 ecommerce events flowing | **ACCESS NEEDED** | After deploy, with consent granted, verify in GA4 *DebugView*: `page_view`, `view_item`, `add_to_cart`, `begin_checkout`; `purchase` arrives from the server with `transaction_id` = KVRN order number. Verify a repeat Stripe delivery does not create a second purchase. |
| GA4 internal-traffic / data retention / Google Signals | **ACCESS NEEDED** | Recommend: Google Signals **off** (code also sets `allow_google_signals:false`), 14-month retention, define staff IP filter. Owner decision. |
| Google Merchant Center account | **ACCESS NEEDED** | Feed route exists but is **OFF** (`KVRN_GOOGLE_MERCHANT_FEED_ENABLED` + `KVRN_FLAG_CMS_PRODUCT_ROUTING`). Apparel needs gender/age_group/color — current feed omits them (see research doc). Do not register the feed before the variant feed is built and the shipping/returns settings exist. |
| Merchant Center shipping & returns settings | **BLOCKED** | Blocked on owner/legal approval of the shipping & returns policy text. |
| Bing Webmaster Tools | **NOT CONFIGURED** (assumed) | Cannot verify. Optional: import from Search Console. |
| IndexNow | **NOT APPLICABLE** (for now) | No IndexNow key file or code exists. Google does not use IndexNow; only add if Bing traffic matters. Requires hosting a key file at the site root — an owner/deploy decision. |
| Microsoft Clarity | **NOT APPLICABLE** | Disabled in `app/layout.tsx`; must not load before consent. |
| Search Console / Merchant API reads inside Admin AI | **BLOCKED** | `lib/ai/integrations/google.ts` (ChatGPT-owned) reads Search Console/Merchant data when `GOOGLE_*` env vars exist; returns `NOT_CONFIGURED` otherwise. Not touched. |

## 2. Pre-launch checklist (owner runs; nothing here deploys anything)
1. Merge the final package; build; deploy **only with explicit owner approval**.
2. `KVRN_SEO_BASE=<private staging URL> node scripts/seo-crawl.mjs` and `node scripts/staging-seo-audit.mjs` — expect only the documented findings in `SEO_BASELINE.md`.
3. Confirm `https://kvrn.shop/robots.txt` lists the production sitemap, and the sitemap origin is `https://kvrn.shop` (not localhost/preview).
4. Upload a 1200×630 JPG/PNG share image (Admin → Content → SEO). Re-check `og:image` on `/`.
5. Decide whether PDP titles keep "Founder Price $80".
6. Legal: publish the Oct 6 policies only after review (Admin → Content → Policies). Until a human publishes, the storefront serves the coded Oct 6 copy (seed-published CMS versions are ignored).
7. Search Console: submit sitemap; inspect 4 URLs; check Pages report after ≥ several days. Record observations (with dates) in `SEO_BASELINE.md` — never claim "indexed" without the Pages/URL-inspection evidence.

## 3. GA4 production configuration (safe defaults)
* `NEXT_PUBLIC_GA_MEASUREMENT_ID` — **runtime** Worker variable (not needed at build time). Public id only.
* `GA4_MEASUREMENT_PROTOCOL_SECRET` — Worker **secret**. Never in the repo, logs or client.
* Browser GA loads **only** after effective analytics consent (preference `analytics=true`, DNT/GPC not set). Advertising consent signals are always `denied`. Withdrawal stops sends immediately and clears `_ga*` cookies.
* `purchase` is server-only (Stripe webhook → Measurement Protocol); the success page sends none. Idempotent via `transaction_id` = order number; value = canonical total − shipping − tax; no PII, no discount codes.
* Checklist after enabling: DebugView (consent granted), then again with consent declined → expect **zero** requests to `googletagmanager.com`/`google-analytics.com`.
* Known limitation (documented in `GA4-INTEGRATION.md`): a visitor who withdraws consent while on Stripe's hosted page cannot be detected for that order's server-side purchase.

## Merchant feed: optional apparel attributes (added in the final pass)
The product feed (`/feeds/google-products.xml`, still OFF unless `KVRN_GOOGLE_MERCHANT_FEED_ENABLED=true` and `KVRN_FLAG_CMS_PRODUCT_ROUTING=on`)
can now emit three **per-feed defaults** when — and only when — the owner sets them in Cloudflare Worker variables:

| Variable | Allowed values | Emitted as |
|---|---|---|
| `KVRN_MERCHANT_GENDER` | `male`, `female`, `unisex` | `<g:gender>` |
| `KVRN_MERCHANT_AGE_GROUP` | `newborn`, `infant`, `toddler`, `kids`, `adult` | `<g:age_group>` |
| `KVRN_MERCHANT_GOOGLE_CATEGORY` | a numeric Google taxonomy id, or a `A > B > C` path | `<g:google_product_category>` |

Unset or invalid = omitted (default output unchanged). Set them only if the value is true for **every** product in the feed. They are owner decisions;
nothing is guessed. Still missing before submitting to Merchant Center (status **BLOCKED / ACCESS NEEDED**): per-variant items with `item_group_id`,
`color`, `size` (needs a variant feed — not built, to avoid inventing stock), GTIN/MPN decision, shipping + return settings in the Merchant account,
and an approved Shipping & Returns policy.
