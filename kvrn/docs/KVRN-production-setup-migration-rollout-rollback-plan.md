# KVRN — Production Setup, Migration, Rollout and Rollback Plan

**This document describes steps for the owner to run. Nothing here has been executed.** The batch ships with every new feature OFF; migrations are additive.

## 1. Before anything else (hard requirements)

1. **Take a fresh Neon backup** (branch/snapshot) immediately before applying migration 027, using the Admin Backups page *and* a Neon branch from the Neon console. Record the timestamp and branch name.
2. **Run a restore test**: create a Neon branch from that backup point, point a throwaway environment (not production) at it, and confirm the app reads orders, products and affiliates. A backup that has not been restore-tested does not count. **Do not apply migration 027+ until this passes.**
3. Run the whole chain 001→035 on a **staging Neon branch** first and click through the QA checklist in §6.
4. Merge by file list. The baseline used for this work was reconstructed (`5cce4f1` was not supplied); diff the overlay file list against your real tree before copying.

## 1b. Record a known-good state and define stop conditions

* Before deploying, record in your change log: the currently deployed Cloudflare Worker version id (Workers → Deployments), the git commit it was built from, the Neon backup/branch name and timestamp from §1, and the current values of all `KVRN_FLAG_*` variables (expected: none set).
* **Stop immediately and roll back (§5) if any of these occur:** a migration errors or is partially applied; `bundle_snapshot_gaps()` or `i18n_currency_anomalies()` return rows; the flags-OFF smoke test (§6 A) shows any difference from today's storefront or checkout; a Stripe test-mode checkout fails; the webhook returns non-2xx; or an Admin page that worked before the deploy errors.
* Never enable the next flag while the previous one has an unexplained error in logs.

## 2. One-time infrastructure setup (owner actions)

| Step | Command / action | Notes |
|---|---|---|
| R2 media bucket | `npx wrangler r2 bucket create kvrn-media` | No public bucket/custom domain needed; the Worker serves `/media/*` |
| Bind R2 | Uncomment the `[[r2_buckets]]` block in `wrangler.toml` (binding `KVRN_MEDIA`, bucket `kvrn-media`), redeploy | Until bound, uploads fail with HTTP 503 "Media storage is not configured" (no fallback to Neon/disk) |
| New secrets (Cloudflare Worker secrets) | `ABANDONED_LINK_SECRET`, `AFFILIATE_AUTH_PEPPER`, `AFFILIATE_HASH_PEPPER`, `PUBLIC_API_RATE_PEPPER` — each ≥ 32 random characters | Generate yourself; never commit. Missing → the dependent feature fails closed |
| Stripe webhook events | Add `review.opened`, `review.closed`, `charge.succeeded`, `radar.early_fraud_warning.created` to the existing endpoint (Stripe Dashboard → Developers → Webhooks) | Existing events stay. Needed only before `RADAR_FULFILLMENT_HOLDS` |
| Cron | No change: `cloudflare-cron-wrapper.js` already calls `cms-scheduler`, `abandoned-checkout-sweep`, `affiliate-maintenance`, `affiliate-program-maintenance` every tick after the core jobs, authenticated with the existing `CRON_SECRET` | Each route is flag-gated inside |
| Resend | No new domain needed. Confirm the from-address used for transactional email also covers affiliate and recovery emails | Sending stays off until the flags are on |

## 3. Migration order and what each does

Apply in order, one at a time, in a maintenance window or low-traffic period. Each is idempotent (re-running is a no-op) and creates only new objects.

| # | File | Creates |
|---|---|---|
| 027 | `027_cms_foundation.sql` | media, content versions/translations, settings, redirects, cache-invalidation log, collections, CMS functions |
| 028 | `028_product_catalog_cms.sql` | product columns (type, HS code, country of origin, catalog origin…), catalog functions/trigger. **Then run `SELECT catalog_bootstrap_products();`** to adopt the coded products (marks them `legacy`; no price/stock change) |
| 029 | `029_bundles.sql` | bundle projection tables, `reserve_inventory_v2`, reservation/order snapshot tables and triggers |
| 030 | `030_site_content_cms.sql` | seeds current coded policies/FAQ/About/Contact/size-guide/announcement/navigation/footer/collection as *published* entities (so flag-on equals today's text) |
| 031 | `031_order_tags_fraud_review.sql` | order tags, fraud review tables, fulfillment-hold triggers on `orders`/`shipments` |
| 032 | `032_abandoned_checkouts.sql` | abandoned-checkout tables and functions |
| 033 | `033_affiliate_program_core.sql` | applications, invites, profiles (backfilled for existing affiliates), documents (5 placeholder v1 docs), acceptances, notes, outbox |
| 034 | `034_affiliate_portal_compliance_payouts.sql` | portal auth tables, compliance/UGC, payout-readiness, notifications |
| 035 | `035_localization_currency.sql` | read-only `i18n_currency_anomalies()` |
| 036 | `036_ai_os_foundation.sql` | AI operations/control-plane tables and budget/agent infrastructure |
| 037 | `037_security_hardening.sql` | DB-backed public API rate-limit events/function for abuse-resistant bundle quoting |

After 035: `SELECT * FROM i18n_currency_anomalies();` must return 0 rows; `SELECT * FROM bundle_snapshot_gaps();` must return 0 rows.

**Important:** migration 031 installs triggers that can block fulfillment updates when a hold exists. With `RADAR_FULFILLMENT_HOLDS` OFF no holds are created, so behavior is unchanged.

## 4. Deploy sequence

1. Deploy the new code with **all flags unset** (OFF). Expected: storefront output unchanged (English/USD), Admin looks refreshed, new Admin pages exist.
2. Smoke test (§6 A) on production read-only paths.
3. Enable flags **one at a time**, observing for at least a day between steps unless noted. Recommended order:
   1. `KVRN_FLAG_CMS_PUBLIC_CONTENT` — after reviewing seeded content in `/admin/content` and deciding the legacy `/legal/*` wording question.
   2. `KVRN_FLAG_CMS_PRODUCT_ROUTING` — after `catalog_bootstrap_products()` and a side-by-side check of PDP/shop for every product.
   3. `KVRN_FLAG_RADAR_FULFILLMENT_HOLDS` — after the webhook events are subscribed and a Stripe **test-mode** review is walked through.
   4. `KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS` — after reviewing the delay and consent mode in `/admin/abandoned-checkouts` (default consent mode requires an existing marketing opt-in) and setting `ABANDONED_LINK_SECRET`.
   5. `KVRN_FLAG_AFFILIATE_APPLICATIONS` — only after attorney-reviewed affiliate documents are published (§ affiliate checklist) and `AFFILIATE_HASH_PEPPER` is set.
   6. `KVRN_FLAG_AFFILIATE_PORTAL` — after `AFFILIATE_AUTH_PEPPER` is set and the Privacy/Cookie disclosure for the portal is published.
   7. `KVRN_FLAG_AFFILIATE_AUTO_PAYOUTS` — leave OFF; manual payouts recommended.
   8. `KVRN_FLAG_MULTI_CURRENCY_CHECKOUT` — leave OFF. Turning it on does not make any non-USD currency payable in this release.
4. Language switching (UI strings, RTL, estimates) is not behind a flag; verify English/USD golden behavior first, then enable locales one by one in `/admin/content` → Languages & currency (only locales that are complete can be enabled; all non-English text is AI-assisted and needs native review).

## 5. Rollback

Rollback is by **configuration and redeploy**, not by undoing migrations (all additive; leaving the new tables in place is harmless).

| Situation | Action |
|---|---|
| Any new feature misbehaves | Unset/turn OFF its `KVRN_FLAG_*` variable in Cloudflare; effect is immediate on the next request |
| Code regression | Redeploy the previous Worker version (Cloudflare → Workers → Deployments → Rollback). Old code ignores the new tables/columns |
| Bad CMS publish | Admin → item → Versions → Rollback (publishes a new version carrying the older snapshot; redirects and cache invalidation are applied) |
| Bad bundle | Turn the bundle OFF in the Product Editor and republish; carts with the set get the "no longer available as a set" message |
| Fraud hold applied in error | Release it in Admin → Orders with a note; flag OFF does *not* remove existing holds (by design) |
| Data corruption (worst case) | Restore from the Neon backup taken in §1; reapply only the migrations you want, after diagnosis |
| Cache shows stale pages | `/admin/system` → retry failed invalidations; cron retries every 5 minutes |

There is no down-migration. Do not drop the new tables during rollback; orders created while bundles were live keep their immutable snapshots.

## 6. QA checklists

**A. Flags OFF (immediately after deploy)** — homepage, shop, a PDP, cart, English/USD checkout through Stripe test mode, Admin Orders/Financials/Support/Pushover pages load; no console errors; `/admin/system` shows all flags OFF.

**B. Per feature (staging)** — Product Editor create → publish → appears in shop/sitemap; focal points desktop vs mobile; unpublish returns 404 but still opens in Admin; schedule; rollback; bulk with typed confirmation; preview iframe is noindex and loads no analytics. Content: edit a policy → live page updates; slug change redirects; removing `/shop`, `/contact` or legal links from nav/footer is blocked. Fraud: Stripe test review opens a hold, order stays PAID, shipment label creation is blocked with a 409, release works. Abandoned: abandon a test checkout, receive one email, link resumes with a fresh reservation, changed price is shown before payment, unsubscribe works. Affiliates: apply, approve, invite, accept terms, sign in via magic link, see only own data, suspend disables code/link. Languages: switch to Arabic → `dir=rtl`, no English flash on reload, prices stay LTR.

**C. Mobile/visual** — Admin tabs and tables on a phone width (tables scroll inside their card, no horizontal page scroll); tooltips never hide warnings.

## 6b. Not yet audited — do these on staging before go-live

Security pass (CMS/media/XSS/redirects, affiliate sessions/CSRF/IDOR), migration timing on a copy of production-sized data (check lock times), flag-OFF side-by-side regression sweep, Cloudflare Workers runtime check. See report §8b.

## 7. Open owner decisions before go-live

Whether abandoned-checkout rows should be recorded while the email flag is OFF, and the retention period; which legal wording is correct (USD/Delaware vs GBP/England); real affiliate documents; consent mode for recovery email; whether to keep affiliate payouts manual; native review of translations.
