// PDP / Shop rendering: the coded catalog (flag OFF) renders byte-identically to the golden
// fixtures captured from the ORIGINAL components, and Admin-managed data renders through the
// same template with the CMS-only behaviours (single colour hides the selector, canonical price,
// focal points, section visibility, shared gallery vs hero).
import fs from 'fs'
import path from 'path'
import { loadTsxFile, renderPdp, defaultMocks } from './pdp-render-harness'
import { getProductBySlug, getVisibleProducts } from '@/data/products'
import { buildPublicProduct } from '../product-public-shape'
import { emptySnapshot, emptySlot, type ProductSnapshot } from '../product-model'
import { FALLBACK_PRODUCT_DEFAULTS } from '../product-defaults'

const FIX = path.join(__dirname, 'fixtures')
const golden = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8')

const { PDPClient } = loadTsxFile('app/products/[slug]/PDPClient.tsx')
const { ShopClient } = loadTsxFile('components/shop/ShopClient.tsx')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

describe('flag OFF: coded catalog renders exactly as before', () => {
  for (const slug of ['kvrn-heavyweight-hoodie', 'kvrn-heavyweight-sweatpants', 'kvrn-phantom-hoodie', 'kvrn-phantom-sweatpants']) {
    test(`PDP ${slug} matches the golden fixture`, () => {
      const product = getProductBySlug(slug)!
      const related = product.relatedProductSlug ? getProductBySlug(product.relatedProductSlug)! : null
      expect(renderPdp(PDPClient, { product, relatedProduct: related })).toBe(golden(`pdp-golden-${slug}.html`))
    })
  }
  for (const type of [null, 'hoodies', 'sweatpants'] as const) {
    test(`Shop ${type ?? 'all'} matches the golden fixture`, () => {
      const html = renderToStaticMarkup(React.createElement(ShopClient, { products: getVisibleProducts(), type }))
      expect(html).toBe(golden(`shop-golden-${type ?? 'all'}.html`))
    })
  }
})
