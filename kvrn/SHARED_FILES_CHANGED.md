# SHARED_FILES_CHANGED.md
Files edited by Claude that are shared with, or adjacent to, ChatGPT's half — with reasons and review notes.
Base = tag `cp08-base` (prod 07ac61f + Checkpoint 08). Migrations 038–047 are ChatGPT's and UNAPPLIED. No migrations were added; proposals live in `proposals/`.

| File | Why | Review note |
|---|---|---|
| `components/admin/ui/AdminUI.tsx` | **Black-strip root cause fix.** `AdminTable` + `AdminTabs` scroll wrappers are now `relative` (containing block), `overscroll-x-contain`; table wrapper is a keyboard-focusable labelled region. | Used by every admin page incl. ChatGPT's (Marketing, Store credit, AI, Live). Pure class/attribute change; no behaviour/data change. |
| `app/admin/financials/shipping/ShippingClient.tsx` | Presentation only: "1 order" singular, **unknown carrier cost shown as "Not recorded"/"Unknown" instead of $0.00** when no order has a recorded cost. | No money math touched (API/`lib/financials` unchanged). Copy helpers in `components/admin/shippingCopy.ts`. |
| `app/affiliate/portal/PortalClient.tsx` | Same containing-block class on 3 scroll wrappers (UI only). | No payout/ledger code touched. |
| `components/admin/content/forms.tsx`, `app/admin/products/[id]/sections/VariantsSection.tsx` | Same containing-block class. | CMS-owned. |
| `lib/__tests__/admin-ui-refresh.test.ts` | One pinned regex updated for the new AdminTable class list. | The 15 other failures in this suite are pre-existing (Backups pages removed in CP08) — see docs/CLAUDE_BASELINE_TEST_FAILURES.md. |
| `.gitignore` | Ignore `*.tsbuildinfo` (generated). | Trivial. |

## Cross-boundary findings (documented, NOT patched)
- `app/admin/ai/AiOperationsClient.tsx:384` has an `overflow-x-auto` tab strip that is not positioned (same pattern as the root cause). Proposed one-word patch: add `relative` to that className. Only matters if it contains absolutely-positioned/`sr-only` children; left for ChatGPT.
- Admin pages render inside the **storefront** root layout, so the cart/wishlist drawers, cookie banner and toast host are mounted (and their off-screen drawer content measured) on `/admin/*`. Harmless today (verified not to widen the page) but wasteful; proposal: skip them when `pathname` starts with `/admin` (needs `app/layout.tsx` + cart context owners).

## Added in the second pass (CMS / legal / SEO)
| File | Why | Review note |
|---|---|---|
| `lib/content-public.ts`, `lib/cms-core.ts`, `lib/content-seed-actor.ts` (new), `lib/content-seed.ts` | **P0 fix.** Migration 030 seeded OLDER policy/FAQ copy as *published* CMS versions. With `KVRN_FLAG_CMS_PUBLIC_CONTENT` on, that would have silently replaced the coded October 6 pages. Seed-published versions (`published_by = seed@kvrn.internal`) are now ignored by the public read path; the coded page keeps serving until a **person** publishes. | Migration 030 is applied in production and byte-pinned by a test, so the seed rows are untouched. No SQL change, no migration. |
| `lib/content-service.ts`, `lib/content-owner-draft.ts` (new), `app/api/admin/content/policies/[id]/owner-draft/route.ts` (new), `components/admin/content/{EntityEditor,VersionsPanel,ui}.tsx` | Publishing/rolling back the *unchanged* placeholder is refused (`seed_copy`, 409); terms/privacy get "Load October 6 draft" (writes a **draft** from `lib/owner-legal-generated.ts`, never publishes); History/badges stop calling the placeholder "Live". | CMS-owned. Reads `lib/owner-legal-generated.ts` (ChatGPT/owner generated file) read-only. |
| `components/admin/AdminShell.tsx` | The shell rendered `<main>` inside the root layout's `<main>` (nested landmarks). Now a focusable `<div id="admin-main">`. | Shared by every admin page. Skip-link still works (`tabIndex=-1`). `scripts/browser-responsive-audit.mjs` still finds `#admin-main`. |
| `components/ui/CookieConsent.tsx` | Cookie banner no longer renders on `/admin/*`. | Consent logic untouched. |
| `app/layout.tsx` | **Not edited.** (Listed because earlier notes proposed it.) | — |
| `app/page.tsx`, `app/contact/page.tsx`, `app/support/size-guide/page.tsx`, `app/collections/**`, `app/products/[slug]/page.tsx`, `lib/content-seo.ts`, `lib/product-seo.ts` | SEO: canonicals, unique descriptions, product Twitter card, BreadcrumbList (`lib/seo-jsonld.ts`, `components/seo/JsonLd.tsx`). | Home page body untouched (metadata only). No price/stock claims added. |
| `app/checkout/layout.tsx` (new) | `noindex` for `/checkout*` (robots.txt already disallows crawling). | Adds no markup. Does **not** touch `app/api/checkout/**`. |
| `components/admin/content/forms.tsx` | **CP08 build blocker:** an unescaped `'` (`react/no-unescaped-entities`) is an ESLint *error* that makes `next build` fail ("Failed to compile"). Fixed (`&apos;`). | One character class change. |
| `app/api/admin/content/policy-audit/route.ts` | Style only (`dynamic = 'force-dynamic'` spacing) so the route-auth guard test recognises it. | ChatGPT-origin file inside the CMS API folder. |
| `lib/__tests__/**`, `GA4-INTEGRATION.md` | Tests re-baselined for the seed-defer rule; GA4 doc/test now say Clarity is **disabled** (as CP08's `app/layout.tsx` already does); `.env.example` assertions run only where that file exists (it is not in the CP08 source snapshot). | — |

## Added in the third pass (frontend performance, Workstream E)
| File | Why | Review note |
|---|---|---|
| `next.config.js` | `images.loader: 'custom'` (`lib/image-loader.ts`) so static images resolve to pre-built WebP renditions; a 7-day `Cache-Control` for `/images-r/*`. `images.unoptimized` behaviour for everything else is unchanged (non-listed/R2/remote images pass through as-is). | Shared config. No redirects/headers other than the new `/images-r/` rule were touched. |
| `app/products/[slug]/PDPClient.tsx` | `srcSet`/`sizes` on 5 raw `<img>` sites; the mobile gallery's cache-warming `new Image()` now uses the same srcset instead of the multi-MB original (was ~8.8 MB wasted per PDP view). | Display only. No cart, price, stock, variant or checkout logic touched. |
| `components/product/CompleteTheSetBundle.tsx` | `srcSet`/`sizes` on the bundle thumbnails. | Display only. |
| `public/images-r/**`, `lib/image-renditions.generated.json`, `lib/responsive-image.ts`, `lib/image-loader.ts`, `scripts/generate-image-renditions.mjs` (new) | Generated renditions (53 files, ~4.3 MB, committed so the Worker build needs no image tooling) + manifest + helpers. Re-generate with `node scripts/generate-image-renditions.mjs` after adding/replacing a large image; `--check` fails when stale. | **Caution:** if a listed source image is replaced under the same filename without regenerating, the site keeps serving the OLD rendition (the loader does not check sha256 at runtime). `responsive-images.test.ts` and `generate-image-renditions.mjs --check` fail when the manifest is stale — run them before release. |
| `qa/perf/**`, `docs/perf/PERF_BASELINE.md` | Reproducible LAB measurement + results. | Not part of the build. |
| `tsconfig.json` (**proposed only**) | `target` ES2017 → ES2020 fixes CP08 BigInt build errors in store-credit files. | See `proposals/BUILD_BLOCKERS_CP08.md`; ChatGPT-owned files, not patched here. |

## Added in the fourth pass (CMS flow verification)
| File | Why | Review note |
|---|---|---|
| `components/admin/ui/InfoTip.tsx` | The 8px invisible touch pad (`before:-inset-2`) stuck out past the right viewport edge when a tip sat flush right, so the page measured 398px on a 390px phone (horizontal overflow on every Admin page using such a tip, e.g. the CMS editors' "About drafts"). Now `before:-inset-y-2 before:inset-x-0` (button itself stays 28px, above the 24px WCAG minimum). | Shared by ChatGPT's pages too. Class-only change, no behaviour change. |
| `lib/__tests__/admin-ui-primitives.test.ts` | Pins the vertical-only pad. | — |
| `qa/cms-e2e/singleton-lifecycle.mjs`, `qa/cms-e2e/pages-collections-lifecycle.mjs`, `docs/CMS_FLOW_VERIFICATION.md` (new) | Local-only lifecycle scripts + results. | Not part of the build. |

## Added in the final pass
| File | Why | Review note |
|---|---|---|
| `components/admin/ui/AdminUI.tsx`, `components/admin/ui/admin-stack.css` (new) | Table stack mode is now one implementation: a CSS file (below 640px each row becomes a labelled card; nothing hidden) + `labelStackCells`, which copies header text onto cells at runtime, so plain `<tr>/<td>` and `AdminTd` both work. `AdminTr/AdminTd` lost their per-element `max-sm:*` classes (same look, one source). | Shared by every admin page. Tables opt in with `<AdminTable stack>`; default unchanged. Verified in-browser on the System and Languages tables with real rows; logic unit-tested (`admin-table-stack-labels.test.ts`). |
| `<AdminTable … stack>` one-word additions in: `app/admin/{orders,abandoned-checkouts,discounts,analytics,sms,system}`, `app/admin/financials/{FinancialsClient,advertising,affiliates/*,costs,disputes,expenses,integrity,inventory,returns}`, `app/admin/products/[id]/sections/HistorySection.tsx`, `components/admin/content/{Collections,Languages,Versions}Panel.tsx` | Phone users read records as labelled cards instead of swiping. Matrix-style `infrastructure` table (expand column + detail rows) intentionally left as a scroller. | Pure prop additions → trivial to re-apply if ChatGPT's copy of these files differs. `app/admin/sms/AdminSmsClient.tsx` is display-only; **no SMS consent code touched**. Tables whose real rows could not be exercised in the scratch DB (orders, financials…) rely on the generic logic + tests, so look at them once with real data. |
| `lib/google-merchant-feed.ts`, `app/feeds/google-products.xml/route.ts` | Optional owner-supplied `gender` / `age_group` / `google_product_category` (env, validated, omitted by default). | Feed is still OFF by default. `lib/__tests__/google-merchant-feed.test.ts` (new). |
| `lib/content-owner-draft.ts`, `lib/content-service.ts`, `components/admin/content/{ContentHub,MessagingPoliciesCard}.tsx` | Messaging Terms / Messaging Privacy can be authored in the CMS: "Load October 6 draft" creates an unpublished draft from the owner text. Public pages stay 404 unless `KVRN_SMS_POLICY_PUBLIC_ENABLED=true` (unchanged). | Does not touch SMS consent machinery or `app/messaging-*` pages. |
