# KVRN storefront performance — baseline and first optimisation (Workstream E, 2026-10-08)

**Status: code-complete, LAB-measured only. Not production-validated.** Nothing here is field Core Web Vitals,
a Lighthouse score, or evidence of ranking/indexing change. Re-measure after deploy against the live Cloudflare
edge (real CDN caching, HTTP/2+, real fonts/third-party scripts).

## How it was measured (reproducible)
`qa/perf/measure.mjs` — Playwright Chromium, iPhone-like 390x844 @2x, CPU 4x slowdown, 1.6 Mbps / 150 ms RTT,
3 runs per page, median reported. Run against a **production build** (`next build && next start`), never `next dev`.
```
KVRN_PERF_BASE=http://localhost:3112 node qa/perf/measure.mjs --runs 3 --json qa/perf/results/<name>.json
```
Refuses non-local hosts unless `KVRN_PERF_ALLOW_REMOTE=1`; GET-only, no cookies. Raw results:
`qa/perf/results/baseline-2026-10-08.json`, `after-renditions-2026-10-08.json`, `after-pdp-fix-2026-10-08.json`.
(The local server has no CDN/compression parity, so absolute load times overstate; the *relative* change is the signal.)

## Result (median of 3, mobile LAB)
| Page | Image KB before → after | Load ms before → after | LCP ms | CLS | TBT ms |
|---|---|---|---|---|---|
| `/` | 284 → 145 | 3512 → 2895 | 712 → 688 | 0 → 0 | 169 → 131 |
| `/shop` | 5599 → 141 | 28942 → 2329 | 732 → 728 | 0.002 → 0 | 118 → 146 |
| `/products/kvrn-phantom-hoodie` | 8761 → 621 | 44515 → 4721 | 804 → 796 | 0.002 → 0 | 178 → 192 |
| `/support/faq`, `/privacy` | 0 → 0 | unchanged | ~620-640 | 0 | ~125-150 |

Honest reading: the win is **bytes and total load**, not LCP — in this lab the LCP element is text (H1/P) so it was
already ~0.7 s. TBT/JS (~220 KB) did not change (noise ±30 ms); no bundle work was done beyond measurement.
CLS was already ≈0 on the measured pages; no layout change was needed.

## What changed
1. **Root cause:** `images.unoptimized: true` served each static image at its original size (a half-width product card
   on a phone downloaded a 1.3–5 MB file).
2. `scripts/generate-image-renditions.mjs` builds WebP renditions (640/1080/1600, plus the native width when the
   original is ≤1600) into committed `public/images-r/<w>/…` (53 files, ~4.3 MB total) and a manifest
   `lib/image-renditions.generated.json` (sha256 + width + quality per source). Only images ≥120 KB are processed.
   `--check` mode (and the unit test) fail when the manifest is stale; the loader itself does not verify hashes at runtime, so regenerate whenever a listed source image is replaced. Quality 85; PSNR vs originals 38.8–44.9 dB (visually near-lossless).
3. `lib/responsive-image.ts` + `lib/image-loader.ts` (next/image custom loader) point listed static images at a
   rendition; anything else (R2 `/media/…`, remote URLs, small files) is returned unchanged. `next.config.js`:
   `images.loader: 'custom'`, `Cache-Control: public, max-age=604800, stale-while-revalidate=86400` for `/images-r/*` (7 days; the files are not content-hashed, so they are deliberately not `immutable`).
4. Raw `<img>` sites (PDP gallery/thumbnails/related, Complete-the-Set) get `srcSet` + `sizes`.
5. **PDP bug found by request logging:** `MobileGallery` "warmed the cache" with `new Image().src = original`
   for every gallery image, downloading ~8.8 MB of originals. It now sets the same `srcset`/`sizes` as the visible slides.
6. No design, copy or animation changed.

## Tests
`lib/__tests__/responsive-images.test.ts` (29): rendition selection, srcset, manifest freshness vs files on disk,
loader passthrough for non-listed images.

## Known leftovers (not done — need owner decision or are outside this pass)
- **Homepage hero video** (`components/homepage/HomepageClient.tsx`): `preload="auto"`, no `poster`; the
  `<video>` is not in the image-KB figures above. `public/images/campaign/hero-video.mov` (15.5 MB) is unreferenced
  and ships in `/public` (mp4 4.8 MB, webm 2.5 MB are used). Recommend: `preload="metadata"` + a poster from the
  existing hero still, and delete the `.mov` — touches the premium homepage, so owner design sign-off first.
- `CollectionHero` preloads both the desktop and mobile `priority` hero images; one is wasted per viewport. After the rendition work these are 7–58 KB each, so it was left alone rather than risk LCP (fix would need viewport-aware priority).
- PDP still downloads a 640w *and* a 1080w candidate for gallery images 1–2 on phones (~100 KB extra, 648 KB total). A `loading="lazy"` attempt on the
  hidden desktop preload image had no effect (verified with a request log) and was reverted; the extra candidates most likely come from the
  `priority` `<link rel=preload>` tags next/image emits for the desktop hero, which cannot be viewport-scoped. Not chased further.
- Some pages have two `<h1>` elements (a11y/SEO nit).
- Fonts: no font files were requested in the lab run; I did not investigate why — verify on the live site.
- Admin pages were not profiled (public storefront only).
