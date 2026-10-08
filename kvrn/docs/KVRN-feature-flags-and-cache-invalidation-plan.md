# KVRN — Feature Flags and Cache Invalidation Plan

## 1. Feature flags

Flags are Cloudflare **Worker variables** named `KVRN_FLAG_<NAME>`. Truthy values: `on`, `true`, `1`, `yes`, `enabled` (case-insensitive). Anything else, empty or unset = **OFF**. They are read at call time from the environment (no database dependency, never cached across requests), so a flag can be turned off during a database incident. Do not set them in `wrangler.toml` (toml values are overwritten on every deploy); set them in the Cloudflare dashboard. `/admin/system` shows each flag's current state (read-only).

| Flag | Gates | OFF behavior (default) | Dependencies before turning ON |
|---|---|---|---|
| `KVRN_FLAG_CMS_PUBLIC_CONTENT` | Public pages read published CMS content (policies, FAQ, About, Contact, size guide, announcement, nav, footer, generic pages, collection page, sitemap entries, `/legal/*` canonical rendering) | Coded pages render exactly as before (golden-HTML tested) | Migration 030 seeded content reviewed; legacy `/legal/*` wording decision |
| `KVRN_FLAG_CMS_PRODUCT_ROUTING` | Admin-managed products on PDP, shop, inventory API, sitemap; bundles ("Complete the Set"); bundle checkout path; product translations overlay | Coded catalog only; ordinary carts use the original `reserve_inventory` | Migrations 028/029; `catalog_bootstrap_products()` run; R2 binding for images |
| `KVRN_FLAG_RADAR_FULFILLMENT_HOLDS` | Creating fraud holds from Stripe `review.opened` / early-fraud-warning events and enforcing them | No new holds created; existing holds remain enforced until released | Migration 031; webhook events subscribed |
| `KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS` | Sending the single recovery email and enabling the recovery link | Rows may be recorded; **nothing is sent**; recovery link disabled | Migration 032; `ABANDONED_LINK_SECRET`; consent mode reviewed |
| `KVRN_FLAG_AFFILIATE_APPLICATIONS` | Public `/affiliates/apply` and `/api/affiliates/apply`, invitation intake, program emails | Page and API return 404 and write no rows | Migration 033; `AFFILIATE_HASH_PEPPER`; real documents |
| `KVRN_FLAG_AFFILIATE_PORTAL` | `/affiliate` portal and `/api/affiliate/*`; payout-readiness gate on payout creation | Portal returns 404; payout creation behaves as before | Migration 034; `AFFILIATE_AUTH_PEPPER`; privacy disclosure |
| `KVRN_FLAG_AFFILIATE_AUTO_PAYOUTS` | Automated payouts via the provider adapter | Manual payouts only | Not recommended; adapter is an unconfigured skeleton |
| `KVRN_FLAG_MULTI_CURRENCY_CHECKOUT` | Would allow non-USD payable checkout | USD only | **Cannot make any currency payable in this release** (see support matrix) |

Not behind a flag (by design): Admin UI refresh, new Admin pages (they appear but show empty/OFF states), order tags, bulk product actions, language switching/RTL/estimates, Media Library (needs the R2 binding).

Independence: each flag is checked independently; no flag implies another. Turning one ON never turns another ON.

Operational rules: change one flag at a time; wait at least a day with monitoring for flags 1–4; flags must be OFF in any environment whose migrations have not been applied.

## 2. Cache model

The deployment uses OpenNext on Cloudflare with `incrementalCache` and `tagCache` set to `dummy`. Consequences and decisions:

1. Every CMS-backed public page is `export const dynamic = 'force-dynamic'`, so the database is the source of truth on each request and a stale page cannot be served by KVRN's own cache. (Side effect: `app/layout.tsx`, the PDP, the shop and wrapped content pages are server-rendered on demand even with flags OFF; markup is identical.)
2. The code **still issues `revalidatePath`/`revalidateTag` after every committed mutation**, so if a real cache is introduced later, or Cloudflare's edge caches a response, invalidation already happens at the right moments.
3. CDN/edge caching of HTML is not configured by this batch; if you add rules, purge by the same path list below.

## 3. Invalidation mechanics

`lib/cache-invalidation.ts → invalidateAfterCommit(sql, target, { reason, actor })`:

* Always called **after** the SQL mutation (which is one atomic database function call) has returned — never inside it, never before commit.
* Never throws. Records each attempt in `cache_invalidations` (paths, tags, reason, actor, status, error) and returns `{ ok, error }`.
* Admin routes return the failure to the editor ("Saved, but the live page may take a moment to refresh — Retry"). Failures are listed with a Retry button at `/admin/system` (`POST /api/admin/cache-invalidations`).
* The 5-minute cron (`/api/internal/cms-scheduler`) retries pending/failed rows (`retryPendingInvalidations`) and applies due scheduled publishes/unpublishes, invalidating the affected targets.
* Slug change, rollback to a different slug, unpublish and archive invalidate **both the old and new paths** (and create a redirect from the old slug).

## 4. What is invalidated, by mutation

| Mutation | Paths | Tags |
|---|---|---|
| Product publish / rollback / unpublish / archive / restore / schedule fire (`productInvalidation`) | `/products/<slug>` (and previous slug), `/shop`, `/`, `/sitemap.xml` | `cms:products`, `cms:product:<slug>`, `cms:sitemap` |
| Product bulk collection assignment | each affected `collectionInvalidation` | below |
| Collection create / edit / product assignment / archive / restore / translation (`collectionInvalidation`) | `/collections/<slug>` (+ previous slug), `/shop`, `/`, `/sitemap.xml` | `cms:collections`, `cms:collection:<slug>`, `cms:sitemap` |
| Policy (terms, privacy, cookies, shipping & returns) | the policy's public path (+ previous slug), `/legal/terms` or `/legal/privacy` for those two, `/sitemap.xml` | `cms:policies`, `cms:policy:<slug>`, `cms:sitemap` |
| Generic page | `/pages/<slug>` (+ previous slug), `/sitemap.xml` | `cms:pages`, `cms:page:<slug>`, `cms:sitemap` |
| Size guide | `/support/size-guide` and the product pages that use the guide | `cms:size-guides`, `cms:products` |
| Size-guide support page | `/support/size-guide` | `cms:size-guides` |
| Reusable content block | the owners that embed the block (resolved from `content_block_usages`) | per owner |
| FAQ | `/support/faq`, `/sitemap.xml` | `cms:faq` |
| About / Contact content | `/about` / `/contact` | `cms:pages` |
| Announcement / navigation / footer (`globalShellInvalidation`) | `/` (the root layout is dynamic) | `cms:announcement` / `cms:nav` / `cms:footer` |
| Global SEO | `/`, `/sitemap.xml` | `cms:seo`, `cms:sitemap` |
| Media archive/replace | `/`, `/shop` | `cms:media`, `cms:products`, `cms:pages`, `cms:policies` |
| Languages & currency settings (`i18n.config`, `i18n.fx`) | **no explicit invalidation** — settings are read per request with a ≤ 30 s per-instance memory cache | — |

Redirects (`content_redirects`) are served by the app (HTTP 308) and are created automatically on slug change.

## 5. Failure handling

| Failure | What happens | Operator action |
|---|---|---|
| Revalidation call fails | Row stays `failed` in `cache_invalidations`; the Admin shows a notice; cron retries | `/admin/system` → Retry |
| Database unavailable | Public CMS pages fall back to the coded page (flag-gated pages) or show the standard error; flags still work | Turn flags OFF if needed |
| Scheduled publish blocked (slug taken meanwhile) | The entity stays `scheduled` and is flagged overdue in Admin; other entities are unaffected | Fix the slug conflict |
| Settings propagation | Languages/currency settings may take up to ~30 s to reach other Worker instances; a settings read slower than 800 ms falls back to English/USD for that request | none |

## 6. Verification performed

Source-guard and DB tests assert: post-commit invalidation is called after every CMS mutation route; old and new paths are both invalidated on slug change/rollback/unpublish; failures are returned to the caller and logged; public CMS pages are `force-dynamic`. Not verified: behavior against a real (non-dummy) Cloudflare cache or CDN purge.
