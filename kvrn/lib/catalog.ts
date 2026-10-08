// lib/catalog.ts — single authoritative mapping between public URLs and Neon records
// This is the ONE place that translates public product slugs to internal identifiers.
// Do not duplicate this mapping anywhere else.

/** The two Drop 001 products keep their literal codes; Admin-created products use any code. */
export type LegacyProductCode = 'PKHH' | 'PKHSP'
export type ProductCode = LegacyProductCode | (string & {})

/**
 * Maps the deployed public URL slug → internal Neon product_code.
 * Public URL slugs must never change (SEO, bookmarks, existing links).
 * The Neon catalog uses a different slug format seeded in migrations.
 */
export const PUBLIC_SLUG_TO_PRODUCT_CODE: Record<string, LegacyProductCode> = {
  'kvrn-phantom-hoodie':      'PKHH',
  'kvrn-phantom-sweatpants':  'PKHSP',
  // Alias: also accept the catalog slug used in the Neon seed
  'project-kvrn-heavyweight-hoodie':      'PKHH',
  'project-kvrn-heavyweight-sweatpants':  'PKHSP',
}

/** SKU prefix for a given product code — matches the seeded Drop 001 variants */
export const PRODUCT_CODE_SKU_PREFIX: Record<LegacyProductCode, string> = {
  PKHH:  'KVRN-D001-PKHH-BLK',
  PKHSP: 'KVRN-D001-PKHSP-BLK',
}

/** Build the SKU for a given product and size */
export function buildSku(code: LegacyProductCode, size: string): string {
  return `${PRODUCT_CODE_SKU_PREFIX[code]}-${size.toUpperCase()}`
}

/**
 * SKU for an Admin-managed product: KVRN-<PRODUCTCODE>-<COLORCODE>-<SIZE>. This only SUGGESTS a
 * SKU for a NEW variant; stored SKUs are permanent and are always read from product_variants.
 * (The frozen reserve_inventory() requires the KVRN- prefix; lib/shippo.ts resolves parcel
 * data for these products from the KVRN-<PRODUCTCODE>- prefix.)
 */
export function buildProductSku(productCode: string, colorCode: string, size: string): string {
  const frag = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ['KVRN', frag(productCode), frag(colorCode), frag(size)].filter(Boolean).join('-')
}

/** Resolve a public slug to the Neon catalog slug (used in DB queries). */
export function toNeonSlug(publicSlug: string): string | null {
  const code = PUBLIC_SLUG_TO_PRODUCT_CODE[publicSlug]
  if (!code) return null
  return code === 'PKHH'
    ? 'project-kvrn-heavyweight-hoodie'
    : 'project-kvrn-heavyweight-sweatpants'
}
