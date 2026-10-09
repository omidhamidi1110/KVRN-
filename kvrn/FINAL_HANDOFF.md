# KVRN — Claude workstream final handoff (A–F) — 2026-10-08

**Label: CODE-COMPLETE and locally verified. NOT production-validated.** Nothing was deployed, pushed, migrated, published, sent, charged or
changed in any external account. All verification ran against a local scratch Postgres and local dev/production-mode builds.
Base: Checkpoint 08 on top of production Git `07ac61f` (CP08 migrations 038–047 still unapplied; 027–037 untouched). **No new migration (048+).**

## 1. How to take this
1. Use ONLY the newest `KVRN_CLAUDE_*.zip`. **Its `tracked-changes.patch` is relative to Checkpoint 08 source (git tag `cp08-base`), NOT relative to bare `07ac61f`.**
   (The `RECOVERY_README.txt` generated inside the ZIP says "baseline 07ac61f"; read that as "07ac61f **with Checkpoint 08 already layered**", i.e. the
   `kvrn-claude-ui-cms-seo` worktree made by `prepare_claude_worktree.sh`, or the contents of `KVRN_SHARED_BASE_CP08_SOURCE`.)
   Applying it to a bare 07ac61f tree will fail or silently miss CP08 files. It was verified here: `git apply --check` + `git apply` on a pristine `cp08-base`
   checkout succeeds (86 tracked files changed, 53 binary renditions included). Older checkpoints are redundant — do not stack them.
2. In a clean CP08-layered worktree: `git apply --check tracked-changes.patch && git apply tracked-changes.patch`, then copy `new-files/` (empty in the final ZIP; everything is in the patch).
   Review `SHARED_FILES_CHANGED.md` first.
3. Apply the two build blockers from `proposals/BUILD_BLOCKERS_CP08.md` (tsconfig `target` ES2020; resend-webhook `BufferSource` casts) — they are in ChatGPT-owned files and **`next build` fails without them**. They were only patched in a scratch copy.
4. `npm ci && node scripts/generate-image-renditions.mjs --check && npx jest` (see §4), then your normal OpenNext/Cloudflare build (not run here — see §6).

## 2. What each workstream delivered
| | Delivered (verified how) | Not done / needs a person |
|---|---|---|
| **A Admin responsive** | Black-strip root cause fixed (unpositioned `overflow-x:auto` box did not contain `.sr-only` descendants) in `AdminTable`/`AdminTabs`; InfoTip 8px sideways touch pad removed (it widened pages to 398px on phones); nested `<main>` removed; shared table **stack mode** (labelled cards <640px, nothing hidden) enabled on ~45 record tables; unknown carrier cost shown as "Not recorded" (not $0); "1 order" copy. Measured 390px on all 29 static Admin routes + 12 Content tabs (Chromium mobile emulation). | Real iOS Safari/WebKit not tested. Tables other than System/Languages were not seen with real rows (scratch DB empty) — logic is generic + unit-tested, look once with real data. `infrastructure` table left as scroller. ChatGPT's `AiOperationsClient` tab strip: proposed one-word fix in `SHARED_FILES_CHANGED.md`. |
| **B CMS** | Local lifecycle scripts (draft→preview-safe→publish→stale-save 409→rollback) pass for policies, products, announcement, navigation, footer, About, Contact, generic pages, collections (rename→308, archive→404, restore stays hidden by design). Drafts never appear in public HTML. | Media upload/R2 and FAQ/size-guide flows not re-run; translations only where the existing Languages flow supports them (not extended). Product publish needs real shipping weight/dimensions from the owner. |
| **C Legal/policy** | P0 fixed: migration-030 *old* placeholder policies/FAQ no longer override the coded Oct 6 pages (seed-defer in the public read path; publish/rollback of an unchanged seed refused 409). "Load October 6 draft" for Terms, Privacy, **Messaging Terms, Messaging Privacy** (draft only; never publishes). Messaging pages stay 404 unless `KVRN_SMS_POLICY_PUBLIC_ENABLED=true`. Old routes 308 to canonical (`/legal/*`, `/faq`, `/returns`…). Policy audit separates placeholders from live. Coded FAQ/Shipping&Returns/Terms commercial facts cross-checked (14-day store-credit returns, 1–3 day processing, 2–7 / 5–14+ day delivery, free shipping >$150) — consistent. | **Nothing is published; owner approval + legal review required.** No owner text exists for Cookies or Shipping & Returns, so no draft is offered (coded pages keep serving; the CMS placeholders cannot be published unchanged). Old seed FAQ says "return window is shown in your order confirmation" — stale; replace when FAQ is authored. Pasted policies are NOT claimed verbatim beyond `content/legal/*.txt` (SHA in `lib/owner-legal-generated.ts`). SMS consent machinery untouched. |
| **D SEO / GA4** | Canonicals, unique descriptions, product Twitter card, BreadcrumbList JSON-LD, `noindex` on checkout, robots/sitemap checks, GET-only crawler `scripts/seo-crawl.mjs` (refuses prod hosts), GA4 consent/dedupe tests, Clarity documented as disabled, Merchant feed optional apparel attributes (env, validated, off by default). Docs: `docs/seo/*`. | Per-variant Merchant feed / ProductGroup (needs owner decisions: gender, age group, category, GTIN/MPN) — deliberately not built to avoid invented stock. Default OG share image (owner asset). No Search Console / GA4 / Merchant account access was used; nothing claims indexing or ranking. |
| **E Performance** | Static images now served as build-time WebP renditions via a custom loader + `srcSet`; PDP cache-warm bug (downloaded originals) fixed. LAB (mobile emu, CPU 4x, 1.6 Mbps): PDP images 8.8 MB→0.6 MB, shop 5.6 MB→141 KB, load 44s→4.7s / 29s→2.3s. 53 renditions ≥38.8 dB PSNR. | LAB only — LCP/INP unchanged (text-LCP); re-measure on the live edge. Hero video (`preload="auto"`, no poster, unused 15 MB `.mov`) needs owner design sign-off. OpenNext/Cloudflare build not run. |
| **F Tests** | New suites listed in §4. | — |

## 3. Changed paths
`git diff --stat 07ac61f` inside the restored worktree is authoritative; `CHECKPOINT_MANIFEST.json` in the ZIP lists every tracked/untracked path.
About 130 files excluding 53 generated WebP renditions. Shared (non-Claude-owned) files and why: **`SHARED_FILES_CHANGED.md`** (read this before merging).
Files in ChatGPT's *forbidden* list that were touched: none. Closest edits: one-word `stack` props on admin tables (incl. `app/admin/sms/AdminSmsClient.tsx`, display only).

## 4. Tests (local Postgres :5433, `TEST_DATABASE_URL='postgresql://postgres@localhost:5433/reservationtest?host=/tmp'`)
See the "After workstreams A–E / final" section of `docs/CLAUDE_BASELINE_TEST_FAILURES.md` for the final counts. Every remaining failure also fails
at the CP08 baseline and is in ChatGPT-owned code. New/changed Claude suites: `content-owner-draft`, `responsive-images`, `admin-table-stack-labels`,
`admin-responsive-containment`, `admin-ui-primitives`, `google-merchant-feed`, `seo-jsonld-and-meta`, `shipping-unknown-copy`, `cms-preview-viewport`, GA4 suites.
Local-only e2e (refuse non-localhost): `qa/cms-e2e/*.mjs`; perf: `qa/perf/measure.mjs`; SEO crawl: `scripts/seo-crawl.mjs`.
Lint on all changed files: 0 errors. `tsc`: no errors in any Claude-changed file (remaining errors are the ChatGPT-owned blockers).

## 5. Owner decisions / actions still needed
1. Approve + legally review the October 6 Terms/Privacy/Messaging text, then publish from Admin → Content (a person must click Publish).
2. Provide final Cookies and Shipping & Returns text if you want them CMS-managed.
3. Real shipping weight/dimensions per product (publish gate `SHIPPING_REQUIRED`).
4. Merchant feed: gender/age group/category/GTIN decisions; optional env `KVRN_MERCHANT_GENDER|AGE_GROUP|GOOGLE_CATEGORY`.
5. Default share (OG) image asset; hero video poster/preload decision; delete unused `hero-video.mov`.
6. Manual QA on a real iPhone (Safari) for Admin Shipping, Inventory, Content editor; and on staging with real data.

## 6. Merge cautions
- Apply on CP08, never on bare 07ac61f, never alongside older checkpoints.
- Build blockers (§1.3) are mandatory.
- **Do not edit migration 030** (applied; byte-pinned). The seed-defer rule depends on `published_by = 'seed@kvrn.internal'`.
- `next.config.js` now uses a custom image loader (`images.loader:'custom'`). Verified with `next build/start`; **run the OpenNext/Cloudflare build and smoke-test images before deploy.** If a listed source image is replaced without regenerating renditions the site serves the OLD rendition (manifest check = `generate-image-renditions.mjs --check` and the unit test).
- PDP golden HTML fixtures were intentionally regenerated (only added `srcSet` attributes); two obsolete `content-off/legal-*.html` fixtures removed (those routes are now redirects).
- `AdminUI.tsx`/`InfoTip.tsx` are used by every admin page including ChatGPT's — class/markup-only changes.
- Feature flags (`KVRN_FLAG_*`) were never changed; dev used `KVRN_FLAG_CMS_PUBLIC_CONTENT=on` and `CMS_PRODUCT_ROUTING=on` locally only. Enabling them in production is a separate owner decision (flags default OFF).
- Rollback: everything is additive/flagged except the image loader and admin table stack mode; revert `next.config.js` + `AdminUI.tsx` to undo those.
