// Pure (no DB) coverage of the product CMS: model validators, SKU rules, price formatting,
// public-shape mapping, SEO/JSON-LD, defaults parsing, and CMS rendering through the real PDPClient.
import { loadTsxFile, renderPdp } from './pdp-render-harness'
import {
  emptySnapshot, emptySlot, validateCountryCode, validateHsCode, isValidSlug, slugify, parseFocal,
  parseSnapshotInput, colorSelectorVisible, snapshotAssetIds, type ProductSnapshot, type ColorDef,
} from '../product-model'
import { buildVariantSku, colorCodeFromName, generateVariants, variantIssues, newColor } from '../product-variants'
import { formatProductPrice, sumPriceCents } from '../product-price'
import { objectPositionFor, resolveRefUrl } from '../product-images'
import { buildPublicProduct, buildSizes } from '../product-public-shape'
import { buildProductJsonLd, buildProductMetadata, jsonLdString, parseGlobalSeo } from '../product-seo'
import { parseProductDefaults, FALLBACK_PRODUCT_DEFAULTS } from '../product-defaults'
import { toProductError, ProductBlockedError, ProductInputError } from '../product-service'

const { PDPClient } = loadTsxFile('app/products/[slug]/PDPClient.tsx')

const slot = (src: string, focal: any = { mobile: null, desktop: null }) => ({ ref: { kind: 'static' as const, src }, alt: '', focal })

function cmsSnapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  const s = emptySnapshot({ name: 'Test Crew', slug: 'test-crew', productType: 'crewnecks' })
  s.shortDescription = 'A crew.'
  s.colors = [{ key: 'black', code: 'BLK', name: 'Black', hex: '#000000', media: null }]
  s.media.hero = slot('/images/hero-x.jpg', { mobile: { x: 0.2, y: 0.4 }, desktop: { x: 0.7, y: 0.1 } })
  s.media.gallery = [1, 2, 3, 4, 5].map(i => slot(`/images/g${i}.jpg`))
  return Object.assign(s, over)
}
const variants = (sizes = ['S', 'M', 'L']) => sizes.map((size, i) => ({ sku: `KVRN-TC-BLK-${size}`, size, sizeSort: i + 1, colorCode: 'BLK', active: true }))
const build = (s: ProductSnapshot, price = 9500, extra: any = {}) =>
  buildPublicProduct({ id: 'p-1', snapshot: s, priceCents: price, productCode: 'TC', variants: variants(), assets: {}, ...extra })!

describe('model validators', () => {
  test('country of origin: optional, ISO alpha-2, never defaulted', () => {
    expect(validateCountryCode(undefined)).toEqual({ ok: true, value: null })
    expect(validateCountryCode('')).toEqual({ ok: true, value: null })
    expect(validateCountryCode('us')).toEqual({ ok: true, value: 'US' })
    expect(validateCountryCode('USA').ok).toBe(false)
    expect(validateCountryCode('1A').ok).toBe(false)
  })
  test('HS code: 6-10 digits, dots optional', () => {
    expect(validateHsCode('6110.20')).toEqual({ ok: true, value: '6110.20' })
    expect(validateHsCode('611020')).toEqual({ ok: true, value: '611020' })
    expect(validateHsCode('6110.20.20.10')).toEqual({ ok: true, value: '6110.20.20.10' })
    expect(validateHsCode('61')).toMatchObject({ ok: false })
    expect(validateHsCode('abcdef')).toMatchObject({ ok: false })
    expect(validateHsCode(null)).toEqual({ ok: true, value: null })
  })
  test('slug rules and slugify', () => {
    expect(isValidSlug('good-slug-1')).toBe(true)
    for (const bad of ['Bad', 'a--b', '-a', 'a-', 'a b', '']) expect(isValidSlug(bad)).toBe(false)
    expect(slugify('KVRN Heavyweight Hoodie!')).toBe('kvrn-heavyweight-hoodie')
  })
  test('focal points are clamped to 0..1 and independent per viewport', () => {
    expect(parseFocal({ x: 2, y: -1 })).toEqual({ x: 1, y: 0 })
    expect(parseFocal({ x: 'a', y: 1 })).toBeNull()
    expect(parseFocal(null)).toBeNull()
  })
  test('parse input rejects non-objects and returns a well-formed snapshot', () => {
    expect(parseSnapshotInput(null).ok).toBe(false)
    const r = parseSnapshotInput(cmsSnapshot())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.snapshot.media.gallery.length).toBe(5)
  })
  test('parse input rejects an invalid HS code and country', () => {
    const s: any = cmsSnapshot()
    s.commerce.hsCode = 'zzz'
    s.commerce.originCountry = 'USA'
    const r = parseSnapshotInput(s)
    expect(r.ok).toBe(false)
  })
  test('colour selector is visible only for more than one colour', () => {
    expect(colorSelectorVisible([1])).toBe(false)
    expect(colorSelectorVisible([1, 2])).toBe(true)
  })
  test('media asset ids are collected from hero, gallery and per-colour media', () => {
    const s = cmsSnapshot()
    s.media.hero = { ref: { kind: 'media', assetId: '11111111-1111-4111-8111-111111111111' }, alt: '', focal: { mobile: null, desktop: null } }
    s.media.gallery[0] = { ref: { kind: 'media', assetId: '22222222-2222-4222-8222-222222222222' }, alt: '', focal: { mobile: null, desktop: null } }
    expect(snapshotAssetIds(s).sort()).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
  })
})

describe('variants and SKUs', () => {
  test('new SKUs carry the KVRN- prefix (frozen reserve_inventory requires it)', () => {
    expect(buildVariantSku('TC', 'BLK', 'M')).toBe('KVRN-TC-BLK-M')
    expect(buildVariantSku('tc', 'blk', 'xl')).toBe('KVRN-TC-BLK-XL')
  })
  test('colour codes derive from the name and stay unique', () => {
    expect(colorCodeFromName('Black')).toMatch(/^[A-Z0-9]{2,4}$/)
    const a = newColor('Black', '#000000', [])
    const b = newColor('Black', '#111111', [a])
    expect(b.code).not.toBe(a.code)
    expect(b.key).not.toBe(a.key)
  })
  test('colour x size generation covers the full matrix', () => {
    const colors: ColorDef[] = [newColor('Black', '#000000', []), newColor('Cream', '#eeeedd', [])]
    const v = generateVariants({ productCode: 'TC', colors, sizes: ['S', 'M', 'L'] })
    expect(v).toHaveLength(6)
    expect(new Set(v.map(x => x.sku)).size).toBe(6)
    expect(v.every(x => x.sku.startsWith('KVRN-TC-'))).toBe(true)
  })
  test('regeneration never renames or recreates an existing SKU', () => {
    const colors = [newColor('Black', '#000000', [])]
    const existing = [{ id: 'abc', sku: 'KVRN-HOODIE-BLK-M', colorCode: colors[0].code, size: 'M', sizeSort: 2, active: true }]
    const v = generateVariants({ productCode: 'TC', colors, sizes: ['S', 'M'], existing })
    expect(v.find(x => x.size === 'M')).toEqual(existing[0])
    expect(v.find(x => x.size === 'S')!.sku).toBe(`KVRN-TC-${colors[0].code}-S`)
  })
  test('variantIssues flags duplicates, missing SKUs and a wrong prefix', () => {
    const base = { id: null, colorCode: 'BLK', size: 'S', sizeSort: 1, active: true }
    const issues = variantIssues('TC', [
      { ...base, sku: 'KVRN-TC-BLK-S' }, { ...base, sku: 'KVRN-TC-BLK-S', size: 'M' }, { ...base, sku: '', size: 'L' },
    ])
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.some(i => i.code === 'SKU_REQUIRED')).toBe(true)
  })
  test('only active variants produce sizes; deactivated sizes are not offered', () => {
    const v = [...variants(['S', 'M', 'L'])]
    v[1] = { ...v[1], active: false }
    expect(buildSizes(v).map(s => s.label)).toEqual(['S', 'L'])
  })
})

describe('price formatting: unknown money is never $0', () => {
  test('formats canonical cents', () => {
    expect(formatProductPrice(8000)).toBe('$80')
    expect(formatProductPrice(7950)).toBe('$79.50')
  })
  test('null / zero / negative are "Price not set"', () => {
    for (const v of [null, undefined, 0, -5, NaN]) expect(formatProductPrice(v as any)).toBe('Price not set')
  })
  test('a set total is unknown when any component is unknown', () => {
    expect(sumPriceCents(8000, 8000)).toBe(16000)
    expect(sumPriceCents(8000, 0)).toBeNull()
    expect(sumPriceCents(8000, null)).toBeNull()
  })
})

describe('public product shape', () => {
  test('price is the canonical price, not the snapshot intent', () => {
    const s = cmsSnapshot(); s.commerce.priceCents = 1234
    expect(build(s, 9500).price).toBe(9500)
  })
  test('no colours or no images means not renderable', () => {
    const s = cmsSnapshot(); s.colors = []
    expect(buildPublicProduct({ id: 'x', snapshot: s, priceCents: 100, variants: [], assets: {} })).toBeNull()
    const s2 = cmsSnapshot(); s2.media.gallery = []
    expect(buildPublicProduct({ id: 'x', snapshot: s2, priceCents: 100, variants: variants(), assets: {} })).toBeNull()
  })
  test('hero is independent of the shared gallery', () => {
    const p = build(cmsSnapshot())
    expect(p.heroImage!.src).toBe('/images/hero-x.jpg')
    expect(p.colors[0].images.map(i => i.src)).toEqual([1, 2, 3, 4, 5].map(i => `/images/g${i}.jpg`))
    expect(p.colors[0].images.some(i => i.src === p.heroImage!.src)).toBe(false)
  })
  test('focal points are carried per viewport; null stays null (template default)', () => {
    const p = build(cmsSnapshot())
    expect(p.heroImage!.focalMobile).toEqual({ x: 0.2, y: 0.4 })
    expect(p.heroImage!.focalDesktop).toEqual({ x: 0.7, y: 0.1 })
    expect(p.colors[0].images[0].focalMobile).toBeNull()
  })
  test('all colours share the 5-image gallery when they have no own media', () => {
    const s = cmsSnapshot()
    s.colors.push({ key: 'cream', code: 'CRM', name: 'Cream', hex: '#eeeedd', media: null })
    const p = build(s)
    expect(p.colors[1].images.map(i => i.src)).toEqual(p.colors[0].images.map(i => i.src))
  })
  test('unlisted shop flag maps to hidden; related slug only when set', () => {
    const s = cmsSnapshot(); s.shop.listed = false
    expect(build(s).hidden).toBe(true)
    expect(build(cmsSnapshot()).relatedProductSlug).toBeUndefined()
    expect(build(cmsSnapshot(), 9500, { relatedProductSlug: 'other' }).relatedProductSlug).toBe('other')
  })
  test('shipping & returns: global default unless overridden', () => {
    expect(build(cmsSnapshot()).shippingReturns).toEqual(FALLBACK_PRODUCT_DEFAULTS.shippingReturns)
    const s = cmsSnapshot(); s.shippingReturns = { mode: 'override', lines: ['Custom line'] }
    expect(build(s).shippingReturns!.lines).toEqual(['Custom line'])
  })
  test('focal -> object-position mapping with template defaults', () => {
    expect(objectPositionFor(null, 'center 30%')).toBe('center 30%')
    expect(objectPositionFor({ x: 0.5, y: 0.25 }, 'center 30%')).toBe('50% 25%')
  })
  test('media refs without a known asset do not resolve', () => {
    expect(resolveRefUrl({ kind: 'media', assetId: 'nope' }, {})).toBeNull()
    expect(resolveRefUrl({ kind: 'static', src: '/images/a.jpg' }, {})).toEqual({ src: '/images/a.jpg' })
  })
})

describe('CMS rendering through the real PDPClient', () => {
  const html = (p: any, extra: any = {}) => renderPdp(PDPClient, { product: p, relatedProduct: null, ...extra })
  test('a single-colour product hides the colour selector', () => {
    const out = html(build(cmsSnapshot()))
    expect(out).not.toContain('aria-pressed')
    expect(out).not.toMatch(/>Color</)
  })
  test('a two-colour product shows the colour selector', () => {
    const s = cmsSnapshot()
    s.colors.push({ key: 'cream', code: 'CRM', name: 'Cream', hex: '#eeeedd', media: null })
    const out = html(build(s))
    expect(out).toContain('aria-label="Cream"')
    expect(out).toMatch(/>Color</)
  })
  test('canonical price is shown on the page; an unset price is never $0', () => {
    expect(html(build(cmsSnapshot(), 9500))).toContain('$95')
    const unset = html(build(cmsSnapshot(), 0))
    expect(unset).toContain('Price not set')
    expect(unset).not.toContain('$0')
  })
  test('hero focal points and the hero image render independent of the gallery', () => {
    const out = html(build(cmsSnapshot()))
    expect(out).toContain('/images/hero-x.jpg')
    expect(out).toContain('object-position:70% 10%')   // hero desktop focal
    expect(out).toContain('object-position:20% 40%')   // hero mobile focal
    // Stage 2/3 gallery images (focal null) keep the template defaults
    expect(out).toContain('object-position:center 30%')
    expect(out).toContain('object-position:center top')
  })
  test('hidden sections are not rendered', () => {
    const s = cmsSnapshot(); s.sections.description = false
    s.description = 'UNIQUE-DESCRIPTION-TEXT'
    const on = html(build(cmsSnapshot({ description: 'UNIQUE-DESCRIPTION-TEXT' })))
    const off = html(build(s))
    expect(on).toContain('UNIQUE-DESCRIPTION-TEXT')
    expect(off).not.toContain('UNIQUE-DESCRIPTION-TEXT')
  })
  test('preview mode renders without throwing', () => {
    expect(() => html(build(cmsSnapshot()), { preview: true })).not.toThrow()
  })
  test('Complete the Set uses product types and canonical prices, not name parsing', () => {
    const a = build(cmsSnapshot(), 9500)
    const bs = cmsSnapshot({ name: 'Zeta Pant', slug: 'zeta-pant', productType: 'pants' })
    const b = buildPublicProduct({ id: 'p-2', snapshot: bs, priceCents: 7000, productCode: 'ZP', variants: variants(), assets: {} })!
    const out = renderPdp(PDPClient, { product: { ...a, relatedProductSlug: 'zeta-pant' }, relatedProduct: b })
    expect(out).toContain('Zeta Pant')
    expect(out).toContain('$165')
  })
})

describe('SEO and JSON-LD', () => {
  const p = build(cmsSnapshot())
  test('availability is omitted when unknown', () => {
    const ld = buildProductJsonLd({ product: p, origin: 'https://x.test', imageUrls: [], availability: null }) as any
    expect(ld.offers.availability).toBeUndefined()
    expect(ld.offers.price).toBe('95.00')
  })
  test('availability is included when known', () => {
    const ld = buildProductJsonLd({ product: p, origin: null, imageUrls: ['/images/a.jpg'], availability: 'InStock' }) as any
    expect(ld.offers.availability).toBe('https://schema.org/InStock')
    expect(ld.image).toEqual(['/images/a.jpg'])
  })
  test('no offer is emitted for an unset price', () => {
    const ld = buildProductJsonLd({ product: build(cmsSnapshot(), 0), origin: null, imageUrls: [], availability: null }) as any
    expect(ld.offers).toBeUndefined()
  })
  test('JSON-LD is safe to embed in a script tag', () => {
    const s = jsonLdString({ name: '</script><script>alert(1)</script>' })
    expect(s).not.toContain('</script>')
    expect(JSON.parse(s).name).toBe('</script><script>alert(1)</script>')
  })
  test('metadata falls back to global defaults and uses the canonical URL', () => {
    const m = buildProductMetadata({ product: p, origin: 'https://x.test', global: parseGlobalSeo({ defaultDescription: 'Global desc', defaultOgImage: '/images/og.jpg' }) })
    expect((m.alternates as any).canonical).toBe('https://x.test/products/test-crew')
    expect((m.openGraph as any).images[0].url).toBe('/images/og.jpg')
  })
})

describe('product defaults', () => {
  test('valid input is normalised; blank link falls back', () => {
    const r = parseProductDefaults({ shippingReturns: { lines: [' a ', '', 'b'], linkLabel: '', href: '' } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.shippingReturns.lines).toEqual(['a', 'b'])
      expect(r.value.shippingReturns.href).toBe('/support/shipping-returns')
    }
  })
  test('rejects external or traversal links and empty content', () => {
    for (const href of ['//evil.test', 'https://evil.test', '/a/../b']) {
      expect(parseProductDefaults({ shippingReturns: { lines: ['x'], linkLabel: 'l', href } }).ok).toBe(false)
    }
    expect(parseProductDefaults({ shippingReturns: { lines: [], linkLabel: '', href: '' } }).ok).toBe(false)
    expect(parseProductDefaults(null).ok).toBe(false)
  })
})

describe('service error mapping', () => {
  test('blocked and input errors map to structured responses', () => {
    const b = toProductError(new ProductBlockedError([{ code: 'X', message: 'm' }] as any, []))
    expect(b).toBeDefined()
    const i = toProductError(new ProductInputError(['bad']))
    expect(i).toBeDefined()
  })
})
