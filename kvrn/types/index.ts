import type { CartBundleMeta } from '@/lib/bundle-types'

// ─── PRODUCT TYPES ───────────────────────────────────────────────────────────

// Product types and size labels are Admin data (Product Editor), not a closed list.
// The union members below are the coded catalog's values (kept for autocomplete); any
// lowercase-slug type / any size label is valid for Admin-created products.
export type ProductType = 'hoodie' | 'sweatpants' | 'set' | (string & {})

export type SizeLabel = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | (string & {})

/** Normalised focal point (0..1) for object-position. Mobile and desktop are independent. */
export interface FocalPoint { x: number; y: number }

export interface ColorOption {
  name: string           // Display name: "Stone"
  value: string          // Slug value: "stone"
  hex: string            // CSS color: "#C8B89A"
  pantone?: string       // "Pantone 7527 C"
  images: ProductImage[] // Images for this colorway (the shared five-image gallery)
  code?: string          // Variant colour code (product_variants.color_code) — Admin-managed products
  hero?: ProductImage    // Colour-specific hero (falls back to Product.heroImage / first image)
}

export interface SizeOption {
  label: SizeLabel
  value: string          // lowercase: "m"
  inStock: boolean
  stockCount?: number    // Hide from UI if sensitive, use for internal logic
}

export interface ProductImage {
  src: string            // Path: "/images/products/hoodie-stone-front.webp"
  alt: string            // Descriptive alt text
  type: ImageType
  focalMobile?: FocalPoint | null   // object-position on small screens (null = template default)
  focalDesktop?: FocalPoint | null  // object-position on large screens (null = template default)
  srcSet?: string                   // responsive renditions (Media Library assets)
}

export type ImageType =
  | 'front'
  | 'back'
  | 'hood-macro'
  | 'fabric-macro'
  | 'zipper-closed'
  | 'zipper-open'
  | 'lifestyle'
  | 'flat-lay'
  | 'detail'

export interface ProductFeature {
  title: string
  description: string
  icon?: string
}

export interface ProductSpec {
  label: string
  value: string
}

export interface Product {
  id: string
  name: string
  slug: string
  type: ProductType
  price: number          // In pence: 23000 = £230.00
  shortDescription:    string
  constructionDetails?: string[]
  description: string
  colors: ColorOption[]
  sizes: SizeOption[]
  features: ProductFeature[]
  specs: ProductSpec[]
  fitNote: string
  founderNote?: string  // Shown near price
  hidden?:     boolean    // When true: routes exist, not shown in listings  // Shown near price on PDP and cards
  relatedProductSlug?: string
  // ── Admin-managed (CMS) fields. All optional: absent on the coded catalog. ─────────────
  eyebrow?: string               // line above the title; coded catalog falls back to a legacy rule
  heroImage?: ProductImage       // independent of the five gallery images
  productCode?: string           // stable product code (products.product_code)
  sections?: {                   // present only for CMS products (enables CMS-only behaviour)
    description: boolean; details: boolean; shippingReturns: boolean; sizeGuideLink: boolean; stickyAddToBag: boolean
  }
  shippingReturns?: { lines: string[]; linkLabel: string; href: string }
  sizeGuide?: { title: string; body: string } | null
  seo: {
    title: string
    description: string
  }
}

// ─── CART TYPES ──────────────────────────────────────────────────────────────

export interface CartItem {
  cartItemId: string     // Unique per cart line: `${productId}-${color}-${size}`
  productId: string
  productName: string
  slug: string
  color: string          // Color value slug: "stone"
  colorName: string      // Display name: "Stone"
  colorHex: string       // Hex: "#C8B89A"
  size: SizeLabel
  sku?: string           // Permanent Drop 001 SKU e.g. KVRN-D001-PKHH-BLK-M
  price: number          // In pence
  quantity: number
  availableQuantity?: number  // Capped available stock (for cart + UI)
  image: string          // Front image src for cart display
  /**
   * Present only on a line that belongs to a bundle ("Complete the Set"). `price` stays the canonical
   * unit price; the line is CHARGED at `bundle.netUnitCents`. Absent on every ordinary line, and on
   * every cart saved before bundles existed (so old saved carts keep working unchanged).
   */
  bundle?: CartBundleMeta
}

export interface CartState {
  items: CartItem[]
  isOpen: boolean
}

// ─── FORM TYPES ──────────────────────────────────────────────────────────────

export interface WaitlistFormData {
  email: string
  phone?: string
  smsConsent: boolean
}

export interface ContactFormData {
  firstName: string
  lastName: string
  email: string
  orderNumber?: string
  subject: string
  message: string
}

// ─── ORDER TYPES ─────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'unfulfilled'
  | 'fulfilled'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'return_pending'
  | 'returned'
  | 'refunded'

export interface ShippingAddress {
  firstName: string
  lastName: string
  address1: string
  address2?: string
  city: string
  postcode: string
  country: string
  countryCode: string
}

export interface Order {
  id: string
  stripePaymentIntentId: string
  customerEmail: string
  customerName: string
  shippingAddress: ShippingAddress
  lineItems: OrderLineItem[]
  shippingMethod: 'standard' | 'express'
  shippingCostPence: number
  subtotalPence: number
  taxPence: number
  totalPence: number
  status: OrderStatus
  trackingNumber?: string
  carrier?: string
  createdAt: string
  fulfilledAt?: string
  shippedAt?: string
  deliveredAt?: string
}

export interface OrderLineItem {
  productId: string
  productName: string
  sku: string
  color: string
  size: string
  unitPricePence: number
  quantity: number
}

// ─── API RESPONSE TYPES ──────────────────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  success: true
  data: T
}

export interface ApiError {
  success: false
  error: string
  code?: string
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError

// ─── NAVIGATION TYPES ────────────────────────────────────────────────────────

export interface NavLink {
  label: string
  href: string
  children?: NavLink[]
}
