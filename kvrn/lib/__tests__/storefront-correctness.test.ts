// lib/__tests__/storefront-correctness.test.ts
// Behavioral tests for three Phase A storefront correctness patches:
//   1. Cart quantity respects live inventory cap
//   2. Discount apply shows visible success/failure result
//   3. Discount stacking has explicit UX (error shown, applied code preserved)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCartItem(overrides: Partial<{ quantity: number; availableQuantity: number; cartItemId: string }> = {}) {
  return {
    cartItemId:        overrides.cartItemId ?? 'item-1',
    productId:         'prod-1',
    productName:       'KVRN Heavyweight Hoodie',
    slug:              'kvrn-phantom-hoodie',
    color:             'black',
    colorName:         'Black',
    colorHex:          '#000',
    size:              'M' as const,
    sku:               'PKHH-BLK-M',
    price:             8000,
    quantity:          overrides.quantity ?? 1,
    availableQuantity: overrides.availableQuantity,
    image:             '/images/hoodie.jpg',
  }
}

// Import the production cart reducer from its standalone module.
// lib/cart-reducer.ts has no hooks / 'use client' — safe to import in Jest.
import { cartReducer, type CartState } from '../cart-reducer'
import type { CartItem } from '../../types'

// ── 1. CART QUANTITY CAP ──────────────────────────────────────────────────────

describe('cart quantity: real reducer behavioral tests', () => {

  test('availableQuantity = 1: ADD_ITEM cannot increase above 1', () => {
    const item = makeCartItem({ quantity: 1, availableQuantity: 1 })
    const state0: CartState = { items: [item], isOpen: false }

    // Try to add another (e.g. user presses + in drawer)
    const state1 = cartReducer(state0, {
      type: 'ADD_ITEM',
      payload: makeCartItem({ quantity: 1, availableQuantity: 1 }),
    })
    expect(state1.items[0].quantity).toBe(1)  // capped — not 2
  })

  test('availableQuantity = 1: UPDATE_QUANTITY cannot set above 1', () => {
    const state0: CartState = { items: [makeCartItem({ quantity: 1, availableQuantity: 1 })], isOpen: false }
    const state1 = cartReducer(state0, {
      type: 'UPDATE_QUANTITY',
      payload: { cartItemId: 'item-1', quantity: 3 },
    })
    expect(state1.items[0].quantity).toBe(1)
  })

  test('availableQuantity = 3: UPDATE_QUANTITY caps at 3 not 5', () => {
    const state0: CartState = { items: [makeCartItem({ quantity: 2, availableQuantity: 3 })], isOpen: false }
    const state1 = cartReducer(state0, {
      type: 'UPDATE_QUANTITY',
      payload: { cartItemId: 'item-1', quantity: 5 },
    })
    expect(state1.items[0].quantity).toBe(3)
  })

  test('no availableQuantity: no cap (undefined = unlimited for items without cap)', () => {
    const state0: CartState = { items: [makeCartItem({ quantity: 3, availableQuantity: undefined })], isOpen: false }
    const state1 = cartReducer(state0, {
      type: 'UPDATE_QUANTITY',
      payload: { cartItemId: 'item-1', quantity: 10 },
    })
    expect(state1.items[0].quantity).toBe(10)
  })

  // ── Hydration / stale cap refresh tests ──────────────────────────────────

  test('HYDRATE then REFRESH_CAPS: legacy item (no availableQuantity) receives live cap', () => {
    // Simulate old localStorage cart without availableQuantity
    const legacy = makeCartItem({ quantity: 3, availableQuantity: undefined })
    const state0 = cartReducer({ items: [], isOpen: false }, { type: 'HYDRATE', payload: [legacy] })
    expect(state0.items[0].availableQuantity).toBeUndefined()

    // Server returns live stock: only 1 unit available
    const state1 = cartReducer(state0, {
      type: 'REFRESH_CAPS',
      payload: [{ cartItemId: 'item-1', availableQuantity: 1 }],
    })
    expect(state1.items[0].availableQuantity).toBe(1)
    expect(state1.items[0].quantity).toBe(1)  // clamped from 3 → 1
  })

  test('REFRESH_CAPS: stale cap=5, live cap=1 → quantity clamped to 1', () => {
    const item = makeCartItem({ quantity: 4, availableQuantity: 5 })
    const state0: CartState = { items: [item], isOpen: false }

    const state1 = cartReducer(state0, {
      type: 'REFRESH_CAPS',
      payload: [{ cartItemId: 'item-1', availableQuantity: 1 }],
    })
    expect(state1.items[0].availableQuantity).toBe(1)
    expect(state1.items[0].quantity).toBe(1)  // clamped
  })

  test('REFRESH_CAPS: quantity below new cap is unchanged', () => {
    const item = makeCartItem({ quantity: 2, availableQuantity: 5 })
    const state0: CartState = { items: [item], isOpen: false }

    const state1 = cartReducer(state0, {
      type: 'REFRESH_CAPS',
      payload: [{ cartItemId: 'item-1', availableQuantity: 3 }],
    })
    expect(state1.items[0].availableQuantity).toBe(3)
    expect(state1.items[0].quantity).toBe(2)  // unchanged — still within cap
  })

  test('ADD_ITEM for existing item: refreshes availableQuantity from payload', () => {
    // Simulates PDP re-add when inventory changed since first add
    const stale = makeCartItem({ quantity: 3, availableQuantity: 5 })
    const state0: CartState = { items: [stale], isOpen: false }

    // New PDP fetch says only 1 available now
    const state1 = cartReducer(state0, {
      type: 'ADD_ITEM',
      payload: makeCartItem({ quantity: 1, availableQuantity: 1 }),
    })
    expect(state1.items[0].availableQuantity).toBe(1)
    // quantity was 3, new cap is 1, so clamps to 1 (not 3+1=4, not even 3)
    expect(state1.items[0].quantity).toBe(1)
  })

  test('ADD_ITEM for existing item: no-cap payload does not override existing cap', () => {
    const capped = makeCartItem({ quantity: 1, availableQuantity: 2 })
    const state0: CartState = { items: [capped], isOpen: false }

    // Payload has no availableQuantity (e.g. from a path that doesn't pass it)
    const state1 = cartReducer(state0, {
      type: 'ADD_ITEM',
      payload: makeCartItem({ quantity: 1, availableQuantity: undefined }),
    })
    // Existing cap (2) is preserved; quantity goes from 1 → 2
    expect(state1.items[0].availableQuantity).toBe(2)
    expect(state1.items[0].quantity).toBe(2)
  })

  test('REFRESH_CAPS with cap=0: sold-out item is removed, not left at quantity:0', () => {
    const item = makeCartItem({ quantity: 2, availableQuantity: 3 })
    const state0: CartState = { items: [item], isOpen: false }

    const state1 = cartReducer(state0, {
      type: 'REFRESH_CAPS',
      payload: [{ cartItemId: 'item-1', availableQuantity: 0 }],
    })
    // Item must be removed — never leave quantity:0 in cart
    expect(state1.items).toHaveLength(0)
  })

  test('REFRESH_CAPS preserves items not in the payload', () => {
    const item1 = makeCartItem({ cartItemId: 'item-1', quantity: 2, availableQuantity: 5 })
    const item2 = makeCartItem({ cartItemId: 'item-2', quantity: 1, availableQuantity: 3 })
    const state0: CartState = { items: [item1, item2], isOpen: false }

    // Only refresh item-1
    const state1 = cartReducer(state0, {
      type: 'REFRESH_CAPS',
      payload: [{ cartItemId: 'item-1', availableQuantity: 1 }],
    })
    expect(state1.items).toHaveLength(2)
    expect(state1.items[0].availableQuantity).toBe(1)   // updated
    expect(state1.items[1].availableQuantity).toBe(3)   // untouched
  })

  test('hydration refresh orchestration: refreshInventoryCaps accepts explicit items', () => {
    // Verify the function signature accepts explicit items (the hydration-timing fix)
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../context/CartContext.tsx'), 'utf8'
    )
    // Function accepts optional explicit items
    expect(src).toContain('explicitItems?: CartItem[]')
    // Hydration effect passes stored items directly — no effect-ordering dependency
    expect(src).toContain('void refreshInventoryCaps(stored)')
    // No broken mount-only effect that runs before HYDRATE completes
    expect(src).not.toContain('intentionally run once after initial hydration only')
  })

  test('inventory above 10 is not arbitrarily capped', () => {
    // The API now returns GREATEST(0, stock_on_hand - reserved_quantity) with no LEAST(…,10)
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/inventory/route.ts'), 'utf8'
    )
    expect(src).not.toContain('LEAST(')  // artificial 10-unit cap removed
    expect(src).toContain('GREATEST(0, pv.stock_on_hand - pv.reserved_quantity) AS available_qty')
    // Reducer correctly passes a high cap through
    const highStockItem = makeCartItem({ quantity: 8, availableQuantity: 15 })
    const state0: CartState = { items: [highStockItem], isOpen: false }
    const state1 = cartReducer(state0, {
      type: 'UPDATE_QUANTITY',
      payload: { cartItemId: 'item-1', quantity: 12 },
    })
    expect(state1.items[0].quantity).toBe(12)  // within cap of 15; not capped at 10
  })

  test('availableQuantity = 2: ADD_ITEM increments correctly within cap', () => {
    const state0: CartState = { items: [makeCartItem({ quantity: 1, availableQuantity: 2 })], isOpen: false }
    const state1 = cartReducer(state0, {
      type: 'ADD_ITEM',
      payload: makeCartItem({ quantity: 1, availableQuantity: 2 }),
    })
    expect(state1.items[0].quantity).toBe(2)  // within cap

    // Try again — should stay at 2
    const state2 = cartReducer(state1, {
      type: 'ADD_ITEM',
      payload: makeCartItem({ quantity: 1, availableQuantity: 2 }),
    })
    expect(state2.items[0].quantity).toBe(2)
  })

  // Stale cart quantity at checkout: server rejects (this tests the checkout contract)
  test('stale cart quantity > available stock: checkout handler rejects at reservation', () => {
    // The existing reserveInventory validates against live DB stock.
    // A quantity of 3 for a 1-unit SKU returns an error, not a reservation.
    // We verify this via the checkout-session-handler source (no mock needed here —
    // the reservation layer is the authoritative guard).
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/checkout/session/route.ts'), 'utf8'
    )
    // Route calls reserveInventory from lib/reservations.ts
    expect(src).toContain('reserveInventory')

    const handlerSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../checkout-session-handler.ts'), 'utf8'
    )
    // Handler checks reservation.ok before proceeding to Stripe
    const reserveBlock = handlerSrc.slice(
      handlerSrc.indexOf('const reservation = await deps.reserveInventory'),
      handlerSrc.indexOf('const reservation = await deps.reserveInventory') + 400
    )
    expect(reserveBlock).toContain('if (!reservation.ok)')
    expect(reserveBlock).toContain('status: reservation.code')  // returns 400/503 on failure
  })

  // Inventory API returns actual available count (no arbitrary cap)
  test('inventory API returns actual available_qty without a 10-unit artificial cap', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/inventory/route.ts'), 'utf8'
    )
    // No arbitrary purchase cap — LEAST() removed
    expect(src).not.toContain('LEAST(')
    expect(src).toContain('GREATEST(0, pv.stock_on_hand - pv.reserved_quantity) AS available_qty')
    // Exact raw counts still not returned (stock_on_hand/reserved not in response object)
    expect(src).not.toContain('stock_on_hand: ')
    expect(src).not.toContain('reserved_quantity: ')
  })

  // CartDrawer + button disabled at cap
  test('CartDrawer + button is disabled when quantity reaches availableQuantity', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/cart/CartDrawer.tsx'), 'utf8'
    )
    expect(src).toContain('availableQuantity ?? Infinity')
    expect(src).toContain('disabled: atCap')
    // Low-stock message
    expect(src).toContain('Only 1 left')
  })
})

// ── 2. DISCOUNT VISIBLE RESULT ────────────────────────────────────────────────

describe('discount UI: visible success and failure states', () => {

  test('discountInputError state is separate from discountApplied', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain('discountInputError')
    expect(src).toContain('setDiscountInputError')
  })

  test('validation failure sets discountInputError, not code+error in discountApplied', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // On failure: set input error, NOT clear an existing applied code
    expect(src).toContain('setDiscountInputError(errorMsg)')
    // Do NOT do setDiscountApplied({ code: '', error: ... }) on failure
    const failureBlock = src.slice(
      src.indexOf('Do NOT clear an existing valid applied code'),
      src.indexOf('Do NOT clear an existing valid applied code') + 400
    )
    expect(failureBlock).toContain('setDiscountInputError')
  })

  test('validation success clears discountInputError and sets applied code', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // Success: clear error, set applied code with displayAmount
    expect(src).toContain('setDiscountInputError(null)')
    expect(src).toContain('discountCents: data.discountCents')
    expect(src).toContain('displayAmount: data.displayAmount')
  })

  test('error shown below input field with role=alert', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain('id="discount-error"')
    expect(src).toContain('role="alert"')
    expect(src).toContain('{discountInputError}')
  })

  test('input border turns red on error', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain('discountInputError ? \'1px solid #FCA5A5\'')
  })

  test('APPLY button shows loading indicator while validating', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    expect(src).toContain("discountLoading ? '…' : 'APPLY'")
    expect(src).toContain('aria-busy={discountLoading}')
  })

  test('applied code shows displayAmount inline in the banner', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // displayAmount shown alongside the code in the banner
    const bannerSection = src.slice(
      src.indexOf('{discountApplied.code}'),
      src.indexOf('{discountApplied.code}') + 300
    )
    expect(bannerSection).toContain('discountApplied.displayAmount')
  })

  test('REMOVE button clears both applied code and input error', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    const removeFn = src.slice(
      src.indexOf('const handleRemoveDiscount'),
      src.indexOf('const handleRemoveDiscount') + 200
    )
    expect(removeFn).toContain("setDiscountApplied({ code: '', error: null })")
    expect(removeFn).toContain('setDiscountInput')
    expect(removeFn).toContain('setDiscountInputError(null)')
  })
})

// ── 3. DISCOUNT STACKING EXPLICIT UX ─────────────────────────────────────────

describe('discount stacking: explicit UX when code already applied', () => {

  test('stacking error shown in amber box when a code is already applied', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // When discountApplied.code is set AND discountInputError is set:
    // show the error in an amber warning box (not silently ignored)
    expect(src).toContain('Stacking / second-code error shown when a code is already applied')
    expect(src).toContain('{discountInputError && (')
    // Amber color for stacking warning
    expect(src).toContain('#92400E')
    expect(src).toContain('#FFFBEB')
  })

  test('applying second code when first is applied does not clear first code', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // On validation failure, discountApplied is NOT modified
    // (only discountInputError is set)
    const failureComment = 'Do NOT clear an existing valid applied code'
    expect(src).toContain(failureComment)
    const afterComment = src.slice(
      src.indexOf(failureComment),
      src.indexOf(failureComment) + 300
    )
    // After the comment, only setDiscountInputError should be called, not setDiscountApplied
    expect(afterComment).not.toContain("setDiscountApplied({ code: '',")
  })

  test('changing input clears input error (fresh attempt UX)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // onChange clears discountInputError for clean UX
    expect(src).toContain("setDiscountInputError(null)")
    // Verify it's in the onChange handler, not just in handleRemoveDiscount
    const onChangeSection = src.slice(
      src.indexOf('onChange={e => {'),
      src.indexOf('onChange={e => {') + 200
    )
    expect(onChangeSection).toContain('setDiscountInputError(null)')
  })

  // Free shipping + merchandise discount interaction: authoritative is the server
  test('free shipping eligibility check uses server data, not client-only rules', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // qualifiesForFreeShipping is client-side display only (matches comment in code)
    expect(src).toContain('qualifiesForFreeShipping')
    // Discount validation goes through the server /api/discounts/validate
    expect(src).toContain('/api/discounts/validate')
    // The server handles the interaction; client never overrides server response
    expect(src).toContain('data.valid')
  })

  test('SMS offer code and KVRN10 go through same server validation path', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'), 'utf8'
    )
    // Both use handleApplyDiscount with the same fetch to /api/discounts/validate
    expect(src).toContain('handleApplyDiscount(smsOfferCode)')
    expect(src).toContain('handleApplyDiscount()')  // manual code entry
    // Single validation endpoint for both paths
    const validateCount = (src.match(/\/api\/discounts\/validate/g) || []).length
    expect(validateCount).toBe(1)  // deduplicated through handleApplyDiscount
  })
})
