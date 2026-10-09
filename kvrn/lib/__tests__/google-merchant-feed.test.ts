// Merchant feed: default output unchanged; optional owner-supplied apparel attributes are validated, never guessed.
import { makeMerchantProductFeed, sanitizeMerchantOptions } from '../google-merchant-feed'

const entry = (id = 'p1', slug = 'kvrn-hoodie'): any => ({
  productId: id, slug, availability: 'InStock', imageUrls: ['/images/products/x/1.webp'], ogImage: null,
  product: { name: 'KVRN Hoodie', description: 'Heavyweight hoodie', shortDescription: '', price: 15000, hidden: false },
})
const ORIGIN = 'https://kvrn.shop'

describe('merchant feed options', () => {
  test('default feed has no gender / age_group / google_product_category (nothing invented)', () => {
    const { xml, included } = makeMerchantProductFeed([entry()], ORIGIN)
    expect(included).toBe(1)
    expect(xml).not.toMatch(/g:gender|g:age_group|g:google_product_category/)
    expect(xml).toContain('<g:price>150.00 USD</g:price>')
  })
  test('the same call with undefined / empty options is byte-identical', () => {
    const base = makeMerchantProductFeed([entry()], ORIGIN).xml
    expect(makeMerchantProductFeed([entry()], ORIGIN, {}).xml).toBe(base)
    expect(makeMerchantProductFeed([entry()], ORIGIN, { gender: '', ageGroup: null, googleProductCategory: '  ' }).xml).toBe(base)
  })
  test('valid owner values are emitted', () => {
    const { xml } = makeMerchantProductFeed([entry()], ORIGIN, { gender: 'Unisex', ageGroup: 'adult', googleProductCategory: 'Apparel & Accessories > Clothing > Activewear' })
    expect(xml).toContain('<g:gender>unisex</g:gender>')
    expect(xml).toContain('<g:age_group>adult</g:age_group>')
    expect(xml).toContain('<g:google_product_category>Apparel &amp; Accessories &gt; Clothing &gt; Activewear</g:google_product_category>')
  })
  test('invalid values are dropped, not coerced', () => {
    expect(sanitizeMerchantOptions({ gender: 'mens', ageGroup: 'teen', googleProductCategory: '<script>x</script>' })).toEqual({})
    expect(sanitizeMerchantOptions({ googleProductCategory: '1604' })).toEqual({ googleProductCategory: '1604' })
    expect(sanitizeMerchantOptions({ googleProductCategory: 'a'.repeat(300) })).toEqual({})
  })
  test('the route reads only the three documented env names', () => {
    const fs = require('fs'), path = require('path')
    const r = fs.readFileSync(path.join(__dirname, '../../app/feeds/google-products.xml/route.ts'), 'utf8')
    for (const k of ['KVRN_MERCHANT_GENDER', 'KVRN_MERCHANT_AGE_GROUP', 'KVRN_MERCHANT_GOOGLE_CATEGORY']) expect(r).toContain(k)
  })
})
