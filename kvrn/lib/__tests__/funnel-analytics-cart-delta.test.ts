// lib/__tests__/funnel-analytics-cart-delta.test.ts
//
// add_to_cart must record the quantity the cart ACTUALLY gained, and nothing when the cart did
// not grow. The cart reducer's own behaviour is unchanged; computeAddedQuantity mirrors it, and
// these tests pin the two together so they cannot drift.

import fs from 'fs'
import path from 'path'
import { cartReducer, computeAddedQuantity } from '../cart-reducer'
import type { CartItem } from '../../types'

// The tracker imports two constants from a .tsx context Jest does not transform; they are
// pinned to the real file in funnel-analytics.test.ts.
jest.mock('@/context/CookiePrefsContext', () => ({
  STORAGE_KEY: 'kvrn_cookie_prefs_v2', COOKIE_PREFS_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000,
}))

const line = (o: Partial<CartItem> = {}): CartItem => ({
  cartItemId: 'p1-black-M', productId: 'p1', productName: 'Hoodie', slug: 'hoodie', color: 'black',
  colorName: 'Black', colorHex: '#000', size: 'M' as any, sku: 'H-BLK-M', price: 8000, quantity: 1,
  image: '/x.jpg', ...o,
} as CartItem)

const state = (items: CartItem[]) => ({ items, isOpen: false })
const qtyOf = (items: CartItem[], id = 'p1-black-M') => items.find(i => i.cartItemId === id)?.quantity ?? 0

describe('computeAddedQuantity — the actual delta of an add', () => {
  test('a) new line: the requested quantity', () => {
    expect(computeAddedQuantity([], line({ quantity: 2, availableQuantity: 5 }))).toBe(2)
    // a different line in the cart does not make this an "existing" line
    expect(computeAddedQuantity([line({ cartItemId: 'other', quantity: 3 })], line({ quantity: 1 }))).toBe(1)
  })
  test('b) existing line with room under the cap: the full requested quantity', () => {
    const cart = [line({ quantity: 2, availableQuantity: 5 })]
    expect(computeAddedQuantity(cart, line({ quantity: 2, availableQuantity: 5 }))).toBe(2)
  })
  test('c) partial clamp at the cap: only what fit', () => {
    const cart = [line({ quantity: 4, availableQuantity: 5 })]
    expect(computeAddedQuantity(cart, line({ quantity: 3, availableQuantity: 5 }))).toBe(1)
  })
  test('d) already at the cap: zero (no analytics event)', () => {
    const cart = [line({ quantity: 5, availableQuantity: 5 })]
    expect(computeAddedQuantity(cart, line({ quantity: 1, availableQuantity: 5 }))).toBe(0)
  })
  test('the FRESHEST availableQuantity (the payload\'s) wins over the stale one on the line', () => {
    const cart = [line({ quantity: 3, availableQuantity: 10 })]                      // stale cap 10
    expect(computeAddedQuantity(cart, line({ quantity: 2, availableQuantity: 4 }))).toBe(1)  // fresh cap 4
    expect(computeAddedQuantity(cart, line({ quantity: 2, availableQuantity: 3 }))).toBe(0)
  })
  test('with no cap anywhere, nothing clamps', () => {
    expect(computeAddedQuantity([line({ quantity: 50 })], line({ quantity: 7 }))).toBe(57 - 50)
  })
  test('a stale line already ABOVE the new cap is never reported as a positive add', () => {
    expect(computeAddedQuantity([line({ quantity: 9, availableQuantity: 9 })], line({ quantity: 1, availableQuantity: 4 }))).toBe(0)
  })
  test.each([0, -1, 1.5, NaN])('an invalid requested quantity (%p) is 0', q => {
    expect(computeAddedQuantity([], line({ quantity: q }))).toBe(0)
  })

  test('it equals the reducer\'s real change in total quantity, across a grid of states', () => {
    for (const have of [null, 0, 1, 3, 5, 9]) {
      for (const staleCap of [undefined, 2, 5, 10]) {
        for (const freshCap of [undefined, 1, 3, 5, 8]) {
          for (const req of [1, 2, 4]) {
            const items = have === null ? [] : [line({ quantity: have, availableQuantity: staleCap })]
            const payload = line({ quantity: req, availableQuantity: freshCap })
            const after = cartReducer(state(items), { type: 'ADD_ITEM', payload }).items
            const reducerDelta = qtyOf(after) - qtyOf(items)
            // The reducer can LOWER a stale over-cap line; analytics reports only increases.
            expect(computeAddedQuantity(items, payload)).toBe(Math.max(0, reducerDelta))
          }
        }
      }
    }
  })
  test('it does not mutate its inputs', () => {
    const items = Object.freeze([Object.freeze(line({ quantity: 2, availableQuantity: 3 }))]) as unknown as CartItem[]
    const payload = Object.freeze(line({ quantity: 5, availableQuantity: 3 })) as CartItem
    expect(computeAddedQuantity(items, payload)).toBe(1)
  })
})

describe('the cart reducer\'s business behaviour is unchanged', () => {
  test('ADD_ITEM still clamps an existing line to the fresh cap and opens the cart', () => {
    const out = cartReducer(state([line({ quantity: 4, availableQuantity: 5 })]),
      { type: 'ADD_ITEM', payload: line({ quantity: 3, availableQuantity: 5 }) })
    expect(qtyOf(out.items)).toBe(5)
    expect(out.isOpen).toBe(true)
  })
  test('the reducer source has no analytics and no side effects', () => {
    const src = fs.readFileSync(path.join(__dirname, '../cart-reducer.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/funnel|analytics|fetch\(|window\.|localStorage/i)
  })
})

describe('CartContext records only a real increase, with the actual delta', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../context/CartContext.tsx'), 'utf8')
  const add = src.slice(src.indexOf('const addItem = useCallback'), src.indexOf('const removeItem'))
  test('the delta is derived BEFORE dispatch, from the current cart', () => {
    expect(add).toMatch(/computeAddedQuantity\(itemsRef\.current, payload\)/)
    expect(add.indexOf('computeAddedQuantity(')).toBeGreaterThan(-1)
    expect(add.indexOf('computeAddedQuantity(')).toBeLessThan(add.indexOf("dispatch({ type: 'ADD_ITEM'"))
  })
  test('the event is sent only when delta > 0 and carries the delta, not the requested quantity', () => {
    expect(add).toMatch(/if \(added > 0\) trackAddToCartEvent\(\{ slug: item\.slug, sku: item\.sku, quantity: added \}\)/)
    expect(add).not.toMatch(/quantity: item\.quantity/)
  })
  test('the same-tick ref advance uses the real reducer', () => {
    expect(add).toMatch(/itemsRef\.current = cartReducer\(/)
  })
})

// The exact addItem sequence (derive delta -> reduce -> record), driven through the REAL browser
// tracker with consent granted, to prove what actually goes over the wire.
describe('end to end through the real tracker', () => {
  let sent: any[]
  let local: Record<string, string>
  let session: Record<string, string>
  let fc: typeof import('../funnel-client')
  const store = (m: Record<string, string>) => ({
    getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = v },
    removeItem: (k: string) => { delete m[k] },
  })
  beforeAll(async () => { fc = await import('../funnel-client') })
  beforeEach(() => {
    sent = []; local = { kvrn_cookie_prefs_v2: JSON.stringify({ prefs: { essential: true, analytics: true }, ts: Date.now() }) }; session = {}
    ;(global as any).window = {
      localStorage: store(local), sessionStorage: store(session), navigator: { doNotTrack: null },
      location: { pathname: '/products/hoodie', search: '' }, innerWidth: 1280,
    }
    ;(global as any).document = { referrer: '' }
    ;(global as any).fetch = jest.fn(async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return {} })
  })
  afterEach(() => { delete (global as any).window; delete (global as any).document })

  let cart: CartItem[]
  const addItem = (item: CartItem) => {
    const added = computeAddedQuantity(cart, item)
    cart = cartReducer({ items: cart, isOpen: false }, { type: 'ADD_ITEM', payload: item }).items
    if (added > 0) fc.trackAddToCartEvent({ slug: item.slug, sku: item.sku, quantity: added })
  }
  const adds = () => sent.filter(b => b.event === 'add_to_cart').map(b => b.qty)

  test('new line, room, partial clamp, then at cap: qty 2, 2, 1 and no fourth event', () => {
    cart = []
    addItem(line({ quantity: 2, availableQuantity: 5 }))   // new line -> 2
    addItem(line({ quantity: 2, availableQuantity: 5 }))   // room -> 2 (cart 4)
    addItem(line({ quantity: 3, availableQuantity: 5 }))   // partial -> 1 (cart 5)
    addItem(line({ quantity: 1, availableQuantity: 5 }))   // at cap -> nothing
    expect(qtyOf(cart)).toBe(5)
    expect(adds()).toEqual([2, 2, 1])
    expect(adds().reduce((a: number, b: number) => a + b, 0)).toBe(qtyOf(cart))   // events sum to the cart
  })
})
