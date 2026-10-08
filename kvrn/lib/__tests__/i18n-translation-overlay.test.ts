// CMS translation overlay on the storefront: products, the bundle seam, SEO text and the
// enabled-locale list. States are honest: translated / stale / fallback / missing. Never price/SKU.
import {
  localizeFieldMap, localizeProduct, loadProductTranslationRows, localizePublishedHits, PRODUCT_TRANSLATION_ENTITY,
} from '../product-localize'
import { emptySnapshot, translatableSource, PRODUCT_TRANSLATABLE_FIELDS } from '../product-model'
import { sourceHash, resolveFields, summarizeCompleteness } from '../translations'
import { getEnabledLocales } from '../content-locales'

const snap = () => {
  const s = emptySnapshot({ name: 'Heavyweight Hoodie', slug: 'hoodie', productType: 'hoodies' })
  s.shortDescription = 'Heavy fleece.'
  s.description = 'A 500 GSM hoodie.'
  s.fitNote = 'Fits oversized.'
  s.eyebrow = 'Drop 001'
  s.founderNote = 'Made to last.'
  s.seo = { ...s.seo, title: 'Hoodie | KVRN', description: 'The hoodie.' }
  return s
}
const product = (): any => ({
  id: 'p1', slug: 'hoodie', name: 'Heavyweight Hoodie', shortDescription: 'Heavy fleece.', description: 'A 500 GSM hoodie.',
  fitNote: 'Fits oversized.', eyebrow: 'Drop 001', founderNote: 'Made to last.', seo: { title: 'Hoodie | KVRN', description: 'The hoodie.' },
  price: 9500, sku: 'KVRN-HD-1', sizes: ['S', 'M', 'L'], colors: [{ name: 'Black', hex: '#000' }], images: ['/a.jpg'],
})
const row = (field: string, value: string, over: Record<string, unknown> = {}) => ({
  entity_id: 'p1', locale: 'es', field, value, status: 'published' as const, source_hash: null as string | null, ...over,
})

describe('localizeProduct: published words replace English; nothing financial can change', () => {
  test('English is returned untouched (same object)', () => {
    const p = product()
    const r = localizeProduct(p, snap(), [row('name', 'X')], 'en')
    expect(r.product).toBe(p); expect(r.usedCount).toBe(0)
  })
  test('a published translation is used; a missing field falls back to English and is reported as fallback', () => {
    const r = localizeProduct(product(), snap(), [row('name', 'Sudadera Heavyweight'), row('description', 'Una sudadera de 500 GSM.')], 'es')
    expect(r.product.name).toBe('Sudadera Heavyweight')
    expect(r.product.description).toBe('Una sudadera de 500 GSM.')
    expect(r.product.shortDescription).toBe('Heavy fleece.')            // no translation: English, not blank
    expect(r.states.name).toBe('translated')
    expect(r.states.shortDescription).toBe('fallback')
    expect(r.usedCount).toBe(2)
  })
  test('drafts and needs_review rows are never shown', () => {
    const r = localizeProduct(product(), snap(), [row('name', 'Borrador', { status: 'draft' }), row('fitNote', 'Revisar', { status: 'needs_review' })], 'es')
    expect(r.product.name).toBe('Heavyweight Hoodie'); expect(r.product.fitNote).toBe('Fits oversized.')
    expect(r.usedCount).toBe(0)
    expect(r.states.name).toBe('fallback')
  })
  test('a translation written against older English text is shown but reported stale', () => {
    const r = localizeProduct(product(), snap(), [row('name', 'Sudadera', { source_hash: sourceHash('Old Name') })], 'es')
    expect(r.states.name).toBe('stale'); expect(r.product.name).toBe('Sudadera'); expect(r.usedCount).toBe(1)
    const fresh = localizeProduct(product(), snap(), [row('name', 'Sudadera', { source_hash: sourceHash('Heavyweight Hoodie') })], 'es')
    expect(fresh.states.name).toBe('translated')
  })
  test('an empty source field with no translation is "missing", not "translated"', () => {
    const s = snap(); s.fitNote = ''
    const r = localizeProduct(product(), s, [], 'es')
    expect(r.states.fitNote).toBe('missing')
  })
  test('rows for another locale or for the bundle namespace are ignored', () => {
    const r = localizeProduct(product(), snap(), [row('name', 'Sweat', { locale: 'fr' }), row('bundle.headline', 'Ensemble')], 'es')
    expect(r.usedCount).toBe(0)
  })
  test('SEO text is overlaid', () => {
    const r = localizeProduct(product(), snap(), [row('seo.title', 'Sudadera | KVRN'), row('seo.description', 'La sudadera.')], 'es')
    expect(r.product.seo).toEqual({ title: 'Sudadera | KVRN', description: 'La sudadera.' })
  })
  test('price, SKU, sizes, colours and images can NEVER be changed by a translation row', () => {
    const rows = ['price', 'sku', 'sizes', 'colors', 'images', 'slug', 'id', 'weight', 'cost'].map(f => row(f, '1'))
    const r = localizeProduct(product(), snap(), rows, 'es')
    expect(r.product).toEqual(product())
    expect(r.usedCount).toBe(0)
    const all: any = localizeProduct(product(), snap(), PRODUCT_TRANSLATABLE_FIELDS.map(f => row(f, `T-${f}`)), 'es').product
    expect(all.price).toBe(9500); expect(all.sku).toBe('KVRN-HD-1'); expect(all.sizes).toEqual(['S', 'M', 'L'])
    expect(all.colors).toEqual(product().colors); expect(all.images).toEqual(['/a.jpg']); expect(all.slug).toBe('hoodie')
  })
  test('translatable fields contain no commercial field', () => {
    for (const f of PRODUCT_TRANSLATABLE_FIELDS) expect(f).not.toMatch(/price|sku|cost|weight|stock|inventory|size|slug|hs|origin/i)
  })
})

describe('bundle copy seam (bundles module owns the fields; the overlay resolves them generically)', () => {
  const FIELDS = ['bundle.eyebrow', 'bundle.headline', 'bundle.supportingCopy', 'bundle.ctaLabel']
  const source = { 'bundle.eyebrow': 'Complete the Set', 'bundle.headline': 'The full uniform', 'bundle.supportingCopy': '', 'bundle.ctaLabel': 'Add Set' }
  test('translated / stale / fallback / missing are reported per bundle field', () => {
    const rows = [
      { field: 'bundle.eyebrow', value: 'Completa el conjunto', status: 'published' as const, source_hash: sourceHash('Complete the Set') },
      { field: 'bundle.headline', value: 'El uniforme', status: 'published' as const, source_hash: sourceHash('An old headline') },
    ]
    const r = localizeFieldMap(source, rows, 'es')
    expect(r.states).toEqual({
      'bundle.eyebrow': 'translated', 'bundle.headline': 'stale', 'bundle.supportingCopy': 'missing', 'bundle.ctaLabel': 'fallback',
    })
    expect(r.values['bundle.ctaLabel']).toBe('Add Set')                 // English, never blank
    expect(r.usedCount).toBe(2)
    expect(Object.keys(r.states).sort()).toEqual([...FIELDS].sort())
  })
  test('draft rows are not used and English locale returns the source', () => {
    expect(localizeFieldMap(source, [{ field: 'bundle.eyebrow', value: 'x', status: 'draft', source_hash: null }], 'es').usedCount).toBe(0)
    expect(localizeFieldMap(source, [], 'en').values).toEqual(source)
  })
  test('completeness summary counts the same states (what Admin shows)', () => {
    const rows = { es: [{ field: 'bundle.eyebrow', value: 'x', status: 'published', source_hash: null }] as any[] }
    const s = summarizeCompleteness(source, rows, ['es', 'fr'])
    const es = s.find(x => x.locale === 'es')!, fr = s.find(x => x.locale === 'fr')!
    expect(es.translated).toBe(1); expect(fr.translated).toBe(0)
    expect(fr.missing + fr.translated + fr.stale).toBeGreaterThan(0)
  })
  test('resolveFields is the single resolver (no second implementation)', () => {
    const a = resolveFields(source, [], 'es')
    const b = localizeFieldMap(source, [], 'es').states
    for (const k of Object.keys(a)) expect(b[k]).toBe(a[k].state)
  })
})

describe('loading translations is safe', () => {
  test('English or no products: no query at all', async () => {
    const sql: any = jest.fn()
    expect(await loadProductTranslationRows(sql, ['p1'], 'en')).toEqual([])
    expect(await loadProductTranslationRows(sql, [], 'es')).toEqual([])
    expect(sql).not.toHaveBeenCalled()
  })
  test('queries published rows for the product entity only', async () => {
    const sql: any = jest.fn(async () => [row('name', 'X')])
    const rows = await loadProductTranslationRows(sql, ['p1'], 'es')
    expect(rows.length).toBe(1)
    const text = (sql.mock.calls[0][0] as string[]).join('?')
    expect(text).toMatch(/status = 'published'/)
    expect(text).toMatch(/entity_type = /)
    expect(sql.mock.calls[0]).toContain(PRODUCT_TRANSLATION_ENTITY)
  })
  test('a database failure shows English instead of breaking the page', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const sql: any = async () => { throw new Error('boom') }
    expect(await loadProductTranslationRows(sql, ['p1'], 'es')).toEqual([])
    const hit: any = { productId: 'p1', product: product(), snapshot: snap(), relatedProduct: null }
    const out = await localizePublishedHits(sql, [hit], 'es')
    expect(out[0]).toBe(hit)
    err.mockRestore()
  })
  test('localizePublishedHits overlays only the hits that have rows and leaves the rest untouched', async () => {
    const h1: any = { productId: 'p1', product: product(), snapshot: snap(), relatedProduct: null }
    const h2: any = { productId: 'p2', product: { ...product(), id: 'p2', name: 'Sweatpants' }, snapshot: snap(), relatedProduct: null }
    const sql: any = async () => [row('name', 'Sudadera')]
    const out = await localizePublishedHits(sql, [h1, h2], 'es')
    expect(out[0].product.name).toBe('Sudadera')
    expect(out[0].product.price).toBe(9500)
    expect(out[1]).toBe(h2)
    expect(await localizePublishedHits(sql, [h1, h2], 'en')).toEqual([h1, h2])
  })
  test('translatableSource is what completeness is measured against', () => {
    expect(Object.keys(translatableSource(snap())).sort()).toEqual([...PRODUCT_TRANSLATABLE_FIELDS].sort())
  })
})

describe('enabled locales come from i18n.config first, then the legacy list, then defaults', () => {
  const sqlWith = (rows: any[]): any => async () => rows
  test('i18n.config wins', async () => {
    const l = await getEnabledLocales(sqlWith([
      { key: 'i18n.config', value: { enabledLocales: ['en', 'es', 'de'] } },
      { key: 'i18n.locales', value: ['en', 'fr'] },
    ]))
    expect(l).toEqual(['en', 'es', 'de'])
  })
  test('legacy list is used only when i18n.config is absent', async () => {
    expect(await getEnabledLocales(sqlWith([{ key: 'i18n.locales', value: ['fr'] }]))).toEqual(['en', 'fr'])
  })
  test('nothing stored or a database error gives all ten shipped locales', async () => {
    expect((await getEnabledLocales(sqlWith([]))).length).toBe(10)
    expect((await getEnabledLocales((async () => { throw new Error('x') }) as any)).length).toBe(10)
  })
})
