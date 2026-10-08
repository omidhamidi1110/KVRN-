// lib/bundle-preview.ts — pure live preview for the Product Editor's bundle section.
//
// Uses the SAME pricing module as the storefront and checkout (lib/bundle-pricing.ts), so what the
// Admin previews is what a customer is charged. It previews with the canonical prices and live
// availability the editor fetched; the database re-checks everything at publish (bundle_blockers).
import { priceBundle, describePricingError, type BundlePricing } from './bundle-pricing'
import type { BundleConfig, BundleIssue } from './bundle-model'

export interface PreviewVariant { id: string; sku: string; size: string; colorName: string; active: boolean; available: number }

export interface PreviewComponentInput {
  productId: string
  name: string
  /** Canonical price in cents, or the draft's intended price for an owner never published; null = none yet. */
  priceCents: number | null
  /** content_entities.status of the product ('published', 'draft', ...). */
  status: string
  variants: PreviewVariant[]
}

export interface PreviewComponent {
  productId: string
  name: string
  isOwner: boolean
  priceCents: number | null
  live: boolean
  eligibleVariants: number
  inStockVariants: number
  /** The component cannot be bought right now (no eligible size in stock / no price). */
  unavailable: boolean
  note: string | null
}

export interface BundlePreview {
  state: 'off' | 'incomplete' | 'invalid' | 'ok'
  components: PreviewComponent[]
  /** Present when the rule prices cleanly. */
  pricing: BundlePricing | null
  /** Why the set cannot be sold as configured (shown, never hidden behind a tooltip). */
  issues: BundleIssue[]
  /** Non-blocking notes (e.g. component not live yet, zero discount). */
  warnings: BundleIssue[]
  /** Customer-facing availability of the set as configured right now. */
  available: boolean
}

export function buildBundlePreview(
  cfg: BundleConfig | null,
  owner: PreviewComponentInput,
  candidates: ReadonlyArray<PreviewComponentInput>,
): BundlePreview {
  if (!cfg || !cfg.enabled) return { state: 'off', components: [], pricing: null, issues: [], warnings: [], available: false }
  const issues: BundleIssue[] = []
  const warnings: BundleIssue[] = []
  const byId = new Map(candidates.map(c => [c.productId.toLowerCase(), c] as const))

  const inputs: Array<{ src: PreviewComponentInput | null; id: string; isOwner: boolean; allowed: string[] | null; field: string }> = []
  if (cfg.includeOwner) inputs.push({ src: owner, id: owner.productId, isOwner: true, allowed: cfg.ownerAllowedVariantIds, field: 'bundle.ownerAllowedVariantIds' })
  cfg.components.forEach((c, i) => inputs.push({ src: byId.get(c.productId.toLowerCase()) ?? null, id: c.productId, isOwner: false, allowed: c.allowedVariantIds, field: `bundle.components.${i + 1}` }))

  if (cfg.components.length === 0) issues.push({ code: 'BUNDLE_NO_COMPONENTS', field: 'bundle.components', message: 'Add at least one product to the set.' })

  const components: PreviewComponent[] = inputs.map(({ src, id, isOwner, allowed, field }) => {
    if (!src) {
      issues.push({ code: 'BUNDLE_COMPONENT_MISSING', field, message: 'This product could not be found. Remove it from the set.' })
      return { productId: id, name: 'Unknown product', isOwner, priceCents: null, live: false, eligibleVariants: 0, inStockVariants: 0, unavailable: true, note: 'Not found' }
    }
    const eligible = src.variants.filter(v => v.active && (!allowed || allowed.includes(v.id)))
    const inStock = eligible.filter(v => v.available > 0)
    const live = src.status === 'published'
    let note: string | null = null
    if (src.priceCents == null || src.priceCents < 1) {
      issues.push({ code: 'BUNDLE_COMPONENT_PRICE', field, message: `${src.name} has no price yet.` })
      note = 'No price yet'
    }
    if (eligible.length === 0) {
      issues.push({ code: 'BUNDLE_NO_VARIANT', field, message: `${src.name} has no active size${allowed ? ' among the allowed ones' : ''}.` })
      note = 'No eligible size'
    } else if (inStock.length === 0) {
      note = 'Sold out'
    }
    if (!live && !isOwner) {
      issues.push({ code: 'BUNDLE_COMPONENT_UNAVAILABLE', field, message: `${src.name} is not live. Publish it first, or remove it from the set.` })
      note = note ?? 'Not live'
    }
    return {
      productId: src.productId, name: src.name, isOwner, priceCents: src.priceCents, live,
      eligibleVariants: eligible.length, inStockVariants: inStock.length,
      unavailable: eligible.length === 0 || inStock.length === 0 || src.priceCents == null, note,
    }
  })

  let pricing: BundlePricing | null = null
  const priceable = components.every(c => c.priceCents != null && c.priceCents >= 1)
  if (priceable && components.length > 0 && cfg.components.length > 0) {
    const p = priceBundle({
      mode: cfg.pricing.mode, value: cfg.pricing.value,
      components: components.map((c, i) => ({ key: c.productId, unitPriceCents: c.priceCents as number, sortKey: String(i).padStart(3, '0') })),
    })
    if (p.ok) {
      pricing = p
      if (p.setDiscountCents === 0) warnings.push({ code: 'BUNDLE_ZERO_DISCOUNT', field: 'bundle.pricing.value', message: 'This rule gives no discount at today’s prices.' })
    } else {
      issues.push({ code: `BUNDLE_PRICE_${p.code}`, field: 'bundle.pricing.value', message: describePricingError(p) })
    }
  }
  if (!cfg.includeOwner && cfg.components.length === 1) {
    warnings.push({ code: 'BUNDLE_SINGLE', field: 'bundle.components', message: 'Only one product is in this set, so it works as a discounted add-on.' })
  }

  const state: BundlePreview['state'] = cfg.components.length === 0 ? 'incomplete' : issues.length ? 'invalid' : 'ok'
  return { state, components, pricing, issues, warnings, available: state === 'ok' && components.every(c => !c.unavailable) }
}

// ── editor value inputs (pure; unit-tested) ───────────────────────────────────

/** "145" / "145.5" / "$145.50" -> 14500 / 14550 / 14550 cents; null when not a valid non-negative amount. */
export function parseMoneyInput(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null
  const [d, c = ''] = t.split('.')
  return Number(d) * 100 + Number(c.padEnd(2, '0'))
}

/** "10" / "12.5" / "10%" -> 1000 / 1250 / 1000 basis points; null unless 0 <= value < 100. */
export function parsePercentInput(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim()
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null
  const [w, f = ''] = t.split('.')
  const bps = Number(w) * 100 + Number(f.padEnd(2, '0'))
  return bps < 10_000 ? bps : null
}

/** Inverse of the two parsers, for showing the stored value in the input. */
export function formatValueInput(mode: 'set_price' | 'fixed_discount' | 'percent_discount', value: number): string {
  if (mode === 'percent_discount') {
    const w = Math.floor(value / 100), f = value % 100
    return f === 0 ? String(w) : `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}`
  }
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`
}
