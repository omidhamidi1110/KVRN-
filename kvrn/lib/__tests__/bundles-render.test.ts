// Server-rendered markup for the bundle ("Complete the Set") UI, using the repo's TSX render harness
// (no jsdom: effects and click handlers do not run here, so these tests cover what is rendered, not
// interaction). Interaction logic lives in pure modules covered by bundle-pure.test.ts.
import fs from 'fs'
import path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadTsxFile, renderPdp, defaultMocks } from './pdp-render-harness'
import { getProductBySlug } from '@/data/products'
import { emptyBundle } from '../bundle-model'
import { bundleGroups } from '../bundle-cart'
import type { PublicBundle } from '../bundle-types'
import type { CartItem } from '@/types'

const FIX = path.join(__dirname, 'fixtures')
const golden = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8')

const addBundle = jest.fn(); const openCart = jest.fn()
const mocks = () => defaultMocks({ '@/context/CartContext': { useCart: () => ({ addItem: () => {}, addBundle, openCart }) } })
const { PDPClient } = loadTsxFile('app/products/[slug]/PDPClient.tsx', mocks())
const { CompleteTheSetBundle } = loadTsxFile('components/product/CompleteTheSetBundle.tsx', mocks())
const { BagBundleGroup } = loadTsxFile('components/cart/BagBundleGroup.tsx', mocks())

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
function pb(over: Partial<PublicBundle> = {}, soldOutB = false): PublicBundle {
  const comp = (productId: string, isOwner: boolean, name: string, price: number, s: string, avail: number) => ({
    productId, isOwner, name, slug: s, href: `/products/${s}`, priceCents: price, viewSeparately: !isOwner,
    image: { src: `/img/${s}.webp`, alt: name },
    colors: [{ code: 'black', name: 'Black', hex: '#111111', image: { src: `/img/${s}.webp`, alt: name } }],
    variants: ['S', 'M'].map((size, i) => ({ sku: `KVRN-${s}-${size}`, size, sizeSort: i, colorCode: 'black', colorName: 'Black', available: avail })),
    available: avail > 0,
  })
  return {
    bundleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerProductId: A, revision: 1, mode: 'fixed_discount', value: 1500, includeOwner: true,
    presentation: { eyebrow: null, headline: null, supportingCopy: 'Cut to match.', ctaLabel: null, sectionVisible: true },
    components: [comp(A, true, 'Owner Hoodie', 9000, 'owner', 4), comp(B, false, 'Matching Pant', 6000, 'pant', soldOutB ? 0 : 4)],
    ...over,
  }
}

describe('PDP', () => {
  const product = getProductBySlug('kvrn-phantom-hoodie')!
  const related = getProductBySlug(product.relatedProductSlug!)!

  test('without a bundle prop the markup is byte-identical to the golden fixture', () => {
    expect(renderPdp(PDPClient, { product, relatedProduct: related })).toBe(golden('pdp-golden-kvrn-phantom-hoodie.html'))
    expect(renderPdp(PDPClient, { product, relatedProduct: related, bundle: null })).toBe(golden('pdp-golden-kvrn-phantom-hoodie.html'))
  })
  test('with a bundle the set section replaces the pairing block', () => {
    const html = renderPdp(PDPClient, { product, relatedProduct: related, bundle: pb() })
    expect(html).toContain('data-bundle-section="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"')
    expect(html).toContain('Matching Pant')
    expect(html).not.toBe(golden('pdp-golden-kvrn-phantom-hoodie.html'))
  })
  test('a bundle whose section is hidden falls back to the coded pairing, unchanged', () => {
    const b = pb(); b.presentation.sectionVisible = false
    expect(renderPdp(PDPClient, { product, relatedProduct: related, bundle: b })).toBe(golden('pdp-golden-kvrn-phantom-hoodie.html'))
  })
})

describe('CompleteTheSetBundle', () => {
  const render = (b: PublicBundle, preview = false) => renderToStaticMarkup(React.createElement(CompleteTheSetBundle, { bundle: b, preview }))

  test('shows default wording, each component with price and sizes, and the set price', () => {
    const h = render(pb())
    expect(h).toContain('Complete the Set')                      // default eyebrow
    expect(h).toContain('Designed to be worn together.')         // default headline
    expect(h).toContain('Cut to match.')
    expect(h).toContain('Owner Hoodie'); expect(h).toContain('Matching Pant')
    expect(h).toContain('$90<'); expect(h).toContain('$60<'); expect(h).toContain('$150<'); expect(h).toContain('$135<')
    expect(h).toContain('Select your size')                      // nothing chosen yet
  })
  test('the add button is disabled until a size is chosen for every product', () => {
    const h = render(pb())
    expect(h).toMatch(/<button[^>]*disabled[^>]*data-bundle-cta/)
  })
  test('uses the Admin wording when set', () => {
    const b = pb(); b.presentation = { ...b.presentation, eyebrow: 'Matching set', headline: 'Wear both.', ctaLabel: 'Get the pair' }
    const h = render(b)
    expect(h).toContain('Matching set'); expect(h).toContain('Wear both.')
  })
  test('a sold-out component shows Sold out and the set cannot be added', () => {
    const h = render(pb({}, true))
    expect(h).toContain('Sold out')
    expect(h).toContain('Currently unavailable')
  })
  test('"View separately" links appear only for components that allow it', () => {
    const h = render(pb())
    expect(h).toContain('View Matching Pant separately')
    expect(h).not.toContain('View Owner Hoodie separately')
  })
  test('preview mode never enables the button', () => {
    expect(render(pb(), true)).toMatch(/<button[^>]*disabled[^>]*data-bundle-cta/)
  })
})

describe('BagBundleGroup', () => {
  const line = (id: string, name: string, price: number, net: number): CartItem => ({
    cartItemId: `bundle:b:${id}`, productId: id, productName: name, slug: id, color: 'black', colorName: 'Black', colorHex: '#111111',
    size: 'M' as any, sku: `KVRN-${id}-M`, price, quantity: 1, availableQuantity: 5, image: '',
    bundle: { bundleId: 'b', title: 'Wear both.', lineCount: 2, netUnitCents: net, setNetCents: 13500, setSubtotalCents: 15000, componentProductId: id },
  } as CartItem)
  test('renders the set as one group with the net price and the saving', () => {
    const g = bundleGroups([line('a', 'Owner Hoodie', 9000, 8100), line('b', 'Matching Pant', 6000, 5400)])[0]
    const html = renderToStaticMarkup(React.createElement(BagBundleGroup, {
      group: g, formatPrice: (c: number) => `$${(c / 100).toFixed(2)}`, onRemove: () => {}, onQuantity: () => {} }))
    expect(html).toContain('Wear both.')
    expect(html).toContain('$135.00')
    expect(html).toContain('Owner Hoodie'); expect(html).toContain('Matching Pant')
    expect(html).toContain('$15.00')                              // amount saved
    expect((html.match(/Remove/gi) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})

describe('Product Editor BundleSection', () => {
  const shared = {
    IssueList: ({ issues }: any) => React.createElement('ul', { 'data-issues': issues.length }, issues.map((i: any) => React.createElement('li', { key: i.code }, i.message))),
    Toggle: ({ label, checked }: any) => React.createElement('label', null, label, React.createElement('input', { type: 'checkbox', checked: !!checked, readOnly: true })),
    textareaClass: '',
  }
  // Minimal stand-ins for the Admin primitives (they only add styling); labels and text are kept.
  const h = React.createElement
  const ui = {
    AdminButton: ({ children }: any) => h('button', null, children),
    AdminCard: ({ children, title }: any) => h('section', null, title ? h('h3', null, title) : null, children),
    AdminField: ({ label, children, hint }: any) => h('div', null, h('label', null, label), hint ? h('small', null, hint) : null, children),
    AdminNotice: ({ children, title }: any) => h('div', null, title ? h('b', null, title) : null, children),
    AdminSectionHeader: ({ title }: any) => h('h2', null, title),
    AdminFieldGrid: ({ children }: any) => h('div', null, children),
    StatusBadge: ({ label, status }: any) => h('span', null, label ?? status),
    adminInputClass: '', adminSelectClass: '',
  }
  const { BundleSection } = loadTsxFile('app/admin/products/[id]/BundleSection.tsx', {
    ...mocks(), './editor-shared': shared, '@/components/admin/ui/AdminUI': ui,
    '@/components/admin/ui/InfoTip': { InfoTip: ({ children }: any) => h('span', null, children) },
  })
  const render = (bundle: any, issues: any[] = [], locked = false) => renderToStaticMarkup(React.createElement(BundleSection, {
    snap: { bundle, commerce: { priceCents: 9000, variants: [] }, name: 'Owner Hoodie' }, update: () => {}, state: { id: A, status: 'draft', canonical: { priceCents: 9000, variants: [] }, snapshot: {}, published: null }, issues, locked }))

  test('off by default: shows the master switch and no component picker', () => {
    const out = render(null)
    expect(out).toContain('Offer a set on this product’s page')
    expect(out).not.toContain('Price rule')
  })
  test('on: shows the pricing rule, wording fields and the preview region', () => {
    const h = render({ ...emptyBundle(), enabled: true })
    expect(h).toContain('Price rule')
    expect(h).toContain('Headline'); expect(h).toContain('Button label')
    expect(h).toContain('Show the set section on the page')
    expect(h).toContain('Set preview')
  })
  test('publish problems are listed in the open', () => {
    const h = render({ ...emptyBundle(), enabled: true }, [{ code: 'BUNDLE_NO_COMPONENTS', field: 'bundle.components', message: 'Add at least one product to the set.' }])
    expect(h).toContain('Add at least one product to the set.')
  })
})
