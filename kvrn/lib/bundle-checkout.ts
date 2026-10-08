// lib/bundle-checkout.ts — server side of buying a bundle ("Complete the Set").
//
// FLOW (the browser is never trusted for a price):
//   1. The cart sends `bundle: { bundleId, quantity, selections: [{ productId, sku }] }` next to the
//      ordinary `items`. Prices are NOT part of the request (an optional expectedSetNetCents is only
//      used to detect a price change and report it honestly).
//   2. quoteBundle() re-reads the PUBLISHED definition (`bundles` projection, never a draft), the
//      canonical product/variant rows and live availability, validates every selection, and prices the
//      set with lib/bundle-pricing.ts. Any problem fails closed with a customer-safe message.
//   3. reserve() expands the set into its REAL component SKUs and calls reserve_inventory_v2, which
//      re-validates the allocation in SQL under the same row locks reserve_inventory() uses. The
//      reservation (and then the order) therefore carries the allocated NET unit price per component.
//
// Gated by the existing CMS_PRODUCT_ROUTING flag (bundles are Admin-managed products) AND the
// per-bundle `enabled` state. Without a bundle in the request nothing here runs.
import { isFeatureEnabled } from './feature-flags'
import {
  BUNDLE_CODE_NOT_COMBINABLE_MESSAGE, priceBundle, MAX_BUNDLE_COMPONENTS, MAX_SET_QUANTITY,
  type BundlePricingMode,
} from './bundle-pricing'
import type {
  BundleQuoteErr, BundleQuoteLine, BundleQuoteOk, BundleRequestBody, BundleSelection,
} from './bundle-types'
import {
  aggregateAndValidate, parseDbErr,
  type LineItemInput, type ReservationErr, type ReservationItemSnapshot, type ReservationResult,
} from './reservations'

type Sql = any

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROVISIONAL_TTL_MINUTES = 35   // same hold as reservations.ts

// ── request parsing (pure) ─────────────────────────────────────────────────────

export type ParsedBundleRequest = { ok: true; req: BundleRequestBody } | { ok: false; message: string }

const INVALID = { ok: false as const, message: 'Your set could not be read. Please review your bag.' }

export function parseBundleRequest(raw: unknown): ParsedBundleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INVALID
  const o = raw as Record<string, unknown>
  if (typeof o.bundleId !== 'string' || !UUID_RE.test(o.bundleId)) return INVALID
  if (typeof o.quantity !== 'number' || !Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > MAX_SET_QUANTITY) {
    return { ok: false, message: `Choose a quantity from 1 to ${MAX_SET_QUANTITY} for the set.` }
  }
  if (!Array.isArray(o.selections) || o.selections.length < 1 || o.selections.length > MAX_BUNDLE_COMPONENTS) return INVALID
  const selections: BundleSelection[] = []
  const products = new Set<string>()
  const skus = new Set<string>()
  for (const s of o.selections) {
    if (!s || typeof s !== 'object') return INVALID
    const productId = (s as any).productId
    const sku = (s as any).sku
    if (typeof productId !== 'string' || !UUID_RE.test(productId)) return INVALID
    if (typeof sku !== 'string' || !sku.startsWith('KVRN-') || sku.length > 80) return INVALID
    const pid = productId.toLowerCase()
    if (products.has(pid) || skus.has(sku)) return INVALID
    products.add(pid); skus.add(sku)
    selections.push({ productId: pid, sku })
  }
  let expected: number | null = null
  if (o.expectedSetNetCents !== undefined && o.expectedSetNetCents !== null) {
    if (typeof o.expectedSetNetCents !== 'number' || !Number.isInteger(o.expectedSetNetCents) || o.expectedSetNetCents < 0) return INVALID
    expected = o.expectedSetNetCents
  }
  return { ok: true, req: { bundleId: o.bundleId.toLowerCase(), quantity: o.quantity, selections, expectedSetNetCents: expected } }
}

// ── facts (rows read from the canonical tables) ───────────────────────────────

export interface BundleFacts {
  bundle: {
    id: string; ownerProductId: string; enabled: boolean; includeOwner: boolean
    mode: BundlePricingMode; value: number; revision: number; presentation: Record<string, any>
  }
  components: Array<{
    productId: string; isOwner: boolean; viewSeparately: boolean; sortOrder: number; allowedVariantIds: string[] | null
    name: string; priceCents: number; active: boolean; currency: string; live: boolean
  }>
  variants: Array<{
    id: string; productId: string; sku: string; size: string; sizeSort: number; color: string; colorCode: string
    active: boolean; available: number
  }>
}

export async function loadBundleFacts(sql: Sql, bundleId: string): Promise<BundleFacts | null> {
  const b = await sql`
    SELECT id::text AS id, owner_product_id::text AS owner_product_id, enabled, include_owner,
           pricing_mode, pricing_value, revision, presentation
      FROM bundles WHERE id = ${bundleId}::uuid` as any[]
  if (!b[0]) return null
  const comps = await sql`
    SELECT bc.component_product_id::text AS product_id, bc.is_owner, bc.view_separately, bc.sort_order,
           CASE WHEN bc.allowed_variant_ids IS NULL THEN NULL ELSE (SELECT array_agg(x::text) FROM unnest(bc.allowed_variant_ids) x) END AS allowed,
           p.name, p.price_cents, p.active, p.currency,
           EXISTS (SELECT 1 FROM content_entities e WHERE e.entity_type = 'product' AND e.entity_id = p.id::text AND e.status = 'published') AS live
      FROM bundle_components bc JOIN products p ON p.id = bc.component_product_id
     WHERE bc.bundle_id = ${bundleId}::uuid ORDER BY bc.sort_order` as any[]
  const ids = comps.map(c => c.product_id)
  const vs = ids.length ? await sql`
    SELECT pv.id::text AS id, pv.product_id::text AS product_id, pv.sku, pv.size, pv.size_sort, pv.color_name, pv.color_code, pv.active,
           GREATEST(0, pv.stock_on_hand - pv.reserved_quantity)::int AS available
      FROM product_variants pv WHERE pv.product_id = ANY(${ids}::uuid[])` as any[] : []
  return {
    bundle: {
      id: b[0].id, ownerProductId: b[0].owner_product_id, enabled: !!b[0].enabled, includeOwner: !!b[0].include_owner,
      mode: b[0].pricing_mode, value: Number(b[0].pricing_value), revision: Number(b[0].revision),
      presentation: b[0].presentation ?? {},
    },
    components: comps.map(c => ({
      productId: c.product_id, isOwner: !!c.is_owner, viewSeparately: c.view_separately !== false, sortOrder: Number(c.sort_order),
      allowedVariantIds: c.allowed ?? null, name: c.name, priceCents: Number(c.price_cents),
      active: !!c.active, currency: String(c.currency ?? 'usd').toLowerCase(), live: !!c.live,
    })),
    variants: vs.map(v => ({
      id: v.id, productId: v.product_id, sku: v.sku, size: v.size, sizeSort: Number(v.size_sort ?? 0), color: v.color_name,
      colorCode: v.color_code ?? '', active: !!v.active, available: Number(v.available),
    })),
  }
}

// ── quote (pure over facts) ───────────────────────────────────────────────────

const err = (code: BundleQuoteErr['code'], message: string, status = 400, extra: Partial<BundleQuoteErr> = {}): BundleQuoteErr =>
  ({ ok: false, code, message, status, ...extra })

export const BUNDLE_MESSAGES = {
  unavailable: 'This set is no longer available. Please review your bag.',
  selection: 'One of the choices in your set is no longer available. Please review your bag.',
  conflict: 'One of the items in your set is also in your bag on its own. Choose a different size for the separate item, or remove it.',
  disabled: 'Sets are not available right now.',
} as const

export function quoteBundle(facts: BundleFacts | null, req: BundleRequestBody): BundleQuoteOk | BundleQuoteErr {
  if (!facts || !facts.bundle.enabled) return err('BUNDLE_UNAVAILABLE', BUNDLE_MESSAGES.unavailable, 409)
  const comps = facts.components
  if (comps.length === 0 || comps.length !== req.selections.length) return err('BUNDLE_SELECTION_INVALID', BUNDLE_MESSAGES.selection, 409)

  const lines: Array<{ comp: BundleFacts['components'][number]; v: BundleFacts['variants'][number] }> = []
  for (const comp of comps) {
    if (!comp.active || !comp.live || comp.currency !== 'usd' || comp.priceCents < 1) {
      return err('BUNDLE_UNAVAILABLE', BUNDLE_MESSAGES.unavailable, 409)
    }
    const sel = req.selections.filter(s => s.productId === comp.productId)
    if (sel.length !== 1) return err('BUNDLE_SELECTION_INVALID', BUNDLE_MESSAGES.selection, 409)
    const v = facts.variants.find(x => x.sku === sel[0].sku && x.productId === comp.productId)
    if (!v || !v.active) return err('BUNDLE_SELECTION_INVALID', BUNDLE_MESSAGES.selection, 409, { sku: sel[0].sku })
    if (comp.allowedVariantIds && !comp.allowedVariantIds.includes(v.id)) {
      return err('BUNDLE_SELECTION_INVALID', BUNDLE_MESSAGES.selection, 409, { sku: v.sku })
    }
    if (v.available < req.quantity) {
      return err('BUNDLE_COMPONENT_UNAVAILABLE', `${comp.name} is sold out in the size you chose. Please choose another.`, 409, { sku: v.sku })
    }
    lines.push({ comp, v })
  }

  const priced = priceBundle({
    mode: facts.bundle.mode, value: facts.bundle.value, setQuantity: req.quantity,
    components: lines.map(l => ({ key: l.v.sku, unitPriceCents: l.comp.priceCents, sortKey: String(l.comp.sortOrder).padStart(3, '0') })),
  })
  if (!priced.ok) {
    // The rule is no longer valid at today's prices (e.g. a component was repriced): never sell it.
    return err('BUNDLE_UNAVAILABLE', BUNDLE_MESSAGES.unavailable, 409)
  }
  if (req.expectedSetNetCents != null && req.expectedSetNetCents !== priced.setNetCents) {
    return err('BUNDLE_PRICE_CHANGED', 'The price of this set changed. Please review your bag.', 409, { newSetNetCents: priced.setNetCents })
  }
  const outLines: BundleQuoteLine[] = lines.map((l, i) => ({
    productId: l.comp.productId, sku: l.v.sku, variantId: l.v.id, name: l.comp.name, size: l.v.size, color: l.v.color,
    originalUnitPriceCents: priced.lines[i].originalUnitPriceCents,
    allocatedDiscountPerUnitCents: priced.lines[i].allocatedDiscountPerUnitCents,
    netUnitPriceCents: priced.lines[i].netUnitPriceCents,
    quantity: priced.lines[i].quantity,
  }))
  const headline = typeof facts.bundle.presentation?.headline === 'string' ? facts.bundle.presentation.headline : null
  return {
    ok: true, bundleId: facts.bundle.id, title: headline, quantity: req.quantity,
    setSubtotalCents: priced.setSubtotalCents, setDiscountCents: priced.setDiscountCents, setNetCents: priced.setNetCents,
    subtotalCents: priced.subtotalCents, discountCents: priced.discountCents, netCents: priced.netCents,
    lines: outLines,
  }
}

// ── checkout preparation ──────────────────────────────────────────────────────

export interface BundlePrep {
  quote: BundleQuoteOk
  /** Items for reserve_inventory_v2 (plain lines first, then the set's component lines). */
  reserveItems: Array<Record<string, unknown>>
  /** Real component SKUs, for shipping rates (weights/dimensions come from the real products). */
  shippingItems: LineItemInput[]
}

export type BundlePrepResult = { ok: true; prep: BundlePrep } | BundleQuoteErr

export function buildReserveItems(plain: LineItemInput[], quote: BundleQuoteOk): Array<Record<string, unknown>> {
  return [
    ...plain.map(i => ({ sku: i.sku, quantity: i.quantity })),
    ...quote.lines.map(l => ({ sku: l.sku, quantity: l.quantity, unit_price_cents: l.netUnitPriceCents, bundle: true })),
  ]
}

export function createBundleCheckout(sql: Sql, opts: { isEnabled?: () => boolean } = {}) {
  const enabled = opts.isEnabled ?? (() => isFeatureEnabled('CMS_PRODUCT_ROUTING'))

  async function quote(raw: unknown): Promise<BundleQuoteOk | BundleQuoteErr> {
    if (!enabled()) return err('BUNDLE_DISABLED', BUNDLE_MESSAGES.disabled, 404)
    const parsed = parseBundleRequest(raw)
    if (!parsed.ok) return err('BUNDLE_INVALID_REQUEST', parsed.message, 400)
    let facts: BundleFacts | null
    try { facts = await loadBundleFacts(sql, parsed.req.bundleId) }
    catch (e: any) {
      console.error('[bundle] facts failed:', String(e?.message ?? '').slice(0, 100))
      return err('BUNDLE_ERROR', 'We could not check this set right now. Please try again.', 503)
    }
    return quoteBundle(facts, parsed.req)
  }

  async function prepare(raw: unknown, plainItems: LineItemInput[], discountCode?: unknown): Promise<BundlePrepResult> {
    if (typeof discountCode === 'string' && discountCode.trim()) {
      return err('BUNDLE_DISCOUNT_NOT_COMBINABLE', BUNDLE_CODE_NOT_COMBINABLE_MESSAGE, 400)
    }
    const q = await quote(raw)
    if (!q.ok) return q
    const plainSkus = new Set((plainItems ?? []).map(i => i?.sku))
    const clash = q.lines.find(l => plainSkus.has(l.sku))
    if (clash) return err('BUNDLE_SKU_CONFLICT', BUNDLE_MESSAGES.conflict, 400, { sku: clash.sku })
    return {
      ok: true,
      prep: {
        quote: q,
        reserveItems: buildReserveItems(plainItems ?? [], q),
        shippingItems: q.lines.map(l => ({ sku: l.sku, quantity: l.quantity })),
      },
    }
  }

  async function reserve(prep: BundlePrep, plainItems: LineItemInput[]): Promise<ReservationResult | ReservationErr> {
    if ((plainItems ?? []).length > 0) {
      const agg = aggregateAndValidate(plainItems)
      if (!Array.isArray(agg)) return agg
      // aggregation merges duplicate plain SKUs exactly like the ordinary checkout does
      prep = { ...prep, reserveItems: buildReserveItems(agg, prep.quote) }
    }
    const expiresAt = new Date(Date.now() + PROVISIONAL_TTL_MINUTES * 60 * 1000)
    const bundleJson = JSON.stringify({ bundle_id: prep.quote.bundleId, quantity: prep.quote.quantity })
    try {
      const rows = await sql`
        SELECT reserve_inventory_v2(${JSON.stringify(prep.reserveItems)}::jsonb, ${expiresAt.toISOString()}::timestamptz, ${bundleJson}::jsonb) AS result`
      const r: any = (rows[0] as any).result
      const parsed = typeof r === 'string' ? JSON.parse(r) : r
      const items: ReservationItemSnapshot[] = (parsed.items ?? []).map((i: any) => ({
        variantId: i.variant_id, sku: i.sku, productName: i.product_name, size: i.size, color: i.color,
        unitPriceCents: Number(i.unit_price_cents), quantity: Number(i.quantity),
        originalUnitPriceCents: i.original_unit_price_cents == null ? undefined : Number(i.original_unit_price_cents),
        ...(i.bundle_id ? { bundleId: String(i.bundle_id) } : {}),
      }))
      return { ok: true, reservationId: parsed.reservation_id, expiresAt, items, ...(parsed.bundle ? { bundle: parsed.bundle } : {}) }
    } catch (e: any) {
      const msg: string = e?.message ?? ''
      if (msg.includes('KVRN_RESERVATION|')) return parseBundleDbErr(msg)
      console.error('reserveBundle DB error:', msg.slice(0, 160))
      return { ok: false, code: 'DB_ERROR', message: 'Reservation failed. Please try again.' }
    }
  }

  return { quote, prepare, reserve }
}

export type BundleCheckout = ReturnType<typeof createBundleCheckout>

/** Customer-safe mapping of a reserve_inventory_v2 failure. Never reveals stock counts or prices. */
export function parseBundleDbErr(msg: string): ReservationErr {
  const m = msg.match(/KVRN_RESERVATION\|([^|]+)\|(.*)/)
  const code = m?.[1]
  const info = m?.[2]?.trim().split('\n')[0] ?? ''
  switch (code) {
    case 'BUNDLE_UNAVAILABLE':
      return { ok: false, code: 'BUNDLE_UNAVAILABLE', message: BUNDLE_MESSAGES.unavailable }
    case 'BUNDLE_SELECTION_INVALID':
      return { ok: false, code: 'BUNDLE_SELECTION_INVALID', message: BUNDLE_MESSAGES.selection, sku: info || undefined }
    case 'BUNDLE_PRICE_MISMATCH':
      return { ok: false, code: 'BUNDLE_PRICE_MISMATCH', message: 'The price of this set just changed. Please review your bag and try again.' }
    case 'BUNDLE_QUANTITY':
      return { ok: false, code: 'BUNDLE_QUANTITY', message: `Choose a quantity from 1 to ${MAX_SET_QUANTITY} for the set.` }
    case 'DUPLICATE_SKU':
      return { ok: false, code: 'BUNDLE_SKU_CONFLICT', message: BUNDLE_MESSAGES.conflict, sku: info || undefined }
    default:
      return parseDbErr(msg)
  }
}
