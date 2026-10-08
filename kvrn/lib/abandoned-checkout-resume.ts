// lib/abandoned-checkout-resume.ts — rebuild a saved bag from a recovery link, honestly.
//
// What this does (all read-only):
//   * re-reads every SKU from the canonical product tables: active? stock? CURRENT price?
//   * fail closed: unknown / inactive / sold-out lines are dropped and LISTED; a short line is
//     reduced to what is available and LISTED. Nothing is assumed available.
//   * the price shown is today's canonical price. The price the customer saw earlier is only
//     used to say "this changed" BEFORE payment. An old total is never used.
//   * the discount code (if any) is re-validated with the existing validateDiscount. It is only
//     REPORTED (valid / expired / ...); no claim is created or resurrected here, and the
//     customer re-enters the code in the normal checkout, which re-validates and claims it.
//   * currency: restored only if still safely supported (USD only today); otherwise it falls
//     back to USD with a notice. No FX rate is ever used.
//   * affiliate attribution: the stored session id is handed back ONLY if a real click exists
//     for it; attribution itself is decided by the existing code at order time under today's
//     rules (window, self-referral, ...). Nothing here widens attribution.
//
// What it deliberately does NOT do: reserve stock. The original reservation is left to expire
// (it is never kept alive) and a click on a link must not hold inventory. A FRESH reservation
// is created by the unchanged checkout (/api/checkout/session -> reserve_inventory) the moment
// the customer submits it — that call remains the final, locked authority, so nothing can be
// oversold even if the last unit disappears between this page and payment.

import type { CartItem } from '@/types'
import { buildCartItemId } from './utils'
import { PUBLIC_SLUG_TO_PRODUCT_CODE } from './catalog'
import { getProductBySlug } from '@/data/products'
import { isValidSessionId } from './affiliate-session'
import type { AbandonedRow, CartLine } from './abandoned-checkout'
import type { DiscountValidationResult } from './discounts'
import { bundleCartItemId } from './bundle-cart'
import { BUNDLE_COPY_DEFAULTS } from './bundle-model'
import { formatCents } from './bundle-pricing'
import type { BundleQuoteErr, BundleQuoteOk } from './bundle-types'

type Sql = any

/** Currencies a recovered checkout may be restored in. Extend only with the multi-currency work. */
export const SUPPORTED_RECOVERY_CURRENCIES: readonly string[] = ['usd']
export const MAX_QTY_PER_SKU = 10

export function resolveRecoveryCurrency(stored: string | null | undefined): { currency: string; fellBack: boolean } {
  const c = String(stored ?? 'usd').toLowerCase()
  return SUPPORTED_RECOVERY_CURRENCIES.includes(c) ? { currency: c, fellBack: false } : { currency: 'usd', fellBack: true }
}

export type LineStatus = 'ok' | 'reduced' | 'unavailable'
export type LineReason = 'sold_out' | 'inactive' | 'not_found' | 'bundle_incomplete'

export interface ResumeLine {
  sku: string
  name: string
  size: string
  color: string
  requestedQuantity: number
  quantity: number
  /** Current canonical price (cents). Null when the line is unavailable. */
  unitPriceCents: number | null
  /** What the customer saw earlier (cents) — only to explain a change. */
  seenUnitPriceCents: number | null
  priceChanged: boolean
  status: LineStatus
  reason?: LineReason
  /** Present when the line was restored as part of a set (its unit price is the set's net price). */
  bundleId?: string
}

export interface VariantFacts {
  sku: string
  variant_id: string
  product_id: string
  product_name: string
  neon_slug: string
  size: string
  color_name: string
  price_cents: number
  currency: string
  variant_active: boolean
  product_active: boolean
  available: number
}

/** Pure per-line decision. Exported for unit tests. */
export function evaluateLine(stored: CartLine, facts: VariantFacts | undefined): ResumeLine {
  const requested = Math.min(Math.max(Math.floor(Number(stored.quantity) || 0), 0), MAX_QTY_PER_SKU)
  const base = {
    sku: stored.sku,
    name: facts?.product_name ?? stored.productName,
    size: facts?.size ?? stored.size,
    color: facts?.color_name ?? stored.color,
    requestedQuantity: requested,
    seenUnitPriceCents: stored.seenUnitPriceCents ?? null,
  }
  if (!facts) {
    return { ...base, quantity: 0, unitPriceCents: null, priceChanged: false, status: 'unavailable', reason: 'not_found' }
  }
  if (!facts.variant_active || !facts.product_active || String(facts.currency).toLowerCase() !== 'usd' || requested < 1) {
    return { ...base, quantity: 0, unitPriceCents: null, priceChanged: false, status: 'unavailable', reason: 'inactive' }
  }
  if (facts.available <= 0) {
    return { ...base, quantity: 0, unitPriceCents: null, priceChanged: false, status: 'unavailable', reason: 'sold_out' }
  }
  const quantity = Math.min(requested, facts.available)
  const price = Number(facts.price_cents)
  return {
    ...base,
    quantity,
    unitPriceCents: price,
    priceChanged: base.seenUnitPriceCents !== null && base.seenUnitPriceCents !== price,
    status: quantity < requested ? 'reduced' : 'ok',
  }
}

export type NoticeCode =
  | 'price_changed' | 'items_removed' | 'quantity_reduced' | 'currency_fallback'
  | 'discount_not_applied' | 'discount_recheck' | 'bundle_incomplete'
  | 'bundle_price_changed' | 'bundle_unavailable' | 'bundle_unconfirmed'

export interface Notice { code: NoticeCode; message: string }

export type DiscountReport =
  | { code: string; status: 'valid'; message: string }
  | { code: string; status: 'expired' | 'invalid' | 'already_redeemed' | 'minimum_subtotal' | 'recheck' | 'unavailable'; message: string }

export type ResumeResult =
  | {
      ok: true
      lines: ResumeLine[]
      cart: CartItem[]
      subtotalCents: number
      priceChanged: boolean
      currency: string
      currencyFellBack: boolean
      discount: DiscountReport | null
      affiliateSessionId: string | null
      notices: Notice[]
    }
  | { ok: false; code: 'all_unavailable' | 'empty' | 'error' }

export interface ResumeDeps {
  validateDiscount: (code: string, opts: { subtotalCents: number; country: string }) => Promise<DiscountValidationResult>
  /**
   * Re-prices a saved set from its CURRENT published rule (the same read-only quote checkout uses).
   * Optional: without it a saved set is never restored as a set (see resume()).
   */
  bundles?: { quote: (raw: unknown) => Promise<BundleQuoteOk | BundleQuoteErr> }
}

export interface BundleResumeContext {
  bundleId: string
  setQuantity: number
  seenSetNetCents: number | null
  components: Array<{ sku: string; productId: string }>
}

/**
 * Reads the bundle_context the checkout recorded. Returns null for anything that is not a set the
 * bundles feature recorded (older contexts without a bundleId keep the plain all-or-nothing rule).
 */
export function parseBundleResumeContext(ctx: unknown): BundleResumeContext | null {
  const c = ctx as any
  if (!c || typeof c !== 'object' || typeof c.bundleId !== 'string' || !c.bundleId) return null
  if (!Array.isArray(c.components) || c.components.length === 0) return null
  const components: Array<{ sku: string; productId: string }> = []
  for (const x of c.components) {
    if (typeof x?.sku !== 'string' || !x.sku || typeof x?.productId !== 'string' || !x.productId) return null
    components.push({ sku: x.sku, productId: x.productId })
  }
  const q = Number(c.setQuantity)
  const seen = Number(c.seenSetNetCents)
  return {
    bundleId: c.bundleId,
    setQuantity: Number.isSafeInteger(q) && q >= 1 ? q : 1,
    seenSetNetCents: Number.isSafeInteger(seen) && seen >= 0 ? seen : null,
    components,
  }
}

function slugifyColor(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default'
}

/** Build the storefront CartItem for a line. Uses the coded catalog for imagery only (best effort). */
export function buildCartItem(line: ResumeLine, f: VariantFacts): CartItem {
  let coded: ReturnType<typeof getProductBySlug>
  try {
    const code = PUBLIC_SLUG_TO_PRODUCT_CODE[f.neon_slug]
    const publicSlug = code
      ? Object.keys(PUBLIC_SLUG_TO_PRODUCT_CODE).find(k => PUBLIC_SLUG_TO_PRODUCT_CODE[k] === code && getProductBySlug(k))
      : undefined
    coded = publicSlug ? getProductBySlug(publicSlug) : undefined
  } catch { coded = undefined }
  const colorDef = coded?.colors.find(c => c.name.toLowerCase() === f.color_name.toLowerCase()) ?? coded?.colors[0]
  const productId = coded?.id ?? f.product_id
  const color = colorDef?.value ?? slugifyColor(f.color_name)
  return {
    cartItemId: buildCartItemId(productId, color, f.size),
    productId,
    productName: coded?.name ?? f.product_name,
    slug: coded?.slug ?? f.neon_slug,
    color,
    colorName: f.color_name,
    colorHex: colorDef?.hex ?? '#111111',
    size: f.size as CartItem['size'],
    sku: line.sku,
    price: line.unitPriceCents ?? 0,
    quantity: line.quantity,
    availableQuantity: f.available,
    image: colorDef?.images.find(i => i.type === 'front')?.src ?? '',
  }
}

/**
 * Bundle rule (bundle_context = { components: [{ sku, quantity }] }): a bundle is all-or-nothing.
 * If ANY component is unavailable or short, EVERY component line of that bundle is dropped, so
 * a partial set can never be carried into checkout under a bundle expectation. The bundle's own
 * price rule is not applied here — the bundles feature prices it from its CURRENT rule at
 * checkout; this only guarantees the components are still real, active and in stock.
 */
export function applyBundleRule(lines: ResumeLine[], ctx: unknown): { lines: ResumeLine[]; dropped: boolean } {
  const comps = (ctx as any)?.components
  if (!Array.isArray(comps) || comps.length === 0) return { lines, dropped: false }
  const skus = new Set<string>(comps.map((c: any) => String(c?.sku ?? '')).filter(Boolean))
  if (!skus.size) return { lines, dropped: false }
  const members = lines.filter(l => skus.has(l.sku))
  const complete = skus.size === members.length && members.every(l => l.status === 'ok')
  if (complete) return { lines, dropped: false }
  return {
    dropped: true,
    lines: lines.map(l => skus.has(l.sku)
      ? { ...l, quantity: 0, unitPriceCents: null, priceChanged: false, status: 'unavailable' as const, reason: 'bundle_incomplete' as const }
      : l),
  }
}

export function createResumeService(sql: Sql, deps: ResumeDeps) {
  async function loadFacts(skus: string[]): Promise<Map<string, VariantFacts>> {
    if (!skus.length) return new Map()
    const rows = await sql`
      SELECT pv.sku, pv.id AS variant_id, p.id AS product_id, p.name AS product_name, p.slug AS neon_slug,
             pv.size, pv.color_name, p.price_cents, p.currency,
             pv.active AS variant_active, p.active AS product_active,
             GREATEST(0, pv.stock_on_hand - pv.reserved_quantity) AS available
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
       WHERE pv.sku = ANY(${skus}::text[])` as any[]
    const m = new Map<string, VariantFacts>()
    for (const r of rows) {
      m.set(r.sku, {
        sku: r.sku, variant_id: r.variant_id, product_id: r.product_id, product_name: r.product_name,
        neon_slug: r.neon_slug, size: r.size, color_name: r.color_name,
        price_cents: Number(r.price_cents), currency: r.currency,
        variant_active: !!r.variant_active, product_active: !!r.product_active,
        available: Number(r.available),
      })
    }
    return m
  }

  async function hasReferralEvidence(sessionId: string): Promise<boolean> {
    try {
      const r = await sql`SELECT 1 FROM affiliate_clicks WHERE session_id = ${sessionId} LIMIT 1` as any[]
      return r.length > 0
    } catch { return false }   // cannot prove a referral => do not restore one
  }

  async function reportDiscount(code: string, subtotalCents: number): Promise<DiscountReport> {
    try {
      const v = await deps.validateDiscount(code, { subtotalCents, country: 'US' })
      if (v.valid) {
        return { code, status: 'valid', message: `Code ${code} still applies. Enter it at checkout — it is checked again when you pay.` }
      }
      // The destination is unknown until the customer enters an address, so a country rule is
      // reported as "re-checked at checkout", never as a rejection.
      if (v.reason === 'shipping_restricted') {
        return { code, status: 'recheck', message: `Code ${code} depends on your shipping address. It is checked at checkout.` }
      }
      const status = (['expired', 'invalid', 'already_redeemed', 'minimum_subtotal'] as const).includes(v.reason as any)
        ? (v.reason as 'expired' | 'invalid' | 'already_redeemed' | 'minimum_subtotal') : 'invalid'
      return { code, status, message: `Code ${code} can’t be used anymore: ${v.error}` }
    } catch {
      return { code, status: 'unavailable', message: `We couldn’t check code ${code} right now. It is checked at checkout.` }
    }
  }

  /** Rebuild the bag for a resolved recovery row. Read-only. Never throws. */
  async function resume(row: AbandonedRow): Promise<ResumeResult> {
    try {
      const stored: CartLine[] = Array.isArray(row.cart) ? row.cart : []
      if (!stored.length) return { ok: false, code: 'empty' }

      const facts = await loadFacts(stored.map(l => l.sku))
      const bctx = parseBundleResumeContext(row.bundle_context)
      const setSkus = new Set(bctx?.components.map(c => c.sku) ?? [])
      // A saved set line's remembered price is its NET price inside the set; it is never compared
      // with the canonical single-item price (that would be a false "price changed").
      let lines = stored.map(l => evaluateLine(setSkus.has(l.sku) ? { ...l, seenUnitPriceCents: null } : l, facts.get(l.sku)))
      const bundleBroken = applyBundleRule(lines, row.bundle_context)
      lines = bundleBroken.lines

      // Re-validate the set: still enabled, still purchasable, current price rule. Fail closed.
      let setNotice: Notice | null = null
      let setPriceChanged = false
      const setNet = new Map<string, { net: number; original: number; q: BundleQuoteOk }>()
      if (bctx && !bundleBroken.dropped) {
        let q: BundleQuoteOk | BundleQuoteErr | null = null
        const members = lines.filter(l => setSkus.has(l.sku))
        const sameQty = members.length > 0 && members.every(m => m.quantity === members[0].quantity)
        if (deps.bundles && sameQty) {
          try {
            q = await deps.bundles.quote({
              bundleId: bctx.bundleId, quantity: members[0].quantity,
              selections: bctx.components.map(c => ({ productId: c.productId, sku: c.sku })),
            })
          } catch { q = null }
        }
        if (q && q.ok) {
          for (const l of q.lines) setNet.set(l.sku, { net: l.netUnitPriceCents, original: l.originalUnitPriceCents, q })
          const nowOne = q.setNetCents
          if (bctx.seenSetNetCents !== null && bctx.seenSetNetCents !== nowOne) {
            setPriceChanged = true
            setNotice = {
              code: 'bundle_price_changed',
              message: `The price of your set changed from ${formatCents(bctx.seenSetNetCents)} to ${formatCents(nowOne)}. The price below is today’s.`,
            }
          }
        } else {
          // Not restorable as a set. The components are real and in stock, so they stay in the bag
          // as ordinary items at TODAY'S regular prices, and the customer is told plainly.
          const transient = !!q && !q.ok && q.code === 'BUNDLE_ERROR'
          const unconfirmed = !q || transient
          setPriceChanged = true
          setNotice = unconfirmed
            ? { code: 'bundle_unconfirmed', message: 'We couldn’t confirm the price of your set right now. Its items are shown at their regular prices.' }
            : { code: 'bundle_unavailable', message: 'This set is no longer offered. Its items are in your bag at their regular prices.' }
        }
      }

      const live = lines.filter(l => l.status !== 'unavailable')
      if (!live.length) return { ok: false, code: 'all_unavailable' }

      const asSet = (l: ResumeLine) => setNet.get(l.sku)
      lines = lines.map(l => {
        const n = asSet(l)
        return n && l.status !== 'unavailable'
          ? { ...l, unitPriceCents: n.net, bundleId: bctx!.bundleId }
          : l
      })
      const liveLines = lines.filter(l => l.status !== 'unavailable')
      const cart = liveLines.map(l => {
        const item = buildCartItem(l, facts.get(l.sku)!)
        const n = asSet(l)
        if (!n) return item
        const f = facts.get(l.sku)!
        return {
          ...item,
          cartItemId: bundleCartItemId(bctx!.bundleId, f.product_id),
          price: n.original,
          bundle: {
            bundleId: bctx!.bundleId,
            title: n.q.title ?? BUNDLE_COPY_DEFAULTS.headline,
            lineCount: n.q.lines.length,
            netUnitCents: n.net,
            setNetCents: n.q.setNetCents,
            setSubtotalCents: n.q.setSubtotalCents,
            componentProductId: f.product_id,
          },
        }
      })
      const subtotalCents = liveLines.reduce((s, l) => s + (l.unitPriceCents ?? 0) * l.quantity, 0)
      const cur = resolveRecoveryCurrency(row.currency)
      const linePriceChanged = liveLines.some(l => l.priceChanged)
      const priceChanged = linePriceChanged || setPriceChanged

      const notices: Notice[] = []
      const removed = lines.filter(l => l.status === 'unavailable')
      const reduced = lines.filter(l => l.status === 'reduced')
      if (linePriceChanged) notices.push({ code: 'price_changed', message: 'Some prices changed since you left. The prices below are today’s.' })
      if (removed.length) notices.push({ code: 'items_removed', message: `${removed.length === 1 ? 'An item is' : `${removed.length} items are`} no longer available and was left out.` })
      if (bundleBroken.dropped) notices.push({ code: 'bundle_incomplete', message: 'A bundle can’t be restored because one of its items is unavailable.' })
      if (setNotice) notices.push(setNotice)
      if (reduced.length) notices.push({ code: 'quantity_reduced', message: 'Some quantities were reduced to what is in stock.' })
      if (cur.fellBack) notices.push({ code: 'currency_fallback', message: 'Your earlier currency isn’t available right now. Checkout is in USD.' })

      let discount: DiscountReport | null = null
      if (row.discount_code) {
        discount = await reportDiscount(row.discount_code, subtotalCents)
        if (discount.status !== 'valid' && discount.status !== 'recheck' && discount.status !== 'unavailable') {
          notices.push({ code: 'discount_not_applied', message: discount.message })
        } else if (discount.status !== 'valid') {
          notices.push({ code: 'discount_recheck', message: discount.message })
        }
      }

      const aff = row.affiliate_session_id && isValidSessionId(row.affiliate_session_id)
        && await hasReferralEvidence(row.affiliate_session_id) ? row.affiliate_session_id : null

      return {
        ok: true, lines, cart, subtotalCents, priceChanged,
        currency: cur.currency, currencyFellBack: cur.fellBack,
        discount, affiliateSessionId: aff, notices,
      }
    } catch (e: any) {
      console.error('[abandoned] resume failed:', String(e?.message ?? '').slice(0, 120))
      return { ok: false, code: 'error' }
    }
  }

  return { resume, loadFacts }
}
