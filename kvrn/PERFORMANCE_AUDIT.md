# KVRN Performance Audit

## Architecture Decisions

### Rendering Strategy
| Route                      | Method  | Rationale                               |
|----------------------------|---------|-----------------------------------------|
| `/`                        | Static  | No dynamic data; rebuild on new drop    |
| `/shop`                    | Dynamic | `?type=` query param requires SSR       |
| `/products/[slug]`         | SSG     | generateStaticParams pre-builds all 4   |
| `/support/*`               | Static  | Fully static content                    |
| `/api/*`                   | Dynamic | Server-side only                        |

### Image Strategy
- `next/image` with `fill` + explicit `sizes` on all product images
- `priority={true}` + `fetchPriority="high"` on hero and first product card
- WebP format preference (`formats: ['image/avif', 'image/webp']` in next.config.js)
- Lazy loading on all below-fold images (Next.js default)
- Aspect ratios declared on containers → zero CLS from images

### JavaScript Strategy
- Analytics (GA4, Clarity) loaded `afterInteractive` — never blocks LCP
- Clarity additionally delayed 3 seconds post-load
- GA4 Consent Mode: denies by default until user accepts — reduces unnecessary script execution
- No heavy animation libraries (Framer Motion, GSAP) — all animations via CSS transitions
- Minimal client components — most pages are server components
- Cart state via localStorage (no network request on page load)
- Currency state via localStorage (no network request, instant hydration)

### Font Strategy
- System font stack: no external font loading, no render blocking
- When upgrading to custom typeface: self-host via `@font-face`, preload critical weight, use `font-display: swap`

## Estimated Lighthouse Scores (before real images)

| Metric                  | Estimated | Target  |
|-------------------------|-----------|---------|
| Performance (Mobile)    | 88–95     | 90+     |
| Performance (Desktop)   | 95–99     | 95+     |
| Accessibility           | 92–98     | 95+     |
| Best Practices          | 95–100    | 95+     |
| SEO                     | 90–95     | 90+     |

*Scores will be validated post-image addition. Hero image size is the primary variable.*

## Core Web Vitals

### LCP (Largest Contentful Paint)
- Hero image preloaded with `priority` + `fetchPriority="high"`
- Target: < 2.0s
- Risk: if hero image is > 250KB, LCP degrades on 3G. Ensure hero WebP < 200KB.

### CLS (Cumulative Layout Shift)
- All `next/image` components have explicit dimensions or `fill` with sized containers
- Announcement bar: `h-[36px]` fixed — no layout shift when it appears
- Nav: `h-[56px]` fixed — no shift
- Target: < 0.05

### INP (Interaction to Next Paint)
- Add-to-cart: 350ms simulated delay (remove/reduce when Stripe is wired)
- Color switch: instant (state update → image crossfade via CSS)
- Cart open/close: CSS transform (no layout recalculation)
- Target: < 200ms

## Recommendations

### High Priority
1. **Image optimization**: once real product images are added, compress to target sizes
   - Hero: < 200KB WebP at 1920px
   - Product cards: < 100KB WebP at 1500px
   - Macro shots: < 80KB WebP at 1200px
2. **Font subsetting**: when upgrading to custom typeface, subset to Latin + used characters only (saves 60–80% font weight)

### Medium Priority
3. **ISR for products**: consider `revalidate: 60` once Neon DB is connected (updates stock without full rebuild)
4. **Cloudflare Images**: at scale ($5/month), automates WebP/AVIF conversion for any image format uploaded

### Low Priority
5. **Service worker**: cache fonts and shell for offline resilience
6. **Bundle analysis**: run `ANALYZE=true npm run build` after adding Stripe to monitor bundle size impact
