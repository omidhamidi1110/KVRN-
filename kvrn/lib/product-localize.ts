// lib/product-localize.ts — the storefront READ side of product translations. PURE except the loader.
//
// Admin-managed product text is translated per field in `content_translations`
// (entity_type 'product', entity_id = products.id; fields = PRODUCT_TRANSLATABLE_FIELDS, plus
// `bundle.*` for the bundle presentation copy owned by the bundles module). Only PUBLISHED rows are
// ever shown, and a field without one renders the English source — reported as 'fallback', never as
// translated (lib/translations.resolveFields). Stale translations (written against older source
// text) are shown but reported as 'stale' so Admin can flag them.
//
// NEVER translated here: sku, price, size/colour values, weight, cost, slug, stock — only the
// words a customer reads. The overlay therefore cannot change what is charged.

import type { Product } from '@/types'
import { resolveFields, SOURCE_LOCALE, type FieldResolution, type TranslationRow } from './translations'
import { translatableSource, type ProductSnapshot } from './product-model'

type Row = Pick<TranslationRow, 'entity_id' | 'locale' | 'field' | 'value' | 'status' | 'source_hash'>

export const PRODUCT_TRANSLATION_ENTITY = 'product'

export interface LocalizedProduct {
  product: Product
  /** Per-field state for this locale (empty for English). */
  states: Record<string, FieldResolution['state']>
  /** How many fields actually came from a published translation (translated + stale). */
  usedCount: number
}

/** Resolve a flat {field: english text} map against published rows. Generic: products, bundles. */
export function localizeFieldMap(
  source: Record<string, string>, rows: Array<Pick<TranslationRow, 'field' | 'value' | 'status' | 'source_hash'>>, locale: string,
): { values: Record<string, string>; states: Record<string, FieldResolution['state']>; usedCount: number } {
  const res = resolveFields(source, rows, locale)
  const values: Record<string, string> = {}, states: Record<string, FieldResolution['state']> = {}
  let used = 0
  for (const [f, r] of Object.entries(res)) {
    values[f] = r.value; states[f] = r.state
    if (r.state === 'translated' || r.state === 'stale') used++
  }
  return { values, states, usedCount: used }
}

/** The storefront Product with translated words (price, sizes, images etc. untouched). */
export function localizeProduct(product: Product, snapshot: ProductSnapshot, rows: Row[], locale: string): LocalizedProduct {
  if (!locale || locale === SOURCE_LOCALE) return { product, states: {}, usedCount: 0 }
  const mine = rows.filter(r => r.locale === locale && r.field && !r.field.startsWith('bundle.'))
  const { values: v, states, usedCount } = localizeFieldMap(translatableSource(snapshot), mine, locale)
  if (usedCount === 0) return { product, states, usedCount }
  const pick = (f: string, cur: string) => states[f] === 'translated' || states[f] === 'stale' ? v[f] : cur
  const out: Product = {
    ...product,
    name: pick('name', product.name),
    shortDescription: pick('shortDescription', product.shortDescription),
    description: pick('description', product.description),
    fitNote: pick('fitNote', product.fitNote),
    ...(product.eyebrow !== undefined ? { eyebrow: pick('eyebrow', product.eyebrow) } : {}),
    ...(product.founderNote !== undefined ? { founderNote: pick('founderNote', product.founderNote) } : {}),
    seo: { title: pick('seo.title', product.seo.title), description: pick('seo.description', product.seo.description) },
  }
  return { product: out, states, usedCount }
}

/** Published rows for a set of products in one locale (one query). Never throws: on a database
 *  problem the storefront simply shows English. */
export async function loadProductTranslationRows(sql: any, productIds: string[], locale: string): Promise<Row[]> {
  if (!productIds.length || !locale || locale === SOURCE_LOCALE) return []
  try {
    return await sql`
      SELECT entity_id::text AS entity_id, locale, field, value, status, source_hash
        FROM content_translations
       WHERE entity_type = ${PRODUCT_TRANSLATION_ENTITY} AND entity_id = ANY(${productIds}::text[])
         AND locale = ${locale} AND status = 'published'` as Row[]
  } catch (e) {
    console.error('product translations unavailable:', (e as Error).message)
    return []
  }
}

/** Localize published-product hits (the shape lib/product-public returns) for one locale. */
export async function localizePublishedHits<H extends { productId: string; product: Product; snapshot: ProductSnapshot; relatedProduct: Product | null }>(
  sql: any, hits: H[], locale: string,
): Promise<H[]> {
  if (!hits.length || locale === SOURCE_LOCALE) return hits
  const rows = await loadProductTranslationRows(sql, hits.map(h => h.productId), locale)
  if (!rows.length) return hits
  return hits.map(h => {
    const mine = rows.filter(r => r.entity_id === h.productId)
    const lp = localizeProduct(h.product, h.snapshot, mine, locale)
    return lp.usedCount ? { ...h, product: lp.product } : h
  })
}
