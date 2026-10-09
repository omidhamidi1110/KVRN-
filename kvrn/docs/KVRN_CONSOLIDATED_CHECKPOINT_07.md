# KVRN cumulative development checkpoint 07 — legacy product SEO parity

## Scope and production guard
- Complete cumulative local development archive; earlier checkpoints are included, not stacked. Original production baseline remains owner-confirmed Git `07ac61f`.
- No code deployed; no migrations run; no payment, marketing, inventory or financial changes. Live systems have not been accessed.

## New since Checkpoint 06
- Coded/flag-OFF PDP `app/products/[slug]/page.tsx` now sets its canonical URL (`/products/<slug>`), OG page URL and noindex for intentionally hidden legacy products. Hidden legacy product URLs remain usable for existing customer links.
- The visible coded PDP also emits sanitized Product JSON-LD with name, description, brand, image, and absolute URL, **without any Offer/price/availability**, since the coded static inventory/price booleans are not authoritative checkout values. Published CMS PDP JSON-LD continues to include canonical price/known availability as before (no regression in default behavior).
- New `emitOffer?: boolean` parameter on `lib/product-seo.ts` defaults to existing CMS behavior. Coded fallback opts out of offers. Script-injection escaping remains unchanged.
- New 7-test offline suite `scripts/test-coded-product-seo.mjs`, included in `qa:marketing-offline` and developer guards.

## Remaining SEO work
Google Search Console ownership and indexing, Merchant Center registration and variant feeds, Core Web Vitals and staging URL crawls, hreflang/currency consistency, policy/FAQ search presentation, and actual on-device tests remain for later integration. No Google provider API calls were made.
