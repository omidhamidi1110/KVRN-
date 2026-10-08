// lib/bundle-cart.ts — pure cart helpers for bundle ("Complete the Set") lines.
//
// A set is stored in the bag as its REAL component lines (real SKUs), each tagged with `bundle`
// metadata, so nothing downstream (inventory caps, analytics, shipping) needs a special case.
// Cart shape change is additive: `CartItem.bundle` is optional, so carts saved before bundles
// existed load unchanged and ordinary lines are never touched.
//
// The bag's prices are a DISPLAY of what the server will charge. The server re-prices the set at
// checkout from the published rule and reports a changed price instead of charging a different one.
import type { CartItem } from '@/types'
import { MAX_SET_QUANTITY, priceBundle } from './bundle-pricing'
import type { BundleQuoteOk, BundleRequestBody, PublicBundle } from './bundle-types'

export const BUNDLE_LINE_PREFIX = 'bundle:'
export const bundleCartItemId = (bundleId: string, productId: string) => `${BUNDLE_LINE_PREFIX}${bundleId}:${productId}`

export const isBundleLine = (i: CartItem): boolean => !!i.bundle

/** What one unit of this line is charged: the allocated net price inside a set, else its own price. */
export const effectiveUnitCents = (i: CartItem): number => (i.bundle ? i.bundle.netUnitCents : i.price)

export const cartSubtotalCents = (items: ReadonlyArray<CartItem>): number =>
  items.reduce((s, i) => s + effectiveUnitCents(i) * i.quantity, 0)

export interface BundleGroup {
  bundleId: string
  title: string
  lines: CartItem[]
  /** All lines of the set are present and agree on quantity. */
  complete: boolean
  quantity: number
  /** Sum of the lines' net totals (what the bag believes the set(s) cost). */
  netCents: number
  /** Sum of the lines' canonical totals. */
  subtotalCents: number
}

export function bundleGroups(items: ReadonlyArray<CartItem>): BundleGroup[] {
  const map = new Map<string, CartItem[]>()
  for (const i of items) {
    if (!i.bundle) continue
    const list = map.get(i.bundle.bundleId) ?? []
    list.push(i)
    map.set(i.bundle.bundleId, list)
  }
  return [...map.entries()].map(([bundleId, lines]) => {
    const quantity = Math.min(...lines.map(l => l.quantity))
    const expected = lines[0].bundle!.lineCount
    const complete = lines.length === expected && lines.every(l => l.quantity === quantity && l.bundle!.lineCount === expected)
    return {
      bundleId, title: lines[0].bundle!.title, lines, complete, quantity,
      netCents: lines.reduce((s, l) => s + l.bundle!.netUnitCents * l.quantity, 0),
      subtotalCents: lines.reduce((s, l) => s + l.price * l.quantity, 0),
    }
  })
}

/** Remove any set that is not whole (a line was sold out / removed), so a partial set never reaches checkout. */
export function dropIncompleteBundles(items: CartItem[]): CartItem[] {
  if (!items.some(isBundleLine)) return items
  const bad = new Set(bundleGroups(items).filter(g => !g.complete).map(g => g.bundleId))
  if (bad.size === 0) return items
  return items.filter(i => !i.bundle || !bad.has(i.bundle.bundleId))
}

/** Highest quantity of a set the bag may hold: the smallest per-line cap, within the set limit. */
export function maxSetQuantity(lines: ReadonlyArray<CartItem>): number {
  const caps = lines.map(l => l.availableQuantity ?? Infinity)
  return Math.max(0, Math.min(MAX_SET_QUANTITY, ...caps))
}

export type CheckoutSplit =
  | { ok: true; plain: Array<{ sku: string; quantity: number }>; bundle: BundleRequestBody | null }
  | { ok: false; message: string }

/**
 * Split the bag into the ordinary items and the (single) set for /api/checkout/session. A bag with
 * two different sets, a partial set, or the same SKU inside and outside the set is refused here
 * with a clear message (the server enforces the same rules).
 */
export function splitCartForCheckout(items: ReadonlyArray<CartItem>): CheckoutSplit {
  const groups = bundleGroups(items)
  if (groups.length > 1) return { ok: false, message: 'Only one set can be bought per order. Remove one of the sets from your bag.' }
  const plainLines = items.filter(i => !i.bundle)
  const plain = plainLines.map(i => ({ sku: i.sku as string, quantity: i.quantity }))
  if (groups.length === 0) return { ok: true, plain, bundle: null }
  const g = groups[0]
  if (!g.complete) return { ok: false, message: 'A product in your set is no longer available. Please remove the set and add it again.' }
  const inSet = new Set(g.lines.map(l => l.sku))
  if (plainLines.some(i => i.sku && inSet.has(i.sku))) {
    return { ok: false, message: 'One of the items in your set is also in your bag on its own. Choose a different size for the separate item, or remove it.' }
  }
  return {
    ok: true, plain,
    bundle: {
      bundleId: g.bundleId, quantity: g.quantity,
      selections: g.lines.map(l => ({ productId: l.bundle!.componentProductId, sku: l.sku as string })),
      expectedSetNetCents: g.lines.reduce((s, l) => s + l.bundle!.netUnitCents, 0),
    },
  }
}

/** Price a PDP selection with the shared pricing module (display only; the server re-prices). */
export function priceSelection(pb: PublicBundle, chosen: ReadonlyArray<string | null>, quantity = 1) {
  return priceBundle({
    mode: pb.mode, value: pb.value, setQuantity: quantity,
    components: pb.components.map((c, i) => ({ key: chosen[i] ?? c.productId, unitPriceCents: c.priceCents, sortKey: String(i).padStart(3, '0') })),
  })
}

/**
 * Build the bag lines for a set from the customer's per-component SKU choices. Returns null when a
 * choice is missing/unavailable or the rule does not price (fail closed).
 */
export function buildBundleCartLines(
  pb: PublicBundle, chosenSkus: ReadonlyArray<string | null>, title: string, quantity = 1, quote?: BundleQuoteOk,
): CartItem[] | null {
  if (chosenSkus.length !== pb.components.length) return null
  const priced = priceSelection(pb, chosenSkus, quantity)
  if (!priced.ok) return null
  const lines: CartItem[] = []
  for (let i = 0; i < pb.components.length; i++) {
    const c = pb.components[i]
    const v = c.variants.find(x => x.sku === chosenSkus[i])
    if (!v || v.available < quantity) return null
    const color = c.colors.find(x => x.code === v.colorCode)
    const p = priced.lines[i]
    lines.push({
      cartItemId: bundleCartItemId(pb.bundleId, c.productId),
      productId: c.productId, productName: c.name, slug: c.slug,
      color: (v.colorCode || 'default').toLowerCase(), colorName: color?.name ?? v.colorName, colorHex: color?.hex ?? '#111111',
      size: v.size as CartItem['size'], sku: v.sku, price: c.priceCents, quantity,
      availableQuantity: v.available, image: (color?.image ?? c.image)?.src ?? '',
      bundle: {
        bundleId: pb.bundleId, title, lineCount: pb.components.length,
        netUnitCents: p.netUnitPriceCents, setNetCents: priced.setNetCents, setSubtotalCents: priced.setSubtotalCents,
        componentProductId: c.productId,
      },
    })
  }
  if (quote) {
    // The server's numbers win. Any disagreement about which lines make up the set fails closed.
    if (quote.lines.length !== lines.length) return null
    for (const l of lines) {
      const q = quote.lines.find(x => x.sku === l.sku)
      if (!q || q.productId !== l.productId) return null
      l.price = q.originalUnitPriceCents
      l.bundle = { ...l.bundle!, netUnitCents: q.netUnitPriceCents, setNetCents: quote.setNetCents, setSubtotalCents: quote.setSubtotalCents }
    }
  }
  return lines
}
