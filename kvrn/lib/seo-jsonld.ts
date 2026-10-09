// lib/seo-jsonld.ts — pure structured-data builders that carry NO price, stock or review claims.
// (Product/Offer data lives in lib/product-seo.ts and only ever uses canonical price/availability.)

export interface Crumb { name: string; path: string }

/**
 * schema.org BreadcrumbList. `path` values are site-relative ("/shop"); `origin` makes them absolute
 * (Google requires absolute URLs in `item`). Blank names and non-path values are dropped; with fewer than two
 * valid crumbs nothing is emitted (a one-item trail adds nothing).
 */
export function buildBreadcrumbJsonLd(crumbs: Crumb[], origin: string | null): Record<string, unknown> | null {
  const o = origin ? origin.replace(/\/+$/, '') : ''
  const clean = crumbs
    .map(c => ({ name: (c.name ?? '').replace(/\s+/g, ' ').trim(), path: c.path }))
    .filter(c => c.name && typeof c.path === 'string' && c.path.startsWith('/') && !c.path.startsWith('//'))
  if (clean.length < 2) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: clean.map((c, i) => ({
      '@type': 'ListItem', position: i + 1, name: c.name,
      // the final crumb is the current page; Google allows omitting `item` there, but including it is valid and clearer.
      item: `${o}${c.path}`,
    })),
  }
}
