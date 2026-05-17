// ─── PRODUCT TYPES ───────────────────────────────────────────────────────────

export type ProductType = 'hoodie' | 'sweatpants' | 'set'

export type SizeLabel = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL'

export interface ColorOption {
  name: string           // Display name: "Stone"
  value: string          // Slug value: "stone"
  hex: string            // CSS color: "#C8B89A"
  pantone?: string       // "Pantone 7527 C"
  images: ProductImage[] // Images for this colorway
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
  shortDescription: string
  description: string
  colors: ColorOption[]
  sizes: SizeOption[]
  features: ProductFeature[]
  specs: ProductSpec[]
  fitNote: string
  relatedProductSlug?: string
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
  price: number          // In pence
  quantity: number
  image: string          // Front image src for cart display
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
