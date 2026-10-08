// lib/bundle-pricing.ts — the ONE implementation of bundle ("Complete the Set") price math.
//
// Pure, integer-only, client-safe (no database, no Node-only imports). The SQL twin lives in
// db/migrations/029_bundles.sql (bundle_discount_cents + the checks inside reserve_inventory_v2);
// the server computes the per-line allocation here and SQL re-validates the sum and the bounds,
// so a drift between the two fails closed instead of charging a different price.
//
// MODEL
//   * Component prices are the CANONICAL current product prices (cents). A bundle is a set of
//     components, one unit of each; a customer may buy `setQuantity` sets (every line moves together).
//   * Three approved rules (value is an integer: cents for the first two, basis points for the third):
//       set_price        the whole set costs `value`        discount = subtotal - value
//       fixed_discount   `value` off the set subtotal       discount = value
//       percent_discount `value` bps off the set subtotal   discount = floor(subtotal * value / 10000)
//     (rounded DOWN to the cent: the customer is never charged less than the rule states, and the
//      rounding is the same everywhere.)
//   * Bounds: discount >= 0; a set price above the subtotal is "not a discount" and is rejected;
//     the net price of the set must stay >= 1 cent (a free set is rejected, never silently clamped).
//   * ALLOCATION: the set discount is split across components in proportion to each component's
//     pre-discount (canonical) unit price using largest-remainder rounding. Ties on the remainder
//     are broken by the components' stable sort key (then position), so the split is the same on
//     every call and the per-unit allocations sum EXACTLY to the discount. The allocation is per
//     UNIT, so it stays consistent whatever quantity of the set is bought.

export type BundlePricingMode = 'set_price' | 'fixed_discount' | 'percent_discount'
export const BUNDLE_PRICING_MODES: readonly BundlePricingMode[] = ['set_price', 'fixed_discount', 'percent_discount']

export const MAX_BUNDLE_COMPONENTS = 6
export const MAX_SET_QUANTITY = 10
export const MAX_UNIT_PRICE_CENTS = 1_000_000
/** 100.00% — a percent rule must stay strictly below this (the net price must be >= 1 cent). */
export const BPS_FULL = 10_000

/**
 * Combinability rule (explicit, never accidental): a bundle price does NOT stack with a discount
 * code. Checkout rejects a code while a set is in the bag, with this message. The automatic
 * free-shipping benefit is NOT a discount code and keeps working on the net merchandise subtotal.
 */
export const BUNDLE_DISCOUNT_STACKING = { allowDiscountCode: false } as const
export const BUNDLE_CODE_NOT_COMBINABLE_MESSAGE =
  'Discount codes can’t be combined with a set price. Remove the code, or remove the set from your bag.'

export type BundlePricingErrorCode =
  | 'NO_COMPONENTS' | 'TOO_MANY_COMPONENTS' | 'INVALID_COMPONENT_PRICE' | 'INVALID_MODE' | 'INVALID_VALUE'
  | 'NOT_A_DISCOUNT' | 'DISCOUNT_TOO_LARGE' | 'NET_TOO_LOW' | 'INVALID_QUANTITY' | 'DUPLICATE_KEY'

export interface BundlePricingError { ok: false; code: BundlePricingErrorCode; message: string }

export interface PricingComponent {
  /** Stable identity of the component line (e.g. the SKU). Must be unique within the set. */
  key: string
  /** Canonical current unit price in cents. */
  unitPriceCents: number
  /** Deterministic tie-break for equal remainders. Defaults to `key`. */
  sortKey?: string
}

export interface PricedLine {
  key: string
  originalUnitPriceCents: number
  /** Share of ONE set's discount carried by one unit of this component. */
  allocatedDiscountPerUnitCents: number
  netUnitPriceCents: number
  quantity: number
  originalLineCents: number
  allocatedDiscountCents: number
  netLineCents: number
}

export interface BundlePricing {
  ok: true
  mode: BundlePricingMode
  value: number
  setQuantity: number
  /** One set. */
  setSubtotalCents: number
  setDiscountCents: number
  setNetCents: number
  /** All sets (setQuantity x one set). */
  subtotalCents: number
  discountCents: number
  netCents: number
  lines: PricedLine[]
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)
const fail = (code: BundlePricingErrorCode, message: string): BundlePricingError => ({ ok: false, code, message })

/** Exact integer floor division for non-negative safe integers (no float rounding). */
function divFloor(a: number, b: number): number { return (a - (a % b)) / b }

/** Customer/Admin wording for a pricing error (short, human). */
export function describePricingError(e: BundlePricingError): string { return e.message }

/**
 * The discount for ONE set at `subtotalCents` under the rule, or an error. Bounds are enforced
 * here so every caller (Admin preview, publish validation, storefront, checkout) agrees.
 */
export function computeSetDiscount(
  mode: unknown, value: unknown, subtotalCents: number,
): { ok: true; discountCents: number } | BundlePricingError {
  if (!isInt(subtotalCents) || subtotalCents < 1) return fail('INVALID_COMPONENT_PRICE', 'The set has no valid price.')
  if (!BUNDLE_PRICING_MODES.includes(mode as BundlePricingMode)) return fail('INVALID_MODE', 'Choose a pricing rule.')
  if (!isInt(value) || value < 0) return fail('INVALID_VALUE', 'Enter a whole, non-negative amount.')

  let discount: number
  if (mode === 'set_price') {
    if (value < 1) return fail('NET_TOO_LOW', 'The set price must be at least $0.01.')
    if (value > subtotalCents) return fail('NOT_A_DISCOUNT', 'The set price is higher than the products cost separately, so it is not a discount.')
    discount = subtotalCents - value
  } else if (mode === 'fixed_discount') {
    if (value >= subtotalCents) return fail('DISCOUNT_TOO_LARGE', 'The discount must be less than the products’ combined price.')
    discount = value
  } else {
    if (value >= BPS_FULL) return fail('DISCOUNT_TOO_LARGE', 'The percentage must be below 100%.')
    discount = divFloor(subtotalCents * value, BPS_FULL)
  }
  if (discount < 0 || discount > subtotalCents) return fail('INVALID_VALUE', 'The discount is not valid.')
  if (subtotalCents - discount < 1) return fail('NET_TOO_LOW', 'The set price must stay above $0.00.')
  return { ok: true, discountCents: discount }
}

/**
 * Split `discountCents` across the components in proportion to their pre-discount unit prices.
 * Largest-remainder rounding; equal remainders are ordered by sortKey, then input position.
 * Returns one per-unit allocation per component (same order as the input) that sums EXACTLY to
 * the discount and never exceeds a component's own price.
 */
export function allocateDiscount(components: ReadonlyArray<PricingComponent>, discountCents: number): number[] {
  const n = components.length
  if (n === 0) return []
  if (!isInt(discountCents) || discountCents < 0) throw new Error('discount must be a non-negative integer')
  const total = components.reduce((s, c) => s + c.unitPriceCents, 0)
  if (!isInt(total) || total < 1) throw new Error('component prices must sum to a positive integer')
  if (discountCents > total) throw new Error('discount exceeds the component total')

  const base: number[] = []
  const rem: number[] = []
  for (const c of components) {
    const num = discountCents * c.unitPriceCents
    base.push(divFloor(num, total))
    rem.push(num % total)
  }
  let left = discountCents - base.reduce((s, b) => s + b, 0)
  const order = components.map((c, i) => i).sort((a, b) => {
    if (rem[b] !== rem[a]) return rem[b] - rem[a]
    const ka = components[a].sortKey ?? components[a].key
    const kb = components[b].sortKey ?? components[b].key
    if (ka !== kb) return ka < kb ? -1 : 1
    return a - b
  })
  const out = base.slice()
  for (let i = 0; left > 0 && i < order.length; i++, left--) out[order[i]] += 1
  return out
}

/** Price a set: canonical component prices + rule -> per-line net prices that reconcile exactly. */
export function priceBundle(input: {
  mode: unknown
  value: unknown
  components: ReadonlyArray<PricingComponent>
  setQuantity?: number
}): BundlePricing | BundlePricingError {
  const comps = input.components
  if (!Array.isArray(comps) || comps.length === 0) return fail('NO_COMPONENTS', 'Add at least one product to the set.')
  if (comps.length > MAX_BUNDLE_COMPONENTS) return fail('TOO_MANY_COMPONENTS', `A set can have up to ${MAX_BUNDLE_COMPONENTS} products.`)
  const setQuantity = input.setQuantity ?? 1
  if (!isInt(setQuantity) || setQuantity < 1 || setQuantity > MAX_SET_QUANTITY) {
    return fail('INVALID_QUANTITY', `Choose a quantity from 1 to ${MAX_SET_QUANTITY}.`)
  }
  const seen = new Set<string>()
  for (const c of comps) {
    if (!isInt(c.unitPriceCents) || c.unitPriceCents < 1 || c.unitPriceCents > MAX_UNIT_PRICE_CENTS) {
      return fail('INVALID_COMPONENT_PRICE', 'A product in the set has no valid price.')
    }
    if (typeof c.key !== 'string' || !c.key || seen.has(c.key)) return fail('DUPLICATE_KEY', 'The same item can’t appear twice in a set.')
    seen.add(c.key)
  }
  const subtotal = comps.reduce((s, c) => s + c.unitPriceCents, 0)
  const d = computeSetDiscount(input.mode, input.value, subtotal)
  if (!d.ok) return d

  const alloc = allocateDiscount(comps, d.discountCents)
  const lines: PricedLine[] = comps.map((c, i) => ({
    key: c.key,
    originalUnitPriceCents: c.unitPriceCents,
    allocatedDiscountPerUnitCents: alloc[i],
    netUnitPriceCents: c.unitPriceCents - alloc[i],
    quantity: setQuantity,
    originalLineCents: c.unitPriceCents * setQuantity,
    allocatedDiscountCents: alloc[i] * setQuantity,
    netLineCents: (c.unitPriceCents - alloc[i]) * setQuantity,
  }))
  return {
    ok: true,
    mode: input.mode as BundlePricingMode,
    value: input.value as number,
    setQuantity,
    setSubtotalCents: subtotal,
    setDiscountCents: d.discountCents,
    setNetCents: subtotal - d.discountCents,
    subtotalCents: subtotal * setQuantity,
    discountCents: d.discountCents * setQuantity,
    netCents: (subtotal - d.discountCents) * setQuantity,
    lines,
  }
}

/**
 * Re-check a set of already-allocated line prices (what the server sent to the database, or what a
 * stored order holds) against the rule. Used by tests, reconciliation and the SQL-parity checks.
 * Returns the list of problems (empty = reconciles exactly).
 */
export function verifyAllocation(p: BundlePricing): string[] {
  const problems: string[] = []
  const sumAlloc = p.lines.reduce((s, l) => s + l.allocatedDiscountPerUnitCents, 0)
  if (sumAlloc !== p.setDiscountCents) problems.push('per-unit allocations do not sum to the set discount')
  const sumNet = p.lines.reduce((s, l) => s + l.netLineCents, 0)
  if (sumNet !== p.netCents) problems.push('net lines do not sum to the bundle net')
  for (const l of p.lines) {
    if (l.allocatedDiscountPerUnitCents < 0 || l.allocatedDiscountPerUnitCents > l.originalUnitPriceCents) problems.push(`allocation out of bounds for ${l.key}`)
    if (l.netLineCents !== l.originalLineCents - l.allocatedDiscountCents) problems.push(`line does not reconcile for ${l.key}`)
  }
  if (p.netCents < 1) problems.push('net below one cent')
  return problems
}

/** "$145.00" style label for cents (USD; the storefront formats display currency separately). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

/** Human description of a rule, for Admin and the storefront ("$15 off", "10% off", "Set price $145"). */
export function describeRule(mode: BundlePricingMode, value: number): string {
  if (mode === 'set_price') return `Set price ${formatCents(value)}`
  if (mode === 'fixed_discount') return `${formatCents(value)} off`
  const pct = value / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}% off`
}
