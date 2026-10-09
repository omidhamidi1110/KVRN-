// lib/ga-common.ts — pure, dependency-free GA4 helpers shared by the browser module
// (lib/ga-client.ts) and the server module (lib/ga4-server.ts). No I/O, no globals.
//
// MONEY: KVRN money is integer cents everywhere. Conversion to GA4's currency-unit number happens
// ONLY here, in gaMoney(), at the GA boundary. An unknown/invalid amount becomes null — never 0.
//
// PII: GA payloads are built only from the allowlisted fields below (catalog identifiers, safe
// product names, quantities, amounts, the KVRN order number). Nothing here accepts a name, email,
// phone, address, payment detail or free text from a customer.

export const GA_CURRENCY = 'USD'

/** GA4 web measurement ids look like G-ABC123XYZ. Anything else is treated as "not configured". */
export const GA_MEASUREMENT_ID_RE = /^G-[A-Z0-9]{6,12}$/
/** gtag('get', id, 'client_id') returns "<digits>.<digits>". */
export const GA_CLIENT_ID_RE = /^\d{1,12}\.\d{1,12}$/
/** gtag('get', id, 'session_id') returns a unix-time-like number. */
export const GA_SESSION_ID_RE = /^\d{1,12}$/
/** Same character class the first-party tracker accepts for UTM values ('@' deliberately excluded). */
export const GA_UTM_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-+:/%]{0,99}$/
/** The only attribution parameters KVRN forwards to GA in page_location (matches the first-party scope). */
export const GA_UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign'] as const

export function normalizeMeasurementId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return GA_MEASUREMENT_ID_RE.test(t) ? t : null
}

/**
 * The ONLY thing KVRN ever tells a browser about GA server configuration: the validated, PUBLIC
 * measurement id (G-XXXX). It reads exactly one variable and returns only that variable's validated
 * value (or null), so it cannot return or leak the Measurement Protocol secret or any other
 * environment value (a test proves this with a secret present).
 * It is called at REQUEST time with the runtime environment (never inlined at build time): see
 * app/api/analytics/config/route.ts and GA4-INTEGRATION.md.
 */
export function readPublicGaMeasurementId(env: { [name: string]: string | undefined }): string | null {
  return normalizeMeasurementId(env.NEXT_PUBLIC_GA_MEASUREMENT_ID)
}

/** Integer cents -> GA currency units (2 dp). null for anything that is not a non-negative safe integer. */
export function gaMoney(cents: unknown): number | null {
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < 0) return null
  return Number((cents / 100).toFixed(2))
}

export function gaClientId(v: unknown): string | null {
  return typeof v === 'string' && GA_CLIENT_ID_RE.test(v) ? v : null
}
export function gaSessionId(v: unknown): string | null {
  return typeof v === 'string' && GA_SESSION_ID_RE.test(v) ? v : null
}

/** Strip control characters and cap length. Product names only; never customer text. */
export function safeLabel(v: unknown, max = 100): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
  return t.length ? t : null
}

export interface GaItem {
  item_id: string
  item_name: string
  item_variant?: string
  item_brand: 'KVRN'
  price?: number
  quantity: number
}

export interface GaItemInput {
  slug: string | null | undefined      // product slug: the product-level GA item_id (same on every event)
  name: string | null | undefined
  sku?: string | null                  // variant identifier -> item_variant
  priceCents: number | null | undefined
  quantity: number
}

/**
 * item_id is the PRODUCT slug on every event (view_item has no variant), so GA item reports join
 * across view_item / add_to_cart / begin_checkout / purchase. The variant SKU rides in item_variant.
 */
export function buildGaItem(i: GaItemInput): GaItem | null {
  const id = safeLabel(i.slug, 100) ?? safeLabel(i.sku, 100)
  const name = safeLabel(i.name, 100)
  if (!id || !name) return null
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) return null
  const price = gaMoney(i.priceCents)
  const variant = safeLabel(i.sku, 100)
  return {
    item_id: id,
    item_name: name,
    ...(variant ? { item_variant: variant } : {}),
    item_brand: 'KVRN',
    ...(price !== null ? { price } : {}),
    quantity: i.quantity,
  }
}

/**
 * Deterministically spread an order-level MERCHANDISE discount across its lines, in integer cents.
 * Proportional to each line's pre-discount amount, largest-remainder rounding (ties: earlier line
 * first), so the net lines always sum to exactly (sum of gross lines - discount). Pure; never
 * mutates anything. Returns null — never a guess — for any inconsistent input (negative or
 * fractional amounts, a discount larger than the merchandise, an unsafe intermediate).
 */
export function allocateDiscountAcrossLines(grossLineCents: number[], discountCents: number): number[] | null {
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!ok(discountCents) || !grossLineCents.length || !grossLineCents.every(ok)) return null
  const total = grossLineCents.reduce((a, b) => a + b, 0)
  if (!Number.isSafeInteger(total) || discountCents > total) return null
  if (discountCents === 0) return grossLineCents.slice()
  if (total === 0) return null

  const shares: number[] = []
  const rems: number[] = []
  for (const line of grossLineCents) {
    const num = discountCents * line
    if (!Number.isSafeInteger(num)) return null
    shares.push(Math.floor(num / total))
    rems.push(num % total)
  }
  let left = discountCents - shares.reduce((a, b) => a + b, 0)
  const order = grossLineCents.map((_, i) => i).sort((a, b) => (rems[b] - rems[a]) || (a - b))
  for (const i of order) {
    if (left <= 0) break
    shares[i] += 1
    left -= 1
  }
  if (left !== 0) return null
  const net = grossLineCents.map((g, i) => g - shares[i])
  return net.every(ok) ? net : null
}

/**
 * GA unit price (currency units) for a line whose NET amount is `netLineCents`. Exact 2-dp money when
 * the line divides evenly; otherwise the fractional per-unit value, rounded to 6 dp, exists only in
 * the final GA payload (KVRN's own accounting stays in integer cents).
 */
export function gaNetUnitPrice(netLineCents: number, quantity: number): number | null {
  if (!Number.isSafeInteger(netLineCents) || netLineCents < 0) return null
  if (!Number.isInteger(quantity) || quantity < 1) return null
  if (netLineCents % quantity === 0) return gaMoney(netLineCents / quantity)
  return Number((netLineCents / quantity / 100).toFixed(6))
}

/** Sum of price x quantity in cents, or null if any line has no valid price (unknown stays unknown). */
export function sumLineCents(lines: Array<{ priceCents: number | null | undefined; quantity: number }>): number | null {
  let total = 0
  for (const l of lines) {
    if (typeof l.priceCents !== 'number' || !Number.isSafeInteger(l.priceCents) || l.priceCents < 0) return null
    total += l.priceCents * l.quantity
    if (!Number.isSafeInteger(total)) return null
  }
  return total
}

const INTERNAL_PATH_RE = /^\/(admin|api|_next)(\/|$)|^\/store-credit\/verify\/?$/i
/** Admin and internal API/asset routes are never storefront traffic. */
export function isGaInternalPath(pathname: string): boolean {
  return INTERNAL_PATH_RE.test(pathname)
}

/** What the admin page shows about GA configuration. Contains NO secret — only booleans/states and the public measurement id. */
export interface GaAdminStatus {
  /** Valid public measurement id (G-XXXX) or null. It is public: it appears in the page source once a visitor consents. */
  measurementId: string | null
  /** 'unset' | 'malformed' | 'ok' for NEXT_PUBLIC_GA_MEASUREMENT_ID */
  clientState: 'unset' | 'malformed' | 'ok'
  /** 'unset' | 'malformed' | 'ok' for GA4_MEASUREMENT_PROTOCOL_SECRET (the value is never exposed) */
  secretState: 'unset' | 'malformed' | 'ok'
}
