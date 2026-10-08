// lib/product-variants.ts — colour × size matrix helpers (pure, client-safe).
//
// SKU rules: stored SKUs are canonical and permanent. The pattern below only SUGGESTS SKUs for
// NEW variants: KVRN-<PRODUCTCODE>-<COLORCODE>-<SIZE>. The frozen reserve_inventory() requires
// the KVRN- prefix; lib/shippo.ts resolves parcel data for new products from the
// KVRN-<PRODUCTCODE>- prefix. Existing variants (matched by colour+size) keep their SKU/id.
import type { ColorDef, VariantDef } from './product-model'
import { slugify } from './product-model'

export const STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const

/** Safe SKU fragment: capitals, digits, hyphens. "S/M" -> "S-M", "One Size" -> "ONESIZE". */
export function skuFragment(input: string): string {
  return (input ?? '').toUpperCase().replace(/[\/\s]+/g, (m) => (m.includes('/') ? '-' : '')).replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

export function buildVariantSku(productCode: string, colorCode: string, size: string): string {
  return ['KVRN', skuFragment(productCode), skuFragment(colorCode), skuFragment(size)].filter(Boolean).join('-')
}

/** 3-letter colour code from a name (Black -> BLK, Dark Grey -> DGR), unique within `taken`. */
export function colorCodeFromName(name: string, taken: ReadonlyArray<string> = []): string {
  const letters = (name ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim()
  const words = letters.split(/\s+/).filter(Boolean)
  let base: string
  if (words.length >= 2) base = words.map(w => w[0]).join('').padEnd(3, words[words.length - 1].slice(1) + 'XX').slice(0, 3)
  else {
    const w = words[0] ?? 'CLR'
    const consonants = w[0] + w.slice(1).replace(/[AEIOU]/g, '')
    base = (consonants.length >= 3 ? consonants : w.padEnd(3, 'X')).slice(0, 3)
  }
  let code = base, n = 2
  while (taken.includes(code)) code = `${base.slice(0, 2)}${n++}`
  return code
}

export function newColor(name: string, hex: string, existing: ReadonlyArray<ColorDef>): ColorDef {
  const key = slugify(name) || 'color'
  let k = key, n = 2
  while (existing.some(c => c.key === k)) k = `${key}-${n++}`
  return { key: k, code: colorCodeFromName(name, existing.map(c => c.code)), name: name.trim(), hex, media: null }
}

/**
 * Generate the colour × size matrix. Combinations that already exist (same colour code + size,
 * case-insensitive) are KEPT AS THEY ARE (id, sku, active) — never regenerated or renamed.
 * Only missing combinations get a new suggested SKU. Order: sizes as listed, colours as listed.
 */
export function generateVariants(a: {
  productCode: string; colors: ReadonlyArray<ColorDef>; sizes: ReadonlyArray<string>; existing?: ReadonlyArray<VariantDef>
}): VariantDef[] {
  const existing = a.existing ?? []
  const sizes = [...new Set(a.sizes.map(s => s.trim()).filter(Boolean))]
  const out: VariantDef[] = []
  a.colors.forEach(color => {
    sizes.forEach((size, si) => {
      const found = existing.find(v => v.colorCode === color.code && v.size.toLowerCase() === size.toLowerCase())
      out.push(found ?? { id: null, sku: buildVariantSku(a.productCode, color.code, size), colorCode: color.code, size, sizeSort: si + 1, active: true })
    })
  })
  // Existing variants outside the requested matrix are preserved (the editor removes them explicitly).
  existing.forEach(v => { if (!out.some(o => o.sku === v.sku && v.sku)) out.push(v) })
  return out
}

export interface VariantIssue { index: number; code: string; message: string }

/** Instant client-side SKU checks. The server (catalog_product_blockers) is the authority. */
export function variantIssues(productCode: string, variants: ReadonlyArray<VariantDef>, knownExistingSkus: ReadonlyArray<string> = []): VariantIssue[] {
  const issues: VariantIssue[] = []
  const seen = new Set<string>(), pairs = new Set<string>()
  const prefix = `KVRN-${skuFragment(productCode)}-`
  variants.forEach((v, i) => {
    if (!v.sku) issues.push({ index: i, code: 'SKU_REQUIRED', message: 'Every variant needs a SKU.' })
    else {
      if (!/^KVRN-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(v.sku)) issues.push({ index: i, code: 'SKU_INVALID', message: `${v.sku}: start with KVRN- and use capitals, digits, hyphens.` })
      if (seen.has(v.sku)) issues.push({ index: i, code: 'SKU_DUPLICATE', message: `${v.sku} appears more than once.` })
      seen.add(v.sku)
      if (!knownExistingSkus.includes(v.sku) && !v.sku.startsWith(prefix)) issues.push({ index: i, code: 'SKU_PREFIX', message: `New SKUs must start with ${prefix}` })
    }
    const pair = `${v.colorCode}|${v.size.toLowerCase()}`
    if (pairs.has(pair)) issues.push({ index: i, code: 'VARIANT_DUPLICATE', message: 'Each colour and size can appear once.' })
    pairs.add(pair)
  })
  return issues
}
