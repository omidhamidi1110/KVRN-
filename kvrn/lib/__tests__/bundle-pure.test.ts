// lib/__tests__/bundle-pure.test.ts
//
// Pure (no database) tests for the bundle feature: price math, model parsing, cart helpers and
// reducer, checkout request parsing, quote logic over facts, the editor preview and value inputs.
import {
  priceBundle, computeSetDiscount, allocateDiscount, verifyAllocation, formatCents, describeRule,
  MAX_SET_QUANTITY, MAX_BUNDLE_COMPONENTS,
} from '../bundle-pricing'
import { parseBundleInput, emptyBundle, bundleStructureIssues, bundleMemberIds, translatableBundleSource, BUNDLE_TRANSLATABLE_FIELDS } from '../bundle-model'
import {
  bundleGroups, dropIncompleteBundles, splitCartForCheckout, effectiveUnitCents, cartSubtotalCents,
  buildBundleCartLines, priceSelection, maxSetQuantity,
} from '../bundle-cart'
import { cartReducer } from '../cart-reducer'
import { parseBundleRequest, quoteBundle, buildReserveItems, type BundleFacts } from '../bundle-checkout'
import { buildBundlePreview, parseMoneyInput, parsePercentInput, formatValueInput } from '../bundle-preview'
import { parseBundleResumeContext } from '../abandoned-checkout-resume'
import type { CartItem } from '@/types'
import type { PublicBundle } from '../bundle-types'

const comp = (key: string, unitPriceCents: number, sortKey?: string) => ({ key, unitPriceCents, sortKey })

describe('bundle pricing: the three modes', () => {
  const cs = [comp('a', 9000), comp('b', 6000)]

  test('set_price: discount is the difference, net is the value', () => {
    const p = priceBundle({ mode: 'set_price', value: 13500, components: cs }) as any
    expect(p.ok).toBe(true)
    expect(p.setSubtotalCents).toBe(15000)
    expect(p.setDiscountCents).toBe(1500)
    expect(p.setNetCents).toBe(13500)
  })
  test('fixed_discount: value off the subtotal', () => {
    const p = priceBundle({ mode: 'fixed_discount', value: 2500, components: cs }) as any
    expect(p.setNetCents).toBe(12500)
  })
  test('percent_discount: floored to the cent', () => {
    const p = priceBundle({ mode: 'percent_discount', value: 1000, components: [comp('a', 3333), comp('b', 3333)] }) as any
    // 6666 * 10% = 666.6 -> 666
    expect(p.setDiscountCents).toBe(666)
    expect(p.setNetCents).toBe(6000)
  })
  test('a zero discount is allowed (priced at the subtotal)', () => {
    const p = priceBundle({ mode: 'fixed_discount', value: 0, components: cs }) as any
    expect(p.ok).toBe(true)
    expect(p.setDiscountCents).toBe(0)
  })
})

describe('bundle pricing: bounds fail closed', () => {
  const cs = [comp('a', 9000), comp('b', 6000)]
  const code = (r: any) => (r.ok ? 'OK' : r.code)
  test.each([
    ['set_price above subtotal', { mode: 'set_price', value: 15001 }, 'NOT_A_DISCOUNT'],
    ['set_price zero', { mode: 'set_price', value: 0 }, 'NET_TOO_LOW'],
    ['fixed_discount equals subtotal', { mode: 'fixed_discount', value: 15000 }, 'DISCOUNT_TOO_LARGE'],
    ['fixed_discount above subtotal', { mode: 'fixed_discount', value: 99999 }, 'DISCOUNT_TOO_LARGE'],
    ['percent 100%', { mode: 'percent_discount', value: 10000 }, 'DISCOUNT_TOO_LARGE'],
    ['negative value', { mode: 'fixed_discount', value: -1 }, 'INVALID_VALUE'],
    ['fractional value', { mode: 'fixed_discount', value: 10.5 }, 'INVALID_VALUE'],
    ['unknown mode', { mode: 'bogo', value: 1 }, 'INVALID_MODE'],
  ])('%s', (_n, rule, expected) => {
    expect(code(priceBundle({ ...(rule as any), components: cs }))).toBe(expected)
  })
  test('no components, too many, bad price, duplicate key, bad quantity', () => {
    const r = { mode: 'fixed_discount', value: 100 }
    expect(code(priceBundle({ ...r, components: [] }))).toBe('NO_COMPONENTS')
    const many = Array.from({ length: MAX_BUNDLE_COMPONENTS + 1 }, (_, i) => comp('k' + i, 1000))
    expect(code(priceBundle({ ...r, components: many }))).toBe('TOO_MANY_COMPONENTS')
    expect(code(priceBundle({ ...r, components: [comp('a', 0)] }))).toBe('INVALID_COMPONENT_PRICE')
    expect(code(priceBundle({ ...r, components: [comp('a', 100.5)] }))).toBe('INVALID_COMPONENT_PRICE')
    expect(code(priceBundle({ ...r, components: [comp('a', 1000), comp('a', 1000)] }))).toBe('DUPLICATE_KEY')
    expect(code(priceBundle({ ...r, components: cs, setQuantity: 0 }))).toBe('INVALID_QUANTITY')
    expect(code(priceBundle({ ...r, components: cs, setQuantity: MAX_SET_QUANTITY + 1 }))).toBe('INVALID_QUANTITY')
  })
  test('computeSetDiscount rejects a nonsensical subtotal', () => {
    expect((computeSetDiscount('fixed_discount', 1, 0) as any).ok).toBe(false)
  })
})

describe('bundle pricing: largest-remainder allocation', () => {
  test('allocations sum exactly to the discount, for many shapes', () => {
    let n = 0
    for (const prices of [[1, 1, 1], [3333, 3333, 3334], [9999, 1, 1], [1234, 5678, 9012, 3456], [100, 100, 100, 100, 100, 101]]) {
      for (const d of [0, 1, 2, 7, 99, 100]) {
        const sub = prices.reduce((s, x) => s + x, 0)
        if (d > sub) continue
        const comps = prices.map((p, i) => comp('k' + i, p))
        const alloc = allocateDiscount(comps, d)
        expect(alloc.reduce((s, x) => s + x, 0)).toBe(d)
        alloc.forEach((a, i) => { expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(prices[i]) })
        n++
      }
    }
    expect(n).toBeGreaterThan(20)
  })

  test('deterministic: equal remainders break by sortKey, not by input order', () => {
    // three equal prices, discount 1: exactly one gets the cent
    const a = allocateDiscount([comp('c', 100, '3'), comp('a', 100, '1'), comp('b', 100, '2')], 1)
    expect(a).toEqual([0, 1, 0])   // sortKey '1' wins
    const b = allocateDiscount([comp('a', 100, '1'), comp('b', 100, '2'), comp('c', 100, '3')], 1)
    expect(b).toEqual([1, 0, 0])
    // repeat calls give the identical split
    for (let i = 0; i < 5; i++) expect(allocateDiscount([comp('c', 100, '3'), comp('a', 100, '1'), comp('b', 100, '2')], 1)).toEqual(a)
  })

  test('the proportional share favours the dearer component', () => {
    const a = allocateDiscount([comp('hi', 9000), comp('lo', 1000)], 1000)
    expect(a).toEqual([900, 100])
  })

  test('priceBundle reconciles exactly (verifyAllocation) for quantity 1..10', () => {
    for (let q = 1; q <= MAX_SET_QUANTITY; q++) {
      const p = priceBundle({ mode: 'percent_discount', value: 1250, setQuantity: q, components: [comp('a', 7777), comp('b', 3331), comp('c', 1)] }) as any
      expect(p.ok).toBe(true)
      expect(verifyAllocation(p)).toEqual([])
      expect(p.netCents).toBe(p.setNetCents * q)
      expect(p.lines.reduce((s: number, l: any) => s + l.netLineCents, 0)).toBe(p.netCents)
    }
  })

  test('the per-unit split does not depend on quantity', () => {
    const one = priceBundle({ mode: 'fixed_discount', value: 777, components: [comp('a', 5000), comp('b', 3001)] }) as any
    const four = priceBundle({ mode: 'fixed_discount', value: 777, setQuantity: 4, components: [comp('a', 5000), comp('b', 3001)] }) as any
    expect(four.lines.map((l: any) => l.netUnitPriceCents)).toEqual(one.lines.map((l: any) => l.netUnitPriceCents))
  })

  test('verifyAllocation catches a tampered allocation', () => {
    const p = priceBundle({ mode: 'fixed_discount', value: 500, components: [comp('a', 5000), comp('b', 3000)] }) as any
    p.lines[0].allocatedDiscountPerUnitCents += 1
    expect(verifyAllocation(p).length).toBeGreaterThan(0)
  })
})

describe('bundle pricing: labels', () => {
  test('formatCents and describeRule', () => {
    expect(formatCents(14500)).toBe('$145.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(describeRule('percent_discount', 1000)).toBe('10% off')
    expect(describeRule('percent_discount', 1250)).toBe('12.5% off')
    expect(describeRule('fixed_discount', 1500)).toBe('$15.00 off')
    expect(describeRule('set_price', 14500)).toBe('Set price $145.00')
  })
})

describe('bundle model: parseBundleInput', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  test('null / undefined mean no bundle', () => {
    expect(parseBundleInput(undefined)).toEqual({ ok: true, bundle: null })
    expect(parseBundleInput(null)).toEqual({ ok: true, bundle: null })
  })
  test('a well-formed bundle parses, lower-cases ids and de-duplicates variants', () => {
    const r = parseBundleInput({
      enabled: true, includeOwner: true,
      components: [{ productId: U1.toUpperCase(), allowedVariantIds: [U2, U2.toUpperCase()] }],
      pricing: { mode: 'fixed_discount', value: 1500 },
      presentation: { headline: '  Hello  ', sectionVisible: false },
    }) as any
    expect(r.ok).toBe(true)
    expect(r.bundle.components[0].productId).toBe(U1)
    expect(r.bundle.components[0].allowedVariantIds).toEqual([U2])
    expect(r.bundle.presentation.headline).toBe('Hello')
    expect(r.bundle.presentation.sectionVisible).toBe(false)
    expect(r.bundle.pricing).toEqual({ mode: 'fixed_discount', value: 1500 })
  })
  test('rejects malformed input', () => {
    for (const bad of [
      'x', [], { enabled: 'yes' }, { components: 'no' }, { components: [{ productId: 'nope' }] },
      { components: [{ productId: U1 }, { productId: U1 }] }, { pricing: { mode: 'bogo', value: 1 } },
      { pricing: { mode: 'fixed_discount', value: -1 } }, { pricing: { mode: 'percent_discount', value: 10000 } },
      { presentation: { headline: 'x'.repeat(500) } },
      { components: Array.from({ length: 7 }, (_, i) => ({ productId: `${i}1111111-1111-4111-8111-111111111111` })) },
    ]) {
      expect((parseBundleInput(bad) as any).ok).toBe(false)
    }
  })
  test('structure issues are only reported for an enabled bundle', () => {
    const off = emptyBundle()
    expect(bundleStructureIssues(off)).toEqual([])
    const on = { ...emptyBundle(), enabled: true }
    expect(bundleStructureIssues(on).map(i => i.code)).toContain('BUNDLE_NO_COMPONENTS')
    const self = { ...on, components: [{ productId: U1, allowedVariantIds: null, viewSeparately: true }] }
    expect(bundleStructureIssues(self, U1).map(i => i.code)).toContain('BUNDLE_SELF')
  })
  test('members put the owner first; translatable fields are exposed', () => {
    const b = { ...emptyBundle(), components: [{ productId: U2, allowedVariantIds: null, viewSeparately: true }] }
    expect(bundleMemberIds(b, U1)).toEqual([U1, U2])
    expect(bundleMemberIds({ ...b, includeOwner: false }, U1)).toEqual([U2])
    expect([...BUNDLE_TRANSLATABLE_FIELDS]).toEqual(['bundle.eyebrow', 'bundle.headline', 'bundle.supportingCopy', 'bundle.ctaLabel'])
    const src = translatableBundleSource({ ...b, presentation: { ...b.presentation, headline: 'H' } })
    expect(src['bundle.headline']).toBe('H')
    expect(src['bundle.eyebrow']).toBe('')
    expect(translatableBundleSource(null)['bundle.ctaLabel']).toBe('')
  })
})

// ── cart ──────────────────────────────────────────────────────────────────────

const BID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function line(over: Partial<CartItem> & { sku: string }, productId: string, net: number, price: number, lineCount = 2): CartItem {
  return {
    cartItemId: `bundle:${BID}:${productId}`, productId, productName: 'P', slug: 'p', color: 'black', colorName: 'Black',
    colorHex: '#000', size: 'M' as any, price, quantity: 1, availableQuantity: 5, image: '',
    bundle: { bundleId: BID, title: 'Set', lineCount, netUnitCents: net, setNetCents: 13500, setSubtotalCents: 15000, componentProductId: productId },
    ...over,
  } as CartItem
}
const plain = (sku: string, price = 4000, quantity = 1): CartItem => ({
  cartItemId: 'plain-' + sku, productId: 'x', productName: 'Plain', slug: 'plain', color: 'black', colorName: 'Black',
  colorHex: '#000', size: 'M' as any, price, quantity, availableQuantity: 5, image: '', sku,
} as CartItem)

describe('bundle cart helpers', () => {
  const set = () => [line({ sku: 'KVRN-A-M' }, PA, 8100, 9000), line({ sku: 'KVRN-B-M' }, PB, 5400, 6000)]

  test('effective unit price uses the net price inside a set only', () => {
    const [a] = set()
    expect(effectiveUnitCents(a)).toBe(8100)
    expect(effectiveUnitCents(plain('KVRN-P-M'))).toBe(4000)
  })
  test('subtotal sums net lines and plain lines', () => {
    expect(cartSubtotalCents([...set(), plain('KVRN-P-M', 4000, 2)])).toBe(8100 + 5400 + 8000)
  })
  test('groups: complete when all lines are present with one quantity', () => {
    const g = bundleGroups(set())
    expect(g).toHaveLength(1)
    expect(g[0].complete).toBe(true)
    expect(g[0].netCents).toBe(13500)
    expect(g[0].subtotalCents).toBe(15000)
    expect(bundleGroups([set()[0]])[0].complete).toBe(false)
    expect(bundleGroups([set()[0], { ...set()[1], quantity: 2 }])[0].complete).toBe(false)
  })
  test('dropIncompleteBundles keeps plain lines and returns the same array when untouched', () => {
    const only = [plain('KVRN-P-M')]
    expect(dropIncompleteBundles(only)).toBe(only)
    const full = [...set(), plain('KVRN-P-M')]
    expect(dropIncompleteBundles(full)).toBe(full)
    const half = [set()[0], plain('KVRN-P-M')]
    expect(dropIncompleteBundles(half).map(i => i.sku)).toEqual(['KVRN-P-M'])
  })
  test('maxSetQuantity is the smallest line cap within the set limit', () => {
    expect(maxSetQuantity([line({ sku: 'a', availableQuantity: 3 }, PA, 1, 1), line({ sku: 'b', availableQuantity: 7 }, PB, 1, 1)])).toBe(3)
    expect(maxSetQuantity([line({ sku: 'a', availableQuantity: 99 }, PA, 1, 1)])).toBe(MAX_SET_QUANTITY)
  })

  test('splitCartForCheckout: plain bag, bag with a set, and refusals', () => {
    expect(splitCartForCheckout([plain('KVRN-P-M', 4000, 2)])).toEqual({ ok: true, plain: [{ sku: 'KVRN-P-M', quantity: 2 }], bundle: null })
    const ok = splitCartForCheckout([...set(), plain('KVRN-P-M')]) as any
    expect(ok.ok).toBe(true)
    expect(ok.plain).toEqual([{ sku: 'KVRN-P-M', quantity: 1 }])
    expect(ok.bundle.bundleId).toBe(BID)
    expect(ok.bundle.expectedSetNetCents).toBe(13500)
    expect(ok.bundle.selections).toEqual([{ productId: PA, sku: 'KVRN-A-M' }, { productId: PB, sku: 'KVRN-B-M' }])
    // partial set
    expect((splitCartForCheckout([set()[0]]) as any).ok).toBe(false)
    // same sku inside the set and on its own
    expect((splitCartForCheckout([...set(), plain('KVRN-A-M')]) as any).ok).toBe(false)
    // two different sets
    const other = set().map(l => ({ ...l, bundle: { ...l.bundle!, bundleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } }))
    expect((splitCartForCheckout([...set(), ...other]) as any).ok).toBe(false)
  })
})

describe('cart reducer with sets', () => {
  const set = () => [line({ sku: 'KVRN-A-M' }, PA, 8100, 9000), line({ sku: 'KVRN-B-M' }, PB, 5400, 6000)]
  const base = { items: [plain('KVRN-P-M')], isOpen: false }

  test('a cart saved before bundles existed hydrates unchanged (same array)', () => {
    const saved = [plain('KVRN-P-M')]
    expect(cartReducer(base, { type: 'HYDRATE', payload: saved }).items).toBe(saved)
  })
  test('hydrate drops a partial set', () => {
    const r = cartReducer(base, { type: 'HYDRATE', payload: [set()[0], plain('KVRN-P-M')] })
    expect(r.items.map(i => i.sku)).toEqual(['KVRN-P-M'])
  })
  test('ADD_BUNDLE keeps plain lines and replaces an earlier set', () => {
    let s = cartReducer(base, { type: 'ADD_BUNDLE', payload: set() })
    expect(s.items).toHaveLength(3)
    expect(s.isOpen).toBe(true)
    s = cartReducer(s, { type: 'ADD_BUNDLE', payload: set() })
    expect(s.items).toHaveLength(3)
    expect(cartReducer(base, { type: 'ADD_BUNDLE', payload: [plain('x')] })).toBe(base)
  })
  test('removing or changing one set line acts on the whole set', () => {
    const s0 = { items: [...set(), plain('KVRN-P-M')], isOpen: false }
    const removed = cartReducer(s0, { type: 'REMOVE_ITEM', payload: { cartItemId: set()[0].cartItemId } })
    expect(removed.items.map(i => i.sku)).toEqual(['KVRN-P-M'])
    const up = cartReducer(s0, { type: 'UPDATE_QUANTITY', payload: { cartItemId: set()[0].cartItemId, quantity: 3 } })
    expect(up.items.filter(i => i.bundle).map(i => i.quantity)).toEqual([3, 3])
    const over = cartReducer(s0, { type: 'UPDATE_BUNDLE_QUANTITY', payload: { bundleId: BID, quantity: 99 } })
    expect(over.items.filter(i => i.bundle).map(i => i.quantity)).toEqual([5, 5])
    const gone = cartReducer(s0, { type: 'UPDATE_BUNDLE_QUANTITY', payload: { bundleId: BID, quantity: 0 } })
    expect(gone.items.map(i => i.sku)).toEqual(['KVRN-P-M'])
  })
  test('APPLY_BUNDLE_QUOTE rewrites the net prices of the set only', () => {
    const s0 = { items: [...set(), plain('KVRN-P-M')], isOpen: false }
    const r = cartReducer(s0, { type: 'APPLY_BUNDLE_QUOTE', payload: {
      bundleId: BID, setNetCents: 12000, setSubtotalCents: 15000,
      lines: [{ productId: PA, priceCents: 9000, netUnitCents: 7200 }, { productId: PB, priceCents: 6000, netUnitCents: 4800 }],
    } })
    expect(r.items.filter(i => i.bundle).map(i => i.bundle!.netUnitCents)).toEqual([7200, 4800])
    expect(r.items.find(i => !i.bundle)).toBe(s0.items[2])
  })
  test('REFRESH_CAPS with a sold-out set line drops the whole set', () => {
    const s0 = { items: [...set(), plain('KVRN-P-M')], isOpen: false }
    const r = cartReducer(s0, { type: 'REFRESH_CAPS', payload: [{ cartItemId: set()[0].cartItemId, availableQuantity: 0 }] })
    expect(r.items.map(i => i.sku)).toEqual(['KVRN-P-M'])
  })
})

// ── storefront bundle ─────────────────────────────────────────────────────────

function publicBundle(over: Partial<PublicBundle> = {}): PublicBundle {
  const mkComp = (productId: string, isOwner: boolean, price: number, sku: string) => ({
    productId, isOwner, name: isOwner ? 'Owner Tee' : 'Other Pant', slug: 's-' + sku, href: '/products/' + sku, priceCents: price,
    viewSeparately: true, image: null,
    colors: [{ code: 'black', name: 'Black', hex: '#000', image: null }],
    variants: [{ sku, size: 'M', sizeSort: 1, colorCode: 'black', colorName: 'Black', available: 4 }],
    available: true,
  })
  return {
    bundleId: BID, ownerProductId: PA, revision: 1, mode: 'fixed_discount', value: 1500, includeOwner: true,
    presentation: { eyebrow: null, headline: null, supportingCopy: null, ctaLabel: null, sectionVisible: true },
    components: [mkComp(PA, true, 9000, 'KVRN-A-M'), mkComp(PB, false, 6000, 'KVRN-B-M')],
    ...over,
  }
}

describe('storefront cart lines for a set', () => {
  test('builds one line per component at allocated net prices that sum to the set price', () => {
    const lines = buildBundleCartLines(publicBundle(), ['KVRN-A-M', 'KVRN-B-M'], 'Set')!
    expect(lines).toHaveLength(2)
    expect(lines.reduce((s, l) => s + l.bundle!.netUnitCents, 0)).toBe(13500)
    expect(lines.map(l => l.price)).toEqual([9000, 6000])
    expect(lines.every(l => l.bundle!.lineCount === 2)).toBe(true)
  })
  test('fails closed: missing choice, wrong count, sold-out size, unpriceable rule', () => {
    expect(buildBundleCartLines(publicBundle(), ['KVRN-A-M', null], 'Set')).toBeNull()
    expect(buildBundleCartLines(publicBundle(), ['KVRN-A-M'], 'Set')).toBeNull()
    expect(buildBundleCartLines(publicBundle(), ['KVRN-A-M', 'KVRN-NOPE'], 'Set')).toBeNull()
    expect(buildBundleCartLines(publicBundle(), ['KVRN-A-M', 'KVRN-B-M'], 'Set', 5)).toBeNull()   // only 4 available
    expect(buildBundleCartLines(publicBundle({ mode: 'fixed_discount', value: 99999 }), ['KVRN-A-M', 'KVRN-B-M'], 'Set')).toBeNull()
  })
  test('the server quote wins over the page numbers; a disagreeing line set fails closed', () => {
    const q: any = {
      ok: true, bundleId: BID, title: 'T', quantity: 1, setSubtotalCents: 15000, setDiscountCents: 3000, setNetCents: 12000,
      subtotalCents: 15000, discountCents: 3000, netCents: 12000,
      lines: [
        { productId: PA, sku: 'KVRN-A-M', originalUnitPriceCents: 9000, netUnitPriceCents: 7200 },
        { productId: PB, sku: 'KVRN-B-M', originalUnitPriceCents: 6000, netUnitPriceCents: 4800 },
      ],
    }
    const lines = buildBundleCartLines(publicBundle(), ['KVRN-A-M', 'KVRN-B-M'], 'Set', 1, q)!
    expect(lines.map(l => l.bundle!.netUnitCents)).toEqual([7200, 4800])
    expect(lines[0].bundle!.setNetCents).toBe(12000)
    expect(buildBundleCartLines(publicBundle(), ['KVRN-A-M', 'KVRN-B-M'], 'Set', 1, { ...q, lines: [q.lines[0]] })).toBeNull()
  })
  test('priceSelection previews with the shared module', () => {
    const p: any = priceSelection(publicBundle(), ['KVRN-A-M', 'KVRN-B-M'])
    expect(p.ok).toBe(true)
    expect(p.setNetCents).toBe(13500)
  })
})

// ── checkout request + quote over facts ───────────────────────────────────────

describe('parseBundleRequest', () => {
  const ok = { bundleId: BID.toUpperCase(), quantity: 2, selections: [{ productId: PA, sku: 'KVRN-A-M' }, { productId: PB, sku: 'KVRN-B-M' }], expectedSetNetCents: 13500 }
  test('accepts a valid request and normalises ids', () => {
    const r = parseBundleRequest(ok) as any
    expect(r.ok).toBe(true)
    expect(r.req.bundleId).toBe(BID)
    expect(r.req.expectedSetNetCents).toBe(13500)
  })
  test.each([
    ['not an object', 'x'], ['array', []], ['bad bundle id', { ...ok, bundleId: 'x' }],
    ['quantity 0', { ...ok, quantity: 0 }], ['quantity 11', { ...ok, quantity: 11 }], ['fractional quantity', { ...ok, quantity: 1.5 }],
    ['no selections', { ...ok, selections: [] }], ['bad sku prefix', { ...ok, selections: [{ productId: PA, sku: 'EVIL' }] }],
    ['duplicate product', { ...ok, selections: [{ productId: PA, sku: 'KVRN-A-M' }, { productId: PA, sku: 'KVRN-A-L' }] }],
    ['duplicate sku', { ...ok, selections: [{ productId: PA, sku: 'KVRN-A-M' }, { productId: PB, sku: 'KVRN-A-M' }] }],
    ['negative expected', { ...ok, expectedSetNetCents: -1 }], ['string expected', { ...ok, expectedSetNetCents: '1' }],
  ])('rejects %s', (_n, body) => {
    expect((parseBundleRequest(body) as any).ok).toBe(false)
  })
  test('a client-sent price field is not part of the parsed request', () => {
    const r = parseBundleRequest({ ...ok, unitPriceCents: 1, priceCents: 1, selections: [{ productId: PA, sku: 'KVRN-A-M', priceCents: 1 }, ok.selections[1]] }) as any
    expect(JSON.stringify(r.req)).not.toMatch(/priceCents|unitPrice/)
  })
})

function facts(over: Partial<BundleFacts['bundle']> = {}, compOver: any = {}, variantOver: any = {}): BundleFacts {
  return {
    bundle: { id: BID, ownerProductId: PA, enabled: true, mode: 'fixed_discount', value: 1500, presentation: { headline: 'Set' }, ...over },
    components: [
      { productId: PA, name: 'Owner Tee', priceCents: 9000, currency: 'usd', active: true, live: true, sortOrder: 0, isOwner: true, allowedVariantIds: null, viewSeparately: true, ...compOver },
      { productId: PB, name: 'Other Pant', priceCents: 6000, currency: 'usd', active: true, live: true, sortOrder: 1, isOwner: false, allowedVariantIds: null, viewSeparately: true },
    ],
    variants: [
      { id: 'v1', sku: 'KVRN-A-M', productId: PA, size: 'M', color: 'Black', active: true, available: 5, ...variantOver },
      { id: 'v2', sku: 'KVRN-B-M', productId: PB, size: 'M', color: 'Black', active: true, available: 5 },
    ],
  } as any
}
const req = (over: any = {}) => ({ bundleId: BID, quantity: 1, selections: [{ productId: PA, sku: 'KVRN-A-M' }, { productId: PB, sku: 'KVRN-B-M' }], expectedSetNetCents: null, ...over })

describe('quoteBundle over facts', () => {
  test('prices from the canonical facts', () => {
    const q: any = quoteBundle(facts(), req())
    expect(q.ok).toBe(true)
    expect(q.setNetCents).toBe(13500)
    expect(q.lines.reduce((s: number, l: any) => s + l.netUnitPriceCents, 0)).toBe(13500)
    expect(q.lines.map((l: any) => l.originalUnitPriceCents)).toEqual([9000, 6000])
  })
  test('quantity multiplies, the unit split stays', () => {
    const q: any = quoteBundle(facts(), req({ quantity: 3 }))
    expect(q.netCents).toBe(40500)
    expect(q.lines.every((l: any) => l.quantity === 3)).toBe(true)
  })
  test('unknown, disabled or repriced-out-of-rule bundles are unavailable', () => {
    expect((quoteBundle(null, req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
    expect((quoteBundle(facts({ enabled: false }), req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
    expect((quoteBundle(facts({ mode: 'set_price', value: 99999 }), req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
    expect((quoteBundle(facts({}, { active: false }), req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
    expect((quoteBundle(facts({}, { live: false }), req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
    expect((quoteBundle(facts({}, { currency: 'eur' }), req()) as any).code).toBe('BUNDLE_UNAVAILABLE')
  })
  test('selection problems', () => {
    expect((quoteBundle(facts(), req({ selections: [req().selections[0]] })) as any).code).toBe('BUNDLE_SELECTION_INVALID')
    expect((quoteBundle(facts(), req({ selections: [req().selections[0], { productId: PB, sku: 'KVRN-ZZ' }] })) as any).code).toBe('BUNDLE_SELECTION_INVALID')
    expect((quoteBundle(facts(), req({ selections: [req().selections[0], { productId: PA, sku: 'KVRN-A-M' }] })) as any).code).toBe('BUNDLE_SELECTION_INVALID')
    expect((quoteBundle(facts({}, {}, { active: false }), req()) as any).code).toBe('BUNDLE_SELECTION_INVALID')
    expect((quoteBundle(facts({}, { allowedVariantIds: ['other'] }), req()) as any).code).toBe('BUNDLE_SELECTION_INVALID')
  })
  test('a size without enough stock is a component-unavailable error naming the sku', () => {
    const q: any = quoteBundle(facts({}, {}, { available: 1 }), req({ quantity: 2 }))
    expect(q.code).toBe('BUNDLE_COMPONENT_UNAVAILABLE')
    expect(q.sku).toBe('KVRN-A-M')
  })
  test('a stale expected price is reported with the current price, never silently charged', () => {
    const q: any = quoteBundle(facts(), req({ expectedSetNetCents: 12000 }))
    expect(q.ok).toBe(false)
    expect(q.code).toBe('BUNDLE_PRICE_CHANGED')
    expect(q.newSetNetCents).toBe(13500)
    expect((quoteBundle(facts(), req({ expectedSetNetCents: 13500 })) as any).ok).toBe(true)
  })
  test('reserve items: plain first, then set lines carrying the net price', () => {
    const q: any = quoteBundle(facts(), req())
    const items = buildReserveItems([{ sku: 'KVRN-P-M', quantity: 2 } as any], q)
    expect(items[0]).toEqual({ sku: 'KVRN-P-M', quantity: 2 })
    expect(items.slice(1).map((i: any) => i.unit_price_cents)).toEqual(q.lines.map((l: any) => l.netUnitPriceCents))
    expect(items.slice(1).every((i: any) => i.bundle === true)).toBe(true)
  })
})

// ── editor preview + inputs ───────────────────────────────────────────────────

describe('editor preview', () => {
  const owner = { productId: PA, name: 'Owner Tee', priceCents: 9000, status: 'published', variants: [{ id: 'v1', sku: 'KVRN-A-M', size: 'M', colorName: 'Black', active: true, available: 3 }] }
  const other = { productId: PB, name: 'Other Pant', priceCents: 6000, status: 'published', variants: [{ id: 'v2', sku: 'KVRN-B-M', size: 'M', colorName: 'Black', active: true, available: 0 }] }
  const cfg = (o: any = {}) => ({ ...emptyBundle(), enabled: true, components: [{ productId: PB, allowedVariantIds: null, viewSeparately: true }], pricing: { mode: 'fixed_discount' as const, value: 1500 }, ...o })

  test('off when disabled or absent', () => {
    expect(buildBundlePreview(null, owner, [other]).state).toBe('off')
    expect(buildBundlePreview(emptyBundle(), owner, [other]).state).toBe('off')
  })
  test('prices with the shared module; sold-out component makes the set unavailable but valid', () => {
    const p = buildBundlePreview(cfg(), owner, [other])
    expect(p.state).toBe('ok')
    expect(p.pricing!.setNetCents).toBe(13500)
    expect(p.available).toBe(false)
    expect(p.components[1].note).toBe('Sold out')
  })
  test('incomplete / invalid states carry readable issues', () => {
    expect(buildBundlePreview(cfg({ components: [] }), owner, [other]).state).toBe('incomplete')
    const bad = buildBundlePreview(cfg({ pricing: { mode: 'fixed_discount', value: 99999 } }), owner, [other])
    expect(bad.state).toBe('invalid')
    expect(bad.issues[0].code).toMatch(/^BUNDLE_PRICE_/)
    const missing = buildBundlePreview(cfg(), owner, [])
    expect(missing.issues.map(i => i.code)).toContain('BUNDLE_COMPONENT_MISSING')
  })
  test('a zero discount warns instead of blocking', () => {
    const p = buildBundlePreview(cfg({ pricing: { mode: 'fixed_discount', value: 0 } }), owner, [other])
    expect(p.warnings.map(w => w.code)).toContain('BUNDLE_ZERO_DISCOUNT')
  })
  test('value input parsers', () => {
    expect(parseMoneyInput('145')).toBe(14500)
    expect(parseMoneyInput('$145.5')).toBe(14550)
    expect(parseMoneyInput('1,450.05')).toBe(145005)
    expect(parseMoneyInput('-1')).toBeNull()
    expect(parseMoneyInput('1.234')).toBeNull()
    expect(parseMoneyInput('')).toBeNull()
    expect(parsePercentInput('10%')).toBe(1000)
    expect(parsePercentInput('12.5')).toBe(1250)
    expect(parsePercentInput('100')).toBeNull()
    expect(parsePercentInput('abc')).toBeNull()
    expect(formatValueInput('percent_discount', 1250)).toBe('12.5')
    expect(formatValueInput('percent_discount', 1000)).toBe('10')
    expect(formatValueInput('set_price', 14500)).toBe('145.00')
  })
})

describe('abandoned-checkout bundle context', () => {
  test('parses what checkout records; older contexts are not sets', () => {
    const ctx = { bundleId: BID, setQuantity: 2, seenSetNetCents: 13500, components: [{ sku: 'KVRN-A-M', quantity: 2, productId: PA }, { sku: 'KVRN-B-M', quantity: 2, productId: PB }] }
    const r = parseBundleResumeContext(ctx)!
    expect(r.setQuantity).toBe(2)
    expect(r.seenSetNetCents).toBe(13500)
    expect(r.components).toHaveLength(2)
    expect(parseBundleResumeContext({ components: [{ sku: 'a', quantity: 1 }] })).toBeNull()
    expect(parseBundleResumeContext({ bundleId: BID, components: [{ sku: 'a' }] })).toBeNull()
    expect(parseBundleResumeContext(null)).toBeNull()
    expect(parseBundleResumeContext({ ...ctx, seenSetNetCents: 'x' })!.seenSetNetCents).toBeNull()
  })
})
