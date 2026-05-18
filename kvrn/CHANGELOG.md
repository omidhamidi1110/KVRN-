# KVRN Changelog — V5

## Files Changed

### New Files
- `lib/currency.ts` — Currency conversion utilities, exchange rates, free shipping threshold
- `context/CurrencyContext.tsx` — Global currency state with localStorage persistence
- `context/HeaderContext.tsx` — Announcement bar visibility shared between Nav and Bar
- `components/ui/AnnouncementBar.tsx` — Fixed rotating message bar with fade transitions
- `components/ui/StockBadge.tsx` — "Sold out" / "Few left" badge (stock < 3)
- `components/ui/ScrollCue.tsx` — Homepage scroll-down cue + back-to-top button
- `components/ui/CurrencySelector.tsx` — Currency dropdown (10 currencies)
- `components/cart/ShippingProgress.tsx` — Free shipping progress bar in cart

### Rewritten Files
- `data/products.ts` — 4 products total: Heavyweight Hoodie, Heavyweight Sweatpants, Phantom Hoodie, Phantom Sweatpants. Prices in USD cents. Correct specs. 5 colorways for Heavyweight, Black only for Phantom
- `components/layout/Nav.tsx` — Desktop links added (Shop, Hoodies, Sweatpants, About, Waitlist). SVG bag icon. Currency selector. SVG social icons (@thekvrn). Mobile drawer updated
- `components/layout/Footer.tsx` — Compressed to 5-column desktop grid. SVG Instagram + TikTok icons linking @thekvrn
- `components/product/ProductCard.tsx` — Interactive color swatches (always visible), stock badge, wishlist icon, currency-aware pricing
- `components/cart/CartDrawer.tsx` — Shipping progress bar, currency-aware pricing
- `app/layout.tsx` — Wrapped with HeaderProvider, CurrencyProvider. AnnouncementBar added
- `app/page.tsx` — 4-product layout: Heavyweight section + Phantom section. Trust block. ScrollCue
- `app/shop/page.tsx` — Type filter (hoodies/sweatpants). 3-column grid. SEO copy
- `app/products/[slug]/PDPClient.tsx` — Currency-aware pricing, StockBadge, trust signals, sticky ATC
- `app/support/shipping-returns/page.tsx` — Full rewrite: store credit returns, no UK-specific law, no fixed pricing, general estimated timelines
- `app/sitemap.ts` — All 4 product slugs + filtered collection URLs

### Preserved (unchanged)
- `next.config.js` — Cloudflare-compatible settings preserved
- `wrangler.toml` — No changes
- `open-next.config.ts` — No changes
- `.github/workflows/deploy.yml` — No changes
- `middleware.ts` — No changes
- `app/api/orders/[id]/route.ts` — Next 15 async params preserved
- `app/products/[slug]/page.tsx` — Next 15 async params preserved
- All other API routes — unchanged

## Deployment Compatibility
- Next.js: 15.3.2 ✓
- React: 18.3.1 ✓
- React DOM: 18.3.1 ✓
- Dynamic route params: Promise<{ slug }> / Promise<{ id }> ✓
- Cloudflare/OpenNext config: unchanged ✓
- Zero brace-expansion folders ✓
