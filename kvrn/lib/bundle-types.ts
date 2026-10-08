// lib/bundle-types.ts — client-safe shapes shared by the storefront, the cart and the quote API.
// No database, no Node-only imports.
import type { BundlePricingMode } from './bundle-pricing'

export interface PublicBundleVariant {
  sku: string
  size: string
  sizeSort: number
  colorCode: string
  colorName: string
  /** Units that can be bought right now (stock minus reservations), never negative. */
  available: number
}

export interface PublicBundleColor { code: string; name: string; hex: string; image: { src: string; alt: string } | null }

export interface PublicBundleComponent {
  productId: string
  isOwner: boolean
  name: string
  slug: string
  href: string
  /** Canonical current unit price, cents. */
  priceCents: number
  viewSeparately: boolean
  image: { src: string; alt: string } | null
  /** Colours that have at least one eligible variant, in the product's own colour order. */
  colors: PublicBundleColor[]
  /** Eligible ACTIVE variants only (the Admin's allowed-variant constraint already applied). */
  variants: PublicBundleVariant[]
  /** At least one eligible variant can be bought right now. */
  available: boolean
}

export interface PublicBundle {
  bundleId: string
  ownerProductId: string
  revision: number
  mode: BundlePricingMode
  value: number
  includeOwner: boolean
  presentation: {
    eyebrow: string | null
    headline: string | null
    supportingCopy: string | null
    ctaLabel: string | null
    sectionVisible: boolean
  }
  /** Owner first when included, then the other products in the Admin's order. */
  components: PublicBundleComponent[]
}

/** What one set-line costs inside the set. Carried on cart lines. */
export interface CartBundleMeta {
  bundleId: string
  /** Display title of the set (never used for pricing). */
  title: string
  /** Number of lines in the set (a set is complete only when all are present). */
  lineCount: number
  /** Allocated NET unit price of this line inside the set, in cents. */
  netUnitCents: number
  /** One set: sum of the lines' net unit prices, in cents (what the bag believed the set costs). */
  setNetCents: number
  /** One set before the bundle discount, in cents. */
  setSubtotalCents: number
  /** products.id of this line's component. */
  componentProductId: string
}

export interface BundleSelection { productId: string; sku: string }

export interface BundleRequestBody {
  bundleId: string
  quantity: number
  selections: BundleSelection[]
  /** The set price the customer saw (cents, ONE set). A mismatch is reported, never silently charged. */
  expectedSetNetCents?: number | null
}

export type BundleQuoteLine = {
  productId: string
  sku: string
  variantId: string
  name: string
  size: string
  color: string
  originalUnitPriceCents: number
  allocatedDiscountPerUnitCents: number
  netUnitPriceCents: number
  quantity: number
}

export type BundleQuoteOk = {
  ok: true
  bundleId: string
  title: string | null
  quantity: number
  setSubtotalCents: number
  setDiscountCents: number
  setNetCents: number
  subtotalCents: number
  discountCents: number
  netCents: number
  lines: BundleQuoteLine[]
}

export type BundleErrorCode =
  | 'BUNDLE_DISABLED' | 'BUNDLE_INVALID_REQUEST' | 'BUNDLE_UNAVAILABLE' | 'BUNDLE_COMPONENT_UNAVAILABLE'
  | 'BUNDLE_SELECTION_INVALID' | 'BUNDLE_PRICE_CHANGED' | 'BUNDLE_SKU_CONFLICT' | 'BUNDLE_QUANTITY'
  | 'BUNDLE_DISCOUNT_NOT_COMBINABLE' | 'BUNDLE_PRICE_MISMATCH' | 'BUNDLE_ERROR'

export type BundleQuoteErr = {
  ok: false
  code: BundleErrorCode
  message: string
  status: number
  sku?: string
  /** For BUNDLE_PRICE_CHANGED: the current price of ONE set, cents. */
  newSetNetCents?: number
}
