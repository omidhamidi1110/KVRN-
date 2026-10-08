// lib/bundle-model.ts — the bundle ("Complete the Set") definition stored in a product snapshot.
//
// ONE SOURCE OF TRUTH, TWO PROJECTIONS
//   * The editable definition lives in the product's CMS snapshot (`snapshot.bundle`), so it
//     follows the product lifecycle: draft -> publish -> rollback -> unpublish, with version history.
//   * On publish, migration 029 projects the PUBLISHED definition into `bundles` / `bundle_components`
//     (same transaction, trigger `zz_bundle_entity_sync_trg`). Checkout and the storefront read only
//     that projection, so a draft can never reach a customer and the two can never disagree.
//
// The snapshot never stores component facts (name, price, image, variants, stock). It stores
// stable identities only (product uuid, optional variant uuids); everything else is resolved from
// the canonical tables at read time.
//
// Pure + client-safe. This file must not import product-model (product-model imports it).
import { BUNDLE_PRICING_MODES, BPS_FULL, MAX_BUNDLE_COMPONENTS, type BundlePricingMode } from './bundle-pricing'

export const BUNDLE_SCHEMA = 1

export const BUNDLE_LIMITS = {
  eyebrow: 60, headline: 120, supportingCopy: 300, ctaLabel: 40, variantIds: 200,
  maxJsonBytes: 20_000,
} as const

export interface BundleComponentDef {
  /** products.id of the canonical component product. */
  productId: string
  /** Optional constraint: only these product_variants.id are eligible. null = every active variant. */
  allowedVariantIds: string[] | null
  /** Show a "View <product> separately" link under the call to action. */
  viewSeparately: boolean
}

export interface BundlePresentation {
  eyebrow: string | null
  headline: string | null
  supportingCopy: string | null
  ctaLabel: string | null
  /** Render the section on the product page. (The bundle can exist while the section is hidden.) */
  sectionVisible: boolean
}

export interface BundleConfig {
  schema: number
  /** Master switch. OFF = the bundle does not render and cannot be bought. */
  enabled: boolean
  /** The product being edited is itself part of the set (the customer picks its variant too). */
  includeOwner: boolean
  ownerAllowedVariantIds: string[] | null
  /** The OTHER products in the set (never the owner). */
  components: BundleComponentDef[]
  pricing: { mode: BundlePricingMode; value: number }
  presentation: BundlePresentation
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function emptyBundle(): BundleConfig {
  return {
    schema: BUNDLE_SCHEMA,
    enabled: false,
    includeOwner: true,
    ownerAllowedVariantIds: null,
    components: [],
    pricing: { mode: 'percent_discount', value: 1000 },
    presentation: { eyebrow: null, headline: null, supportingCopy: null, ctaLabel: null, sectionVisible: true },
  }
}

export type BundleParse = { ok: true; bundle: BundleConfig | null } | { ok: false; errors: string[] }

function text(errors: string[], v: unknown, path: string, max: number): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') { errors.push(`${path} must be text.`); return null }
  const t = v.replace(/\r\n/g, '\n').trim()
  if (t.length > max) { errors.push(`${path} is longer than ${max} characters.`); return t.slice(0, max) }
  return t === '' ? null : t
}

function variantIds(errors: string[], v: unknown, path: string): string[] | null {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v)) { errors.push(`${path} must be a list.`); return null }
  if (v.length > BUNDLE_LIMITS.variantIds) { errors.push(`${path} has too many items.`); return null }
  const out: string[] = []
  for (const x of v) {
    if (!isUuid(x)) { errors.push(`${path} has an invalid variant id.`); continue }
    const id = x.toLowerCase()
    if (!out.includes(id)) out.push(id)
  }
  // An empty list would mean "no variant is eligible"; the editor uses null for "all".
  return out.length ? out.sort() : null
}

/**
 * Coerce untrusted JSON into a well-formed BundleConfig (or null = no bundle). Only rejects
 * malformed/over-long INPUT so a draft can be stored safely; whether the bundle may go live
 * (prices, availability, conflicts) is decided by `bundle_blockers` in the database at publish.
 */
export function parseBundleInput(raw: unknown): BundleParse {
  if (raw === undefined || raw === null) return { ok: true, bundle: null }
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['bundle must be empty or an object.'] }
  let size = 0
  try { size = JSON.stringify(raw).length } catch { return { ok: false, errors: ['bundle data is not valid.'] } }
  if (size > BUNDLE_LIMITS.maxJsonBytes) return { ok: false, errors: ['bundle data is too large.'] }

  const b = emptyBundle()
  const enabled = raw.enabled === undefined ? false : raw.enabled
  if (typeof enabled !== 'boolean') errors.push('bundle.enabled must be true or false.')
  else b.enabled = enabled
  if (raw.includeOwner !== undefined) {
    if (typeof raw.includeOwner !== 'boolean') errors.push('bundle.includeOwner must be true or false.')
    else b.includeOwner = raw.includeOwner
  }
  b.ownerAllowedVariantIds = variantIds(errors, raw.ownerAllowedVariantIds, 'bundle.ownerAllowedVariantIds')

  if (raw.components !== undefined && raw.components !== null) {
    if (!Array.isArray(raw.components)) errors.push('bundle.components must be a list.')
    else {
      if (raw.components.length > MAX_BUNDLE_COMPONENTS) errors.push(`bundle.components has more than ${MAX_BUNDLE_COMPONENTS} items.`)
      const seen = new Set<string>()
      raw.components.slice(0, MAX_BUNDLE_COMPONENTS).forEach((c, i) => {
        const path = `bundle.components.${i + 1}`
        if (!isObj(c)) { errors.push(`${path} is not valid.`); return }
        if (!isUuid(c.productId)) { errors.push(`${path}.productId is not a valid product.`); return }
        const productId = c.productId.toLowerCase()
        if (seen.has(productId)) { errors.push('The same product can be added to a set only once.'); return }
        seen.add(productId)
        let viewSeparately = true
        if (c.viewSeparately !== undefined) {
          if (typeof c.viewSeparately !== 'boolean') errors.push(`${path}.viewSeparately must be true or false.`)
          else viewSeparately = c.viewSeparately
        }
        b.components.push({ productId, allowedVariantIds: variantIds(errors, c.allowedVariantIds, `${path}.allowedVariantIds`), viewSeparately })
      })
    }
  }

  if (raw.pricing !== undefined && raw.pricing !== null) {
    if (!isObj(raw.pricing)) errors.push('bundle.pricing is not valid.')
    else {
      const mode = raw.pricing.mode
      if (!BUNDLE_PRICING_MODES.includes(mode as BundlePricingMode)) errors.push('bundle.pricing.mode is not a valid pricing rule.')
      else b.pricing.mode = mode as BundlePricingMode
      const value = raw.pricing.value
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
        errors.push('bundle.pricing.value must be a whole, non-negative number.')
      } else if (b.pricing.mode === 'percent_discount' && value >= BPS_FULL) {
        errors.push('bundle.pricing.value must be below 100% for a percentage rule.')
      } else b.pricing.value = value
    }
  }

  const p = isObj(raw.presentation) ? raw.presentation : {}
  if (raw.presentation !== undefined && raw.presentation !== null && !isObj(raw.presentation)) errors.push('bundle.presentation is not valid.')
  b.presentation = {
    eyebrow: text(errors, p.eyebrow, 'bundle.presentation.eyebrow', BUNDLE_LIMITS.eyebrow),
    headline: text(errors, p.headline, 'bundle.presentation.headline', BUNDLE_LIMITS.headline),
    supportingCopy: text(errors, p.supportingCopy, 'bundle.presentation.supportingCopy', BUNDLE_LIMITS.supportingCopy),
    ctaLabel: text(errors, p.ctaLabel, 'bundle.presentation.ctaLabel', BUNDLE_LIMITS.ctaLabel),
    sectionVisible: true,
  }
  if (p.sectionVisible !== undefined) {
    if (typeof p.sectionVisible !== 'boolean') errors.push('bundle.presentation.sectionVisible must be true or false.')
    else b.presentation.sectionVisible = p.sectionVisible
  }

  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, bundle: b }
}

// ── structural checks (instant Admin feedback; the database re-checks at publish) ──────────

export interface BundleIssue { code: string; field: string; message: string }

/** Structure-only problems (no catalog lookups). Mirrors the first half of bundle_blockers(). */
export function bundleStructureIssues(b: BundleConfig | null, ownerProductId?: string | null): BundleIssue[] {
  if (!b || !b.enabled) return []
  const out: BundleIssue[] = []
  if (b.components.length === 0) {
    out.push({ code: 'BUNDLE_NO_COMPONENTS', field: 'bundle.components', message: 'Add at least one product to the set.' })
  }
  if (!b.includeOwner && b.components.length === 0) { /* covered above */ }
  const owner = ownerProductId?.toLowerCase()
  b.components.forEach((c, i) => {
    if (owner && c.productId === owner) {
      out.push({ code: 'BUNDLE_SELF', field: `bundle.components.${i + 1}`, message: 'A product can’t be added to its own set. Turn on “Include this product” instead.' })
    }
  })
  if (b.pricing.mode === 'percent_discount' && (b.pricing.value < 0 || b.pricing.value >= BPS_FULL)) {
    out.push({ code: 'BUNDLE_VALUE', field: 'bundle.pricing.value', message: 'The percentage must be between 0% and 99.99%.' })
  }
  if (b.pricing.mode === 'set_price' && b.pricing.value < 1) {
    out.push({ code: 'BUNDLE_VALUE', field: 'bundle.pricing.value', message: 'Enter the set price.' })
  }
  return out
}

/** Product ids that make up the set (owner first when included). */
export function bundleMemberIds(b: BundleConfig, ownerProductId: string): string[] {
  const owner = ownerProductId.toLowerCase()
  return [...(b.includeOwner ? [owner] : []), ...b.components.map(c => c.productId)]
}

// ── translations (entity type `product`, fields prefixed `bundle.`) ────────────────────────

export const BUNDLE_TRANSLATABLE_FIELDS = [
  'bundle.eyebrow', 'bundle.headline', 'bundle.supportingCopy', 'bundle.ctaLabel',
] as const
export type BundleTranslatableField = typeof BUNDLE_TRANSLATABLE_FIELDS[number]

/**
 * Source-language (en) text per translatable bundle field, for lib/translations
 * (resolveFields / summarizeCompleteness). Empty string = nothing to translate.
 */
export function translatableBundleSource(b: BundleConfig | null | undefined): Record<BundleTranslatableField, string> {
  const p = b?.presentation
  return {
    'bundle.eyebrow': p?.eyebrow ?? '',
    'bundle.headline': p?.headline ?? '',
    'bundle.supportingCopy': p?.supportingCopy ?? '',
    'bundle.ctaLabel': p?.ctaLabel ?? '',
  }
}

/** Storefront copy defaults (English). Used when the Admin left a field empty; labelled as defaults. */
export const BUNDLE_COPY_DEFAULTS = {
  eyebrow: 'Complete the Set',
  headline: 'Designed to be worn together.',
  ctaLabel: 'Add the set to bag',
} as const
