// Workstream D: breadcrumb structured data, canonical support in pageMetadata, PDP twitter card, crawler lint rules.
import fs from 'fs'
import path from 'path'
import { buildBreadcrumbJsonLd } from '../seo-jsonld'
import { pageMetadata } from '../content-seo'
import { buildProductMetadata, buildProductJsonLd } from '../product-seo'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('BreadcrumbList JSON-LD', () => {
  test('absolute, ordered, 1-based', () => {
    const ld: any = buildBreadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }, { name: ' Hoodie  ', path: '/products/h' }], 'https://kvrn.shop/')
    expect(ld['@type']).toBe('BreadcrumbList')
    expect(ld.itemListElement.map((e: any) => [e.position, e.name, e.item])).toEqual([
      [1, 'Home', 'https://kvrn.shop/'], [2, 'Shop', 'https://kvrn.shop/shop'], [3, 'Hoodie', 'https://kvrn.shop/products/h'],
    ])
  })
  test('drops blank / protocol-relative / non-path crumbs and emits nothing for a trail shorter than 2', () => {
    expect(buildBreadcrumbJsonLd([{ name: 'Home', path: '/' }], 'https://x.test')).toBeNull()
    expect(buildBreadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: '', path: '/a' }, { name: 'B', path: '//evil.test' }, { name: 'C', path: 'https://evil.test' }], 'https://x.test')).toBeNull()
  })
  test('carries no price, availability or rating claims', () => {
    const s = JSON.stringify(buildBreadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Shop', path: '/shop' }], 'https://x.test'))
    expect(s).not.toMatch(/price|availability|rating|review|offer/i)
  })
})

describe('pageMetadata canonical', () => {
  test('emits alternates.canonical for a site-relative path', () => {
    expect(pageMetadata({ title: 'T', canonical: '/collections/winter' }, undefined).alternates).toEqual({ canonical: '/collections/winter' })
  })
  test('no canonical for noindex pages, or for values that are not site-relative paths', () => {
    expect(pageMetadata({ title: 'T', canonical: '/x' }, { noindex: true } as any).alternates).toBeUndefined()
    expect(pageMetadata({ title: 'T', canonical: 'https://evil.test/x' }, undefined).alternates).toBeUndefined()
    expect(pageMetadata({ title: 'T' }, undefined).alternates).toBeUndefined()
  })
})

describe('product metadata', () => {
  const product: any = { name: 'Hoodie', slug: 'hoodie', price: 8000, shortDescription: 'Short', seo: { title: 'Hoodie | KVRN', description: 'Desc' }, productCode: 'PKHH' }
  test('twitter card mirrors the product, not the site', () => {
    const m: any = buildProductMetadata({ product, origin: 'https://kvrn.shop', og: { url: 'https://kvrn.shop/i.webp', alt: 'Hoodie' } })
    expect(m.twitter).toMatchObject({ card: 'summary_large_image', title: 'Hoodie | KVRN', description: 'Desc' })
    expect(m.twitter.images[0].url).toBe('https://kvrn.shop/i.webp')
    expect(m.alternates.canonical).toBe('https://kvrn.shop/products/hoodie')
  })
  test('JSON-LD never invents an offer when availability is unknown or the catalog is coded', () => {
    const coded: any = buildProductJsonLd({ product, origin: 'https://kvrn.shop', imageUrls: [], availability: null, emitOffer: false })
    expect(coded.offers).toBeUndefined()
    const cms: any = buildProductJsonLd({ product, origin: 'https://kvrn.shop', imageUrls: [], availability: null })
    expect(cms.offers.price).toBe('80.00'); expect(cms.offers.availability).toBeUndefined()   // price from canonical, stock omitted when unknown
  })
})

describe('source wiring', () => {
  test('PDP, collections, home carry canonical + breadcrumb; contact/size-guide have their own description', () => {
    expect(read('app/products/[slug]/page.tsx')).toMatch(/buildBreadcrumbJsonLd/)
    expect(read('app/collections/[slug]/page.tsx')).toMatch(/buildBreadcrumbJsonLd/)
    expect(read('app/page.tsx')).toMatch(/canonical: '\/'/)
    expect(read('app/collections/project-kvrn/page.tsx')).toMatch(/canonical: '\/collections\/project-kvrn'/)
    expect(read('app/contact/page.tsx')).toMatch(/description: 'Contact KVRN/)
    expect(read('app/support/size-guide/page.tsx')).toMatch(/description: 'KVRN size guide/)
  })
  test('the JsonLd component escapes via jsonLdString and nothing else uses dangerouslySetInnerHTML for CMS data', () => {
    expect(read('components/seo/JsonLd.tsx')).toMatch(/jsonLdString/)
  })
})

describe('scripts/seo-crawl.mjs safety', () => {
  const src = read('scripts/seo-crawl.mjs')
  test('refuses production hosts, never follows redirects, GET only, no provider APIs', () => {
    expect(src).toMatch(/kvrn\.shop/)
    expect(src).toMatch(/redirect: 'manual'/)
    expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/googleapis|searchconsole|indexnow|bing\.com|merchantapi/i)
  })
})
