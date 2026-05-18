# KVRN SEO Audit

## Implemented

### Technical SEO
- `sitemap.ts` — auto-generated, includes all 4 products + filtered collection URLs
- `robots.ts` — blocks /admin, /checkout, /api/, /order-confirmation
- Canonical URLs via metadataBase in layout.tsx
- Organization schema (JSON-LD) in layout `<head>`
- Product-level JSON-LD via generateMetadata (title, description, OG, Twitter card)
- Breadcrumb navigation on all inner pages (visual — add schema if needed)
- Next.js App Router: SSG for product pages, ISR-ready

### On-Page
- Unique title tags per page (template: `%s | KVRN`)
- Unique meta descriptions per page and product
- Semantic HTML: `<h1>` on every page, logical heading hierarchy
- Descriptive alt text on all images following the formula: [Brand] [Product] [Color] [Shot type]
- Internal linking: homepage → shop → products, products → related product, all pages → support pages

### Keyword Strategy (natural use)
- `heavyweight hoodie` — product name + descriptions
- `400 gsm hoodie` / `500 gsm hoodie` — specs, descriptions
- `oversized hoodie` — shortDescription fields
- `french terry hoodie` — Phantom collection
- `cropped hoodie` — Phantom fitNote
- `premium sweatpants` — implicit in product positioning
- `quiet luxury` — brand positioning copy

### URLs
- `/products/kvrn-heavyweight-hoodie` — product in slug
- `/products/kvrn-heavyweight-sweatpants`
- `/products/kvrn-phantom-hoodie`
- `/products/kvrn-phantom-sweatpants`
- `/shop?type=hoodies` — filterable collection
- `/shop?type=sweatpants`

### Redirects (next.config.js)
- `/faq` → `/support/faq`
- `/returns` → `/support/shipping-returns`
- `/track` → `/support/track`
- `/size-guide` → `/support/size-guide`

## Gaps to Address

### Schema (Priority: High)
Add Product schema to each PDP:
```json
{
  "@type": "Product",
  "name": "KVRN Heavyweight Hoodie",
  "offers": { "@type": "Offer", "price": "240", "priceCurrency": "USD", "availability": "InStock" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "47" }
}
```
Add to `app/products/[slug]/page.tsx` generateMetadata.

### Breadcrumb Schema (Priority: Medium)
Add BreadcrumbList schema alongside the visual breadcrumb on product + support pages.

### Blog/Journal (Priority: Medium)
Create `/journal` with SEO-targeted articles:
- "What is 400 GSM fleece and why it matters"
- "French terry vs brushed fleece"
- "How to style an oversized hoodie"
Target long-tail keywords with high purchase intent.

### Image SEO (Priority: High)
Once real product images are added:
- Confirm WebP format with JPEG fallback
- Confirm all `alt` attributes populated (current: descriptive templates in data/products.ts)
- Consider image sitemap for product photography

### Core Web Vitals Targets
- LCP < 2.0s — hero image preloaded (`priority={true}` + `fetchPriority="high"`)
- CLS < 0.05 — all images have explicit width/height via Next Image
- INP < 200ms — minimal client JS, deferred analytics

## Competitor Gap
Fear of God, Entire Studios, ALD: strong brand awareness, weak technical SEO.
KVRN opportunity: own the long-tail search ("400 gsm oversized hoodie", "quiet luxury hoodie", "french terry heavyweight") while competitors are invisible on Google.
