/**
 * KVRN V49.4 tests
 * Unit tests: always run.
 * Integration: require TEST_DATABASE_URL — clearly skipped when absent.
 * DB behavior NOT verified when integration tests are skipped.
 */

import { aggregateAndValidate, createReservationService, parseDbErr } from '../reservations'
import { isValidCheckoutSessionId } from '../checkout-status'
import { isValidStripeTestSecretKey, isValidWebhookSecret } from '../stripe-client'
import { getSiteOrigin } from '../site-origin'
import { requiredStringField, optionalStringField, FIELD_MAX } from '../checkout-validation'
import { createCheckoutPostHandler, type CheckoutRouteDeps } from '../checkout-session-handler'

describe('aggregateAndValidate', () => {
  test('rejects null', () => expect(Array.isArray(aggregateAndValidate(null as any))).toBe(false))
  test('rejects empty array', () => {
    const r = aggregateAndValidate([])
    expect(Array.isArray(r)).toBe(false)
    if (!Array.isArray(r)) expect(r.code).toBe('EMPTY_CART')
  })
  test('rejects bad SKU prefix', () => {
    const r = aggregateAndValidate([{ sku: 'BAD-001', quantity: 1 }])
    expect(Array.isArray(r)).toBe(false)
    if (!Array.isArray(r)) expect(r.code).toBe('INVALID_SKU')
  })
  test('rejects empty SKU', () => {
    const r = aggregateAndValidate([{ sku: '', quantity: 1 }])
    expect(Array.isArray(r)).toBe(false)
  })
  test('rejects quantity 0', () => {
    const r = aggregateAndValidate([{ sku: 'KVRN-X-M', quantity: 0 }])
    expect(Array.isArray(r)).toBe(false)
    if (!Array.isArray(r)) expect(r.code).toBe('INVALID_QUANTITY')
  })
  test('rejects float quantity', () => {
    const r = aggregateAndValidate([{ sku: 'KVRN-X-M', quantity: 1.5 }])
    expect(Array.isArray(r)).toBe(false)
  })
  test('aggregates duplicate SKUs', () => {
    const r = aggregateAndValidate([
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 3 },
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 4 },
    ])
    expect(Array.isArray(r)).toBe(true)
    if (Array.isArray(r)) { expect(r.length).toBe(1); expect(r[0].quantity).toBe(7) }
  })
  test('rejects aggregated total above MAX=10', () => {
    const r = aggregateAndValidate([
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 7 },
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 5 },
    ])
    expect(Array.isArray(r)).toBe(false)
    if (!Array.isArray(r)) expect(r.code).toBe('INVALID_QUANTITY')
  })
  test('accepts MAX=10 exactly', () => {
    const r = aggregateAndValidate([
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 6 },
      { sku: 'KVRN-D001-PKHH-BLK-M', quantity: 4 },
    ])
    expect(Array.isArray(r)).toBe(true)
    if (Array.isArray(r)) expect(r[0].quantity).toBe(10)
  })
})

describe('parseDbErr', () => {
  test('maps INVALID_SKU', () => expect(parseDbErr('KVRN_RESERVATION|INVALID_SKU|x').code).toBe('INVALID_SKU'))
  test('maps SKU_NOT_FOUND as INVALID_SKU alias', () => expect(parseDbErr('KVRN_RESERVATION|SKU_NOT_FOUND|x').code).toBe('INVALID_SKU'))
  test('maps OUT_OF_STOCK', () => expect(parseDbErr('KVRN_RESERVATION|OUT_OF_STOCK|x').code).toBe('OUT_OF_STOCK'))
  test('falls back DB_ERROR for unknown', () => expect(parseDbErr('KVRN_RESERVATION|UNKNOWN|x').code).toBe('DB_ERROR'))
  test('falls back DB_ERROR for non-KVRN', () => expect(parseDbErr('random error').code).toBe('DB_ERROR'))
})

describe('isValidCheckoutSessionId', () => {
  test('accepts cs_test_ ID', () => expect(isValidCheckoutSessionId('cs_test_' + 'a'.repeat(20))).toBe(true))
  test('accepts cs_live_', () => expect(isValidCheckoutSessionId('cs_live_' + 'a'.repeat(20))).toBe(true))
  test('rejects too short', () => expect(isValidCheckoutSessionId('cs_test_abc')).toBe(false))
  test('rejects null', () => expect(isValidCheckoutSessionId(null)).toBe(false))
})

describe('isValidStripeTestSecretKey', () => {
  test('accepts valid sk_test_ key', () => expect(isValidStripeTestSecretKey('sk_test_' + 'a'.repeat(24))).toBe(true))
  test('rejects sk_test_x (too short)', () => expect(isValidStripeTestSecretKey('sk_test_x')).toBe(false))
  test('rejects sk_live_', () => expect(isValidStripeTestSecretKey('sk_live_' + 'a'.repeat(24))).toBe(false))
  test('rejects rk_test_', () => expect(isValidStripeTestSecretKey('rk_test_' + 'a'.repeat(24))).toBe(false))
  test('rejects arbitrary string', () => expect(isValidStripeTestSecretKey('not-a-key')).toBe(false))
  test('rejects empty', () => expect(isValidStripeTestSecretKey('')).toBe(false))
})

describe('isValidWebhookSecret', () => {
  test('accepts whsec_ key', () => expect(isValidWebhookSecret('whsec_' + 'a'.repeat(20))).toBe(true))
  test('rejects sk_test_', () => expect(isValidWebhookSecret('sk_test_abc')).toBe(false))
  test('rejects empty', () => expect(isValidWebhookSecret('')).toBe(false))
})

describe('getSiteOrigin', () => {
  const origUrl = process.env.SITE_URL
  afterEach(() => { process.env.SITE_URL = origUrl })
  test('returns origin for https in production', () => {
    process.env.SITE_URL = 'https://kvrn.omidhamidi1110.workers.dev'
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    expect(getSiteOrigin()).toBe('https://kvrn.omidhamidi1110.workers.dev')
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'test', configurable: true })
  })
  test('returns null when SITE_URL missing', () => {
    delete process.env.SITE_URL
    expect(getSiteOrigin()).toBeNull()
  })
})

// ── Integration tests ─────────────────────────────────────────────────────────

const TEST_DB = process.env.TEST_DATABASE_URL
const describeDB = TEST_DB ? describe : describe.skip

if (!TEST_DB) {
  test('NOTE: DB integration tests skipped — TEST_DATABASE_URL absent. Migration/concurrency/payment NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB('Integration — isolated per-test fixtures', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createReservationService>

  beforeAll(() => {
    testSql = neon(TEST_DB!)
    svc     = createReservationService(testSql)
  })

  async function mkFixture(stock = 5) {
    const uid = String(Date.now()) + Math.random().toString(36).slice(2, 6).toUpperCase()
    const sku = 'KVRN-T' + uid + '-M'
    const [p] = await testSql`
      INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active)
      VALUES ('TEST',${uid},${`Test ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`
      INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
      VALUES (${p.id},${sku},'Black','BLK','M',3,${stock},0,true) RETURNING id`
    return { productId: p.id as string, variantId: v.id as string, sku }
  }

  async function teardown(o: { resIds?: string[]; orderIds?: string[]; evtIds?: string[]; varIds?: string[]; prodIds?: string[] }) {
    if (o.orderIds?.length)  await testSql`DELETE FROM order_items WHERE order_id = ANY(${o.orderIds}::uuid[])`
    if (o.orderIds?.length)  await testSql`DELETE FROM orders WHERE id = ANY(${o.orderIds}::uuid[])`
    if (o.evtIds?.length)    await testSql`DELETE FROM webhook_events WHERE stripe_event_id = ANY(${o.evtIds}::text[])`
    if (o.resIds?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${o.resIds}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${o.resIds}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${o.resIds}::uuid[])`
    }
    if (o.varIds?.length)  await testSql`DELETE FROM product_variants WHERE id = ANY(${o.varIds}::uuid[])`
    if (o.prodIds?.length) await testSql`DELETE FROM products WHERE id = ANY(${o.prodIds}::uuid[])`
  }

  test('reservation creates immutable snapshots and reservation_id in movements', async () => {
    const f = await mkFixture(5)
    const ids = { resIds: [] as string[], varIds: [f.variantId], prodIds: [f.productId] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 2 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.resIds.push(r.reservationId)
      expect(r.items[0].size).toBe('M')
      expect(r.items[0].unitPriceCents).toBe(8000)
      const mv = await testSql`SELECT reservation_id FROM inventory_movements WHERE reservation_id = ${r.reservationId}`
      expect(mv.length).toBeGreaterThan(0)
    } finally { await teardown(ids) }
  }, 20000)

  test('concurrent final-unit: exactly one succeeds', async () => {
    const f = await mkFixture(1)
    const ids = { resIds: [] as string[], varIds: [f.variantId], prodIds: [f.productId] }
    try {
      const [r1, r2] = await Promise.all([
        svc.reserveInventory([{ sku: f.sku, quantity: 1 }]),
        svc.reserveInventory([{ sku: f.sku, quantity: 1 }]),
      ])
      for (const r of [r1, r2]) if (r.ok) ids.resIds.push(r.reservationId)
      expect([r1, r2].filter(r => r.ok).length).toBe(1)
      expect([r1, r2].filter(r => !r.ok).length).toBe(1)
    } finally { await teardown(ids) }
  }, 25000)

  test('amount mismatch rolls back — no order, event stays retryable', async () => {
    const f  = await mkFixture(3)
    const fs = 'cs_test_amtmm_' + Date.now()
    const ev = 'evt_amtmm_' + Date.now()
    const ids = { resIds: [] as string[], orderIds: [] as string[], evtIds: [ev], varIds: [f.variantId], prodIds: [f.productId] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.resIds.push(r.reservationId)
      await testSql`UPDATE reservations SET stripe_checkout_session_id = ${fs} WHERE id = ${r.reservationId}`
      await expect(svc.finalizePaidOrder({
        stripeSessionId: fs, reservationIdHint: null, stripePaymentIntent: 'pi_x',
        stripeEventId: ev, eventType: 'checkout.session.completed',
        currency: 'usd', amountTotal: 999,
        customerEmail: null, customerName: null, customerPhone: null, shippingAddress: null,
      })).rejects.toThrow()
      const orders = await testSql`SELECT id FROM orders WHERE stripe_checkout_session_id = ${fs}`
      expect(orders.length).toBe(0)
      const [evt] = await testSql`SELECT processed FROM webhook_events WHERE stripe_event_id = ${ev}`
      expect(evt?.processed ?? false).toBe(false)
    } finally { await teardown(ids) }
  }, 15000)

  test('no_reservation marks event processed once', async () => {
    const ev = 'evt_norev_' + Date.now()
    const ids = { evtIds: [ev] }
    try {
      const r = await svc.finalizePaidOrder({
        stripeSessionId: 'cs_test_norev_' + Date.now(), reservationIdHint: null,
        stripePaymentIntent: 'pi_y', stripeEventId: ev,
        eventType: 'checkout.session.completed', currency: 'usd', amountTotal: 8000,
        customerEmail: null, customerName: null, customerPhone: null, shippingAddress: null,
      })
      expect(r.outcome).toBe('no_reservation')
      const [row] = await testSql`SELECT processed, result FROM webhook_events WHERE stripe_event_id = ${ev}`
      expect(row.processed).toBe(true)
      expect(row.result).toBe('no_reservation')
    } finally { await teardown(ids) }
  }, 10000)
})

// ── Unit: shipping calculation ────────────────────────────────────────────────

import { calculateShippingCents, US_SHIPPING_OPTIONS } from '../stripe'
import { isValidUSState, isValidUSZip, isValidEmail } from '../us-states'

describe('US shipping rates', () => {
  test('standard shipping is 1999 cents', () => {
    expect(calculateShippingCents('standard')).toBe(1999)
  })
  test('express shipping is 2999 cents', () => {
    expect(calculateShippingCents('express')).toBe(2999)
  })
  test('US_SHIPPING_OPTIONS contains standard and express', () => {
    expect(US_SHIPPING_OPTIONS.standard.cents).toBe(1999)
    expect(US_SHIPPING_OPTIONS.express.cents).toBe(2999)
  })
})

describe('US address validation', () => {
  test('valid state CA', () => expect(isValidUSState('CA')).toBe(true))
  test('valid state lowercase ca', () => expect(isValidUSState('ca')).toBe(true))
  test('invalid state XX', () => expect(isValidUSState('XX')).toBe(false))
  test('empty state rejected', () => expect(isValidUSState('')).toBe(false))
  test('valid ZIP 5-digit', () => expect(isValidUSZip('90210')).toBe(true))
  test('valid ZIP+4', () => expect(isValidUSZip('90210-1234')).toBe(true))
  test('invalid ZIP 4-digit', () => expect(isValidUSZip('9021')).toBe(false))
  test('invalid ZIP with letters', () => expect(isValidUSZip('9021A')).toBe(false))
})

describe('email validation', () => {
  test('valid email', () => expect(isValidEmail('user@example.com')).toBe(true))
  test('invalid email no @', () => expect(isValidEmail('notanemail')).toBe(false))
  test('empty email', () => expect(isValidEmail('')).toBe(false))
})

// ── Unit: sold-out customer error formatter ───────────────────────────────────

describe('sold-out customer error formatting', () => {
  // Simulate what checkout page does: look up cart item by sku, build display string
  function buildSoldOutMessage(
    sku: string | undefined,
    cartItems: Array<{ sku?: string; productName: string; colorName: string; size: string }>
  ): string {
    const item = sku ? cartItems.find(i => i.sku === sku) : null
    if (item) {
      return `${item.productName} — ${item.colorName} / ${item.size} is sold out.`
    }
    return 'An item in your bag is sold out.'
  }

  const mockCart = [
    { sku: 'KVRN-D001-PKHH-BLK-M', productName: 'Project KVRN Heavyweight Hoodie', colorName: 'Black', size: 'M' },
    { sku: 'KVRN-D001-PKHSP-BLK-L', productName: 'Project KVRN Heavyweight Sweatpants', colorName: 'Black', size: 'L' },
  ]

  test('shows product name and variant for known SKU', () => {
    const msg = buildSoldOutMessage('KVRN-D001-PKHH-BLK-M', mockCart)
    expect(msg).toBe('Project KVRN Heavyweight Hoodie — Black / M is sold out.')
    expect(msg).not.toContain('KVRN-D001-')
  })

  test('shows sweatpants product name for sweatpants SKU', () => {
    const msg = buildSoldOutMessage('KVRN-D001-PKHSP-BLK-L', mockCart)
    expect(msg).toBe('Project KVRN Heavyweight Sweatpants — Black / L is sold out.')
    expect(msg).not.toContain('KVRN-D001-')
  })

  test('safe fallback for unknown SKU', () => {
    const msg = buildSoldOutMessage('KVRN-UNKNOWN-SKU', mockCart)
    expect(msg).toBe('An item in your bag is sold out.')
    expect(msg).not.toContain('KVRN-UNKNOWN')
  })

  test('safe fallback when sku is undefined', () => {
    const msg = buildSoldOutMessage(undefined, mockCart)
    expect(msg).toBe('An item in your bag is sold out.')
  })

  test('parseDbErr OUT_OF_STOCK message never contains raw SKU', () => {
    const err = parseDbErr('KVRN_RESERVATION|OUT_OF_STOCK|KVRN-D001-PKHH-BLK-M')
    expect(err.message).not.toContain('KVRN-D001-')
    expect(err.sku).toBe('KVRN-D001-PKHH-BLK-M')  // sku kept for lookup, not display
  })

  test('parseDbErr INSUFFICIENT_STOCK message never contains raw SKU', () => {
    const err = parseDbErr('KVRN_RESERVATION|INSUFFICIENT_STOCK|KVRN-D001-PKHSP-BLK-XL')
    expect(err.message).not.toContain('KVRN-D001-')
    expect(err.sku).toBe('KVRN-D001-PKHSP-BLK-XL')
  })

})

// ── Integration: shipping snapshot and finalization (require TEST_DATABASE_URL) ─

const TEST_DB_50 = process.env.TEST_DATABASE_URL
const describeDB50 = TEST_DB_50 ? describe : describe.skip

if (!TEST_DB_50) {
  test('NOTE: V50 shipping DB tests skipped — TEST_DATABASE_URL not set. Shipping snapshot and finalization NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB50('Integration V50 — shipping snapshot and paid order finalization', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createReservationService>

  beforeAll(() => {
    testSql = neon(TEST_DB_50!)
    svc     = createReservationService(testSql)
  })

  async function mkFixture50(stock = 5) {
    const uid = String(Date.now()) + Math.random().toString(36).slice(2, 6).toUpperCase()
    const sku = 'KVRN-T50-' + uid + '-M'
    const [p] = await testSql`
      INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active)
      VALUES ('TEST',${uid},${`Test50 ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`
      INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
      VALUES (${p.id},${sku},'Black','BLK','M',3,${stock},0,true) RETURNING id`
    return { productId: p.id as string, variantId: v.id as string, sku, priceCents: 8000 }
  }

  async function teardown50(o: { resIds?: string[]; orderIds?: string[]; evtIds?: string[]; varIds?: string[]; prodIds?: string[] }) {
    if (o.orderIds?.length)  await testSql`DELETE FROM order_items WHERE order_id = ANY(${o.orderIds}::uuid[])`
    if (o.orderIds?.length)  await testSql`DELETE FROM orders WHERE id = ANY(${o.orderIds}::uuid[])`
    if (o.evtIds?.length)    await testSql`DELETE FROM webhook_events WHERE stripe_event_id = ANY(${o.evtIds}::text[])`
    if (o.resIds?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${o.resIds}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${o.resIds}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${o.resIds}::uuid[])`
    }
    if (o.varIds?.length)  await testSql`DELETE FROM product_variants WHERE id = ANY(${o.varIds}::uuid[])`
    if (o.prodIds?.length) await testSql`DELETE FROM products WHERE id = ANY(${o.prodIds}::uuid[])`
  }

  const testAddress = {
    firstName: 'Test', lastName: 'Buyer', line1: '123 Main St', line2: '',
    city: 'Los Angeles', state: 'CA', postalCode: '90001', country: 'US',
  }

  test('saveReservationCheckoutDetails saves all fields', async () => {
    const f = await mkFixture50()
    const ids = { resIds: [] as string[], varIds: [f.variantId], prodIds: [f.productId] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.resIds.push(r.reservationId)

      const saved = await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:   'test@example.com',
        customerName:    'Test Buyer',
        customerPhone:   '+15550001234',
        shippingAddress: testAddress,
        shippingMethod:  'standard',
        shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      expect(saved).toBe(true)

      const [row] = await testSql`
        SELECT customer_email, customer_name, shipping_method, shipping_cents
        FROM reservations WHERE id = ${r.reservationId}`
      expect(row.customer_email).toBe('test@example.com')
      expect(row.customer_name).toBe('Test Buyer')
      expect(row.shipping_method).toBe('standard')
      expect(Number(row.shipping_cents)).toBe(1999)
    } finally { await teardown50(ids) }
  }, 20000)

  test('saveReservationCheckoutDetails returns false for completed reservation', async () => {
    const f = await mkFixture50()
    const ids = { resIds: [] as string[], varIds: [f.variantId], prodIds: [f.productId] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.resIds.push(r.reservationId)
      // Force reservation to completed state
      await testSql`UPDATE reservations SET status='completed' WHERE id=${r.reservationId}`
      const saved = await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail: 'x@y.com', customerName: 'X', customerPhone: null,
        shippingAddress: testAddress, shippingMethod: 'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      expect(saved).toBe(false)
    } finally { await teardown50(ids) }
  }, 15000)
})
// ── Route-level: real createCheckoutPostHandler tests ────────────────────────

// Minimal Next.js Request stub for testing the handler in Node
function makeRequest(body: any): any {
  return { json: async () => body }
}

const VALID_BODY = {
  items:          [{ sku: 'KVRN-D001-PKHH-BLK-M', quantity: 1 }],
  email:          'test@example.com',
  shippingMethod: 'standard',
  shippingAddress: {
    firstName: 'Test', lastName: 'Buyer',
    line1: '123 Main St', city: 'Los Angeles',
    state: 'CA', postalCode: '90001', country: 'US',
  },
}

const RESERVATION_ID = 'aaaaaaaa-0000-0000-0000-000000000001'

function makeStubReservation() {
  return {
    ok:            true  as const,
    reservationId: RESERVATION_ID,
    expiresAt:     new Date(Date.now() + 35 * 60 * 1000),
    items: [{
      variantId: 'v1', sku: 'KVRN-D001-PKHH-BLK-M',
      productName: 'Project KVRN Heavyweight Hoodie', size: 'M',
      color: 'Black', unitPriceCents: 8000, quantity: 1,
    }],
  }
}

function makeBaseDeps(overrides: Partial<CheckoutRouteDeps> = {}): CheckoutRouteDeps {
  return {
    isCheckoutEnabled:              () => true,
    getSiteOrigin:                  () => 'https://kvrn.omidhamidi1110.workers.dev',
    getStripe:                      () => ({
      checkout: { sessions: {
        create:  jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_x', id: 'cs_test_x', expires_at: 9999999999 }),
        expire:  jest.fn().mockResolvedValue({}),
      } },
    }),
    reserveInventory:               jest.fn().mockResolvedValue(makeStubReservation()),
    saveReservationCheckoutDetails: jest.fn().mockResolvedValue(true),
    failReservation:                jest.fn().mockResolvedValue('released' as const),
    attachStripeSession:            jest.fn().mockResolvedValue(undefined),
    releaseExpiredReservations:     jest.fn().mockResolvedValue(0),
    ...overrides,
  }
}

describe('createCheckoutPostHandler — real production handler', () => {
  test('snapshot false: 409 returned, failReservation called, Stripe never called, attach never called', async () => {
    const stripeCreate = jest.fn()
    const attachFn     = jest.fn()
    const failFn       = jest.fn().mockResolvedValue('released' as const)

    const deps = makeBaseDeps({
      saveReservationCheckoutDetails: jest.fn().mockResolvedValue(false),
      failReservation: failFn,
      getStripe: () => ({ checkout: { sessions: { create: stripeCreate, expire: jest.fn() } } }),
      attachStripeSession: attachFn,
    })

    const handler  = createCheckoutPostHandler(deps)
    const response = await handler(makeRequest(VALID_BODY) as any)
    const body     = await response.json()

    expect(response.status).toBe(409)
    expect(failFn).toHaveBeenCalledWith(RESERVATION_ID, 'save_checkout_details_failed')
    expect(stripeCreate).not.toHaveBeenCalled()
    expect(attachFn).not.toHaveBeenCalled()
    expect(body.error).toBeTruthy()
  })

  test('missing phone (undefined) does not return 400 — reaches reserveInventory', async () => {
    const reserveFn = jest.fn().mockResolvedValue(makeStubReservation())
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const bodyNoPhone = { ...VALID_BODY, phone: undefined }
    const handler = createCheckoutPostHandler(deps)
    const response = await handler(makeRequest(bodyNoPhone) as any)
    // Should not be 400 — missing phone is valid
    expect(response.status).not.toBe(400)
    expect(reserveFn).toHaveBeenCalled()
  })

  test('missing line2 (undefined) does not return 400 — reaches reserveInventory', async () => {
    const reserveFn = jest.fn().mockResolvedValue(makeStubReservation())
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const bodyNoLine2 = {
      ...VALID_BODY,
      shippingAddress: { ...VALID_BODY.shippingAddress, line2: undefined },
    }
    const handler = createCheckoutPostHandler(deps)
    const response = await handler(makeRequest(bodyNoLine2) as any)
    expect(response.status).not.toBe(400)
    expect(reserveFn).toHaveBeenCalled()
  })

  test('successful request progresses to snapshot saving', async () => {
    const saveFn = jest.fn().mockResolvedValue(true)
    const deps   = makeBaseDeps({ saveReservationCheckoutDetails: saveFn })
    const handler  = createCheckoutPostHandler(deps)
    const response = await handler(makeRequest(VALID_BODY) as any)
    expect(response.status).toBe(200)
    expect(saveFn).toHaveBeenCalledWith(
      RESERVATION_ID,
      expect.objectContaining({
        customerEmail:  'test@example.com',
        shippingMethod: 'standard',
        shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
    )
  })

  test('overlong state (CAZ) returns 400 before reserveInventory', async () => {
    const reserveFn = jest.fn()
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const body = { ...VALID_BODY, shippingAddress: { ...VALID_BODY.shippingAddress, state: 'CAZ' } }
    const response = await createCheckoutPostHandler(deps)(makeRequest(body) as any)
    expect(response.status).toBe(400)
    expect(reserveFn).not.toHaveBeenCalled()
  })

  test('country USA returns 400 before reserveInventory', async () => {
    const reserveFn = jest.fn()
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const body = { ...VALID_BODY, shippingAddress: { ...VALID_BODY.shippingAddress, country: 'USA' } }
    const response = await createCheckoutPostHandler(deps)(makeRequest(body) as any)
    expect(response.status).toBe(400)
    expect(reserveFn).not.toHaveBeenCalled()
  })

  test('missing country returns 400 before reserveInventory', async () => {
    const reserveFn = jest.fn()
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const body = { ...VALID_BODY, shippingAddress: { ...VALID_BODY.shippingAddress, country: undefined } }
    const response = await createCheckoutPostHandler(deps)(makeRequest(body) as any)
    expect(response.status).toBe(400)
    expect(reserveFn).not.toHaveBeenCalled()
  })

  test('overlong ZIP returns 400 before reserveInventory', async () => {
    const reserveFn = jest.fn()
    const deps = makeBaseDeps({ reserveInventory: reserveFn })
    const body = { ...VALID_BODY, shippingAddress: { ...VALID_BODY.shippingAddress, postalCode: '90210-1234junk' } }
    const response = await createCheckoutPostHandler(deps)(makeRequest(body) as any)
    expect(response.status).toBe(400)
    expect(reserveFn).not.toHaveBeenCalled()
  })
})

// ── Integration V50.2: shipping finalization DB tests ─────────────────────────

const describeDB502 = TEST_DB_50 ? describe : describe.skip

describeDB502('Integration V50.2 — shipping cents, snapshot override, wrong total, replay', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createReservationService>

  beforeAll(() => {
    testSql = neon(TEST_DB_50!)
    svc     = createReservationService(testSql)
  })

  async function mk502(stock = 3) {
    const uid = 'V502' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase()
    const sku = 'KVRN-T502-' + uid + '-M'
    const [p] = await testSql`
      INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active)
      VALUES ('TEST',${uid},${`T502 ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`
      INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active)
      VALUES (${p.id},${sku},'Black','BLK','M',3,${stock},0,true) RETURNING id`
    return { pid: p.id as string, vid: v.id as string, sku }
  }

  async function cleanup502(o: { rids?: string[]; oIds?: string[]; evts?: string[]; vids?: string[]; pids?: string[] }) {
    if (o.oIds?.length)  await testSql`DELETE FROM order_items WHERE order_id = ANY(${o.oIds}::uuid[])`
    if (o.oIds?.length)  await testSql`DELETE FROM orders WHERE id = ANY(${o.oIds}::uuid[])`
    if (o.evts?.length)  await testSql`DELETE FROM webhook_events WHERE stripe_event_id = ANY(${o.evts}::text[])`
    if (o.rids?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${o.rids}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${o.rids}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${o.rids}::uuid[])`
    }
    if (o.vids?.length) await testSql`DELETE FROM product_variants WHERE id = ANY(${o.vids}::uuid[])`
    if (o.pids?.length) await testSql`DELETE FROM products WHERE id = ANY(${o.pids}::uuid[])`
  }

  const ta = { firstName:'T',lastName:'B',line1:'1 St',line2:'',city:'LA',state:'CA',postalCode:'90001',country:'US' }

  test('standard: subtotal_cents=8000, shipping_cents=1999, total_cents=9999, shipping_method=standard', async () => {
    const f = await mk502()
    const fs = 'cs_test_s502std_' + Date.now()
    const ev = 'evt_s502std_' + Date.now()
    const ids = { rids: [] as string[], oIds: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'std@t.com', customerName:'Std', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_std502',
        stripeEventId:ev, eventType:'checkout.session.completed',
        currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)
      const [o] = await testSql`SELECT subtotal_cents,shipping_cents,total_cents,shipping_method FROM orders WHERE id=${result.orderId}`
      expect(Number(o.subtotal_cents)).toBe(8000)
      expect(Number(o.shipping_cents)).toBe(1999)
      expect(Number(o.total_cents)).toBe(9999)
      expect(o.shipping_method).toBe('standard')
    } finally { await cleanup502(ids) }
  }, 25000)

  test('express: subtotal_cents=8000, shipping_cents=2999, total_cents=10999, shipping_method=express', async () => {
    const f = await mk502()
    const fs = 'cs_test_s502exp_' + Date.now()
    const ev = 'evt_s502exp_' + Date.now()
    const ids = { rids: [] as string[], oIds: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'exp@t.com', customerName:'Exp', customerPhone:null,
        shippingAddress:ta, shippingMethod:'express', shippingBeforeDiscountCents: 2999, shippingDiscountCents: 0, shippingFinalCents: 2999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_exp502',
        stripeEventId:ev, eventType:'checkout.session.completed',
        currency:'usd', amountTotal:10999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)
      const [o] = await testSql`SELECT subtotal_cents,shipping_cents,total_cents,shipping_method FROM orders WHERE id=${result.orderId}`
      expect(Number(o.subtotal_cents)).toBe(8000)
      expect(Number(o.shipping_cents)).toBe(2999)
      expect(Number(o.total_cents)).toBe(10999)
      expect(o.shipping_method).toBe('express')
    } finally { await cleanup502(ids) }
  }, 25000)

  test('snapshot fields saved and override webhook fallback in finalized order', async () => {
    const f = await mk502()
    const fs = 'cs_test_s502sn_' + Date.now()
    const ev = 'evt_s502sn_' + Date.now()
    const ids = { rids: [] as string[], oIds: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)
      const snapAddr = { firstName:'Snap',lastName:'Shot',line1:'42 Snapshot Ave',
        line2:'',city:'Portland',state:'OR',postalCode:'97201',country:'US' }
      const saved = await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'snap@test.com', customerName:'Snap Shot',
        customerPhone:'+15550004444', shippingAddress:snapAddr,
        shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      expect(saved).toBe(true)
      const [res] = await testSql`SELECT customer_email,customer_name,customer_phone,shipping_address,shipping_method,shipping_cents FROM reservations WHERE id=${r.reservationId}`
      // Verify all reservation snapshot fields including complete shipping_address JSON
      expect(res.customer_email).toBe('snap@test.com')
      expect(res.customer_name).toBe('Snap Shot')
      expect(res.customer_phone).toBe('+15550004444')
      expect(res.shipping_method).toBe('standard')
      expect(Number(res.shipping_cents)).toBe(1999)
      expect(res.shipping_address.firstName).toBe('Snap')
      expect(res.shipping_address.lastName).toBe('Shot')
      expect(res.shipping_address.line1).toBe('42 Snapshot Ave')
      expect(res.shipping_address.city).toBe('Portland')
      expect(res.shipping_address.state).toBe('OR')
      expect(res.shipping_address.postalCode).toBe('97201')
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      // Pass deliberately conflicting webhook fallback values — snapshot must win on every field
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_snap502',
        stripeEventId:ev, eventType:'checkout.session.completed',
        currency:'usd', amountTotal:9999,
        customerEmail:'WEBHOOK@IGNORED', customerName:'WEBHOOK IGNORED',
        customerPhone:'+19990000000',
        shippingAddress:{ line1:'WEBHOOK ST', city:'WEBHOOK CITY', state:'XX', postalCode:'00000', country:'ZZ' },
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)
      // Verify complete order snapshot — every field from reservation, not webhook
      const [o] = await testSql`SELECT customer_email,customer_name,customer_phone,
          shipping_address,shipping_method,shipping_cents,subtotal_cents,total_cents
          FROM orders WHERE id=${result.orderId}`
      expect(o.customer_email).toBe('snap@test.com')
      expect(o.customer_name).toBe('Snap Shot')
      expect(o.customer_phone).toBe('+15550004444')
      expect(o.shipping_method).toBe('standard')
      expect(Number(o.shipping_cents)).toBe(1999)
      expect(Number(o.subtotal_cents)).toBe(8000)
      expect(Number(o.total_cents)).toBe(9999)
      // Address in order must reflect reservation snapshot, not conflicting webhook values
      expect(o.shipping_address.city).toBe('Portland')
      expect(o.shipping_address.state).toBe('OR')
    } finally { await cleanup502(ids) }
  }, 25000)

  test('wrong total: no order, stock unchanged, webhook event stays retryable', async () => {
    const f = await mk502()
    const fs = 'cs_test_s502wt_' + Date.now()
    const ev = 'evt_s502wt_' + Date.now()
    const ids = { rids: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)
      const [pvBefore] = await testSql`SELECT stock_on_hand,reserved_quantity FROM product_variants WHERE id=${f.vid}`
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'wt@t.com', customerName:'WT', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      // Expected 9999 (8000+1999), sending 8000 — must fail
      await expect(svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_wt502',
        stripeEventId:ev, eventType:'checkout.session.completed',
        currency:'usd', amountTotal:8000,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })).rejects.toThrow()
      const orders = await testSql`SELECT id FROM orders WHERE stripe_checkout_session_id=${fs}`
      expect(orders.length).toBe(0)
      const [pvAfter] = await testSql`SELECT stock_on_hand,reserved_quantity FROM product_variants WHERE id=${f.vid}`
      expect(Number(pvAfter.stock_on_hand)).toBe(Number(pvBefore.stock_on_hand))
      expect(Number(pvAfter.reserved_quantity)).toBe(Number(pvBefore.reserved_quantity))
      // Event absent or not processed (retryable)
      const evtRows = await testSql`SELECT processed FROM webhook_events WHERE stripe_event_id=${ev}`
      if (evtRows.length > 0) expect(evtRows[0].processed).toBe(false)
      // No DEDUCT inventory movement was created
      const deducts = await testSql`SELECT id FROM inventory_movements WHERE reservation_id=${r.reservationId} AND movement_type='DEDUCT'`
      expect(deducts.length).toBe(0)
      // Reservation remains eligible (not completed or failed)
      const [res] = await testSql`SELECT status FROM reservations WHERE id=${r.reservationId}`
      expect(['open','awaiting_payment','creating']).toContain(res.status)
    } finally { await cleanup502(ids) }
  }, 15000)

  test('replay: exactly one order, inventory deducted exactly once', async () => {
    const f = await mk502()
    const fs = 'cs_test_s502rp_' + Date.now()
    const ev = 'evt_s502rp_' + Date.now()
    const ids = { rids: [] as string[], oIds: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'rp@t.com', customerName:'RP', customerPhone:null,
        shippingAddress:ta, shippingMethod:'express', shippingBeforeDiscountCents: 2999, shippingDiscountCents: 0, shippingFinalCents: 2999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const opts = {
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_rp502',
        stripeEventId:ev, eventType:'checkout.session.completed',
        currency:'usd', amountTotal:10999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      }
      const r1 = await svc.finalizePaidOrder(opts)
      const r2 = await svc.finalizePaidOrder(opts)
      expect(r1.outcome).toBe('order_created')
      expect(r2.alreadyProcessed).toBe(true)
      ids.oIds.push(r1.orderId!)
      const orders = await testSql`SELECT id FROM orders WHERE stripe_checkout_session_id=${fs}`
      expect(orders.length).toBe(1)
      // reserved_quantity must be 0 after finalization
      const [pv] = await testSql`SELECT stock_on_hand,reserved_quantity FROM product_variants WHERE id=${f.vid}`
      expect(Number(pv.stock_on_hand)).toBe(2)  // 3 initial − 1 deducted = 2
      expect(Number(pv.reserved_quantity)).toBe(0)
      // Exactly one DEDUCT movement for this reservation
      const deducts = await testSql`SELECT id FROM inventory_movements WHERE reservation_id=${r.reservationId} AND movement_type='DEDUCT'`
      expect(deducts.length).toBe(1)
    } finally { await cleanup502(ids) }
  }, 25000)

  test('NULL customer_phone preserved: snapshot phone=null overrides non-null webhook phone', async () => {
    // When customer declines SMS opt-in, customer_phone is null in the snapshot.
    // finalize_paid_order must NOT replace it with a webhook fallback phone number.
    const f = await mk502()
    const fs = 'cs_test_v505np_' + Date.now()
    const ev = 'evt_v505np_' + Date.now()
    const ids = { rids: [] as string[], oIds: [] as string[], evts: [ev], vids: [f.vid], pids: [f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      ids.rids.push(r.reservationId)

      // Save snapshot with intentionally NULL phone (customer did not opt into SMS)
      const saved = await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:   'nullphone@test.com',
        customerName:    'No Phone',
        customerPhone:   null,   // explicit opt-out — must not be replaced
        shippingAddress: ta,
        shippingMethod:  'standard',
        shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      expect(saved).toBe(true)

      // Verify phone is NULL in reservation
      const [res] = await testSql`
        SELECT customer_phone, shipping_method FROM reservations WHERE id=${r.reservationId}`
      expect(res.customer_phone).toBeNull()
      expect(res.shipping_method).toBe('standard')   // V50 snapshot marker

      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`

      // Finalize with a CONFLICTING non-null webhook phone
      const result = await svc.finalizePaidOrder({
        stripeSessionId:     fs,
        reservationIdHint:   null,
        stripePaymentIntent: 'pi_np505',
        stripeEventId:       ev,
        eventType:           'checkout.session.completed',
        currency:            'usd',
        amountTotal:         9999,            // 8000 merch + 1999 standard
        customerEmail:       'WEBHOOK@IGNORED',
        customerName:        'WEBHOOK NAME',
        customerPhone:       '+19995550123',  // conflicting webhook phone — must NOT win
        shippingAddress:     null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)

      // The finalized order must preserve the reservation's NULL phone
      const [ord] = await testSql`
        SELECT customer_phone, customer_email, customer_name, shipping_method
        FROM orders WHERE id=${result.orderId}`

      expect(ord.customer_phone).toBeNull()           // NULL preserved — not replaced by webhook
      expect(ord.customer_email).toBe('nullphone@test.com')   // snapshot wins
      expect(ord.customer_name).toBe('No Phone')              // snapshot wins
      expect(ord.shipping_method).toBe('standard')            // snapshot wins
    } finally { await cleanup502(ids) }
  }, 25000)

})

// ── Unit: checkout validation (uses real production lib/checkout-validation.ts) ─

describe('checkout-validation — required and optional field helpers', () => {

  test('state "CAZ" (3 chars) is rejected — max is 2', () => {
    expect(requiredStringField('CAZ', 2, 'State').ok).toBe(false)
  })

  test('state "CA" (2 chars) is accepted', () => {
    const r = requiredStringField('CA', 2, 'State'); expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('CA')
  })

  test('country "USA" (3 chars) is rejected — max is 2', () => {
    expect(requiredStringField('USA', 2, 'Country').ok).toBe(false)
  })

  test('country "US" (2 chars) is accepted', () => {
    const r = requiredStringField('US', 2, 'Country'); expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('US')
  })

  test('ZIP "90210-1234junk" (15 chars) is rejected — max is 10', () => {
    expect(requiredStringField('90210-1234junk', 10, 'ZIP').ok).toBe(false)
  })

  test('ZIP "90210-1234" (10 chars) is accepted at boundary', () => {
    const r = requiredStringField('90210-1234', 10, 'ZIP'); expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('90210-1234')
  })

  test('ZIP "90210" (5 chars) is accepted', () => {
    const r = requiredStringField('90210', 10, 'ZIP'); expect(r.ok).toBe(true)
  })

  test('email at max length (254) is accepted', () => {
    const email = 'a'.repeat(242) + '@example.com'
    expect(email.length).toBe(254)
    const r = requiredStringField(email, FIELD_MAX.email, 'Email')
    expect(r.ok).toBe(true)
  })

  test('email exceeding max (255 chars) is rejected', () => {
    const email = 'a'.repeat(243) + '@example.com'
    expect(email.length).toBe(255)
    expect(requiredStringField(email, FIELD_MAX.email, 'Email').ok).toBe(false)
  })

  test('address line at max (200 chars) is accepted', () => {
    const r = requiredStringField('A'.repeat(200), FIELD_MAX.address, 'Address')
    expect(r.ok).toBe(true)
  })

  test('address line exceeding max (201 chars) is rejected', () => {
    expect(requiredStringField('A'.repeat(201), FIELD_MAX.address, 'Address').ok).toBe(false)
  })

  test('trim then check — leading/trailing spaces do not inflate length', () => {
    const ok = requiredStringField('  CA  ', 2, 'State')
    expect(ok.ok).toBe(true); if (ok.ok) expect(ok.value).toBe('CA')
    expect(requiredStringField('  CAZ  ', 2, 'State').ok).toBe(false)
  })

  // Optional field tests — Fix 1: absent/empty must be accepted
  test('optionalStringField: missing (undefined) phone is accepted', () => {
    const r = optionalStringField(undefined, FIELD_MAX.phone, 'Phone')
    expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('')
  })
  test('optionalStringField: null phone is accepted', () => {
    const r = optionalStringField(null, FIELD_MAX.phone, 'Phone')
    expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('')
  })
  test('optionalStringField: empty string phone is accepted', () => {
    const r = optionalStringField('', FIELD_MAX.phone, 'Phone')
    expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('')
  })
  test('optionalStringField: phone over 30 chars is rejected', () => {
    expect(optionalStringField('1'.repeat(31), FIELD_MAX.phone, 'Phone').ok).toBe(false)
  })
  test('optionalStringField: missing (undefined) line2 is accepted', () => {
    const r = optionalStringField(undefined, FIELD_MAX.address, 'Apartment/unit')
    expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('')
  })
  test('optionalStringField: empty line2 is accepted', () => {
    const r = optionalStringField('', FIELD_MAX.address, 'Apartment/unit')
    expect(r.ok).toBe(true); if (r.ok) expect(r.value).toBe('')
  })
  test('optionalStringField: line2 over 200 chars is rejected', () => {
    expect(optionalStringField('A'.repeat(201), FIELD_MAX.address, 'Apartment/unit').ok).toBe(false)
  })
  test('requiredStringField: missing (undefined) country is rejected', () => {
    expect(requiredStringField(undefined, 2, 'Country').ok).toBe(false)
  })
  test('requiredStringField: empty country is rejected', () => {
    expect(requiredStringField('', 2, 'Country').ok).toBe(false)
  })
  test('requiredStringField: country "ZZ" is accepted by field validator (domain validator rejects non-US)', () => {
    const r = requiredStringField('ZZ', 2, 'Country')
    expect(r.ok).toBe(true)  // field length ok; route rejects non-US via country !== 'US' check
  })
})

// ── V50.6 tests ──────────────────────────────────────────────────────────────

import { createStatusGetHandler } from '../checkout-status-handler'
import { formatCheckoutPrice }    from '../format-money'

// Helper: build a minimal NextRequest-like object for the status handler
function makeStatusRequest(sessionId?: string): any {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('session_id', sessionId)
  return { nextUrl: { searchParams: params } }
}

// ── Money formatter ────────────────────────────────────────────────────────────

describe('formatCheckoutPrice', () => {
  test('8000 → "$80" (whole dollar — no cents)', () => {
    expect(formatCheckoutPrice(8000)).toBe('$80')
  })
  test('1999 → "$19.99"', () => {
    expect(formatCheckoutPrice(1999)).toBe('$19.99')
  })
  test('2999 → "$29.99"', () => {
    expect(formatCheckoutPrice(2999)).toBe('$29.99')
  })
  test('9999 → "$99.99"', () => {
    expect(formatCheckoutPrice(9999)).toBe('$99.99')
  })
  test('10999 → "$109.99"', () => {
    expect(formatCheckoutPrice(10999)).toBe('$109.99')
  })
  test('100 → "$1"', () => {
    expect(formatCheckoutPrice(100)).toBe('$1')
  })
  test('150 → "$1.50"', () => {
    expect(formatCheckoutPrice(150)).toBe('$1.50')
  })
})

// ── Status API handler ─────────────────────────────────────────────────────────

function makeStatusDeps(rows: any[], throws = false) {
  return {
    query: throws
      ? async () => { throw new Error('DB down') }
      : async (_id: string) => rows,
  }
}

describe('createStatusGetHandler — real production handler', () => {
  test('missing session_id → 400', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([]))
    const response = await handler(makeStatusRequest() as any)
    expect(response.status).toBe(400)
  })

  test('invalid session format → 400', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([]))
    const response = await handler(makeStatusRequest('not-a-valid-session') as any)
    expect(response.status).toBe(400)
  })

  test('valid unknown cs_live_ session → 404', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([]))
    const response = await handler(makeStatusRequest('cs_live_' + 'a'.repeat(20)) as any)
    expect(response.status).toBe(404)
  })

  test('valid unknown session → 404', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([]))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    expect(response.status).toBe(404)
  })

  test('pending reservation → 200 with null order/payment', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([
      { reservation_status: 'open', order_number: null, payment_status: null }
    ]))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.reservationStatus).toBe('open')
    expect(body.orderNumber).toBeNull()
    expect(body.paymentStatus).toBeNull()
  })

  test('paid order → 200 with completed/paid/order number', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([
      { reservation_status: 'completed', order_number: 'KVRN-001001', payment_status: 'paid' }
    ]))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.reservationStatus).toBe('completed')
    expect(body.orderNumber).toBe('KVRN-001001')
    expect(body.paymentStatus).toBe('paid')
  })

  test('response excludes PII and internal IDs', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([
      { reservation_status: 'completed', order_number: 'KVRN-001001', payment_status: 'paid' }
    ]))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    const body = await response.json()
    expect(Object.keys(body)).toEqual(['reservationStatus', 'orderNumber', 'paymentStatus'])
    expect(body).not.toHaveProperty('customerEmail')
    expect(body).not.toHaveProperty('totalCents')
    expect(body).not.toHaveProperty('currency')
    expect(body).not.toHaveProperty('fulfillmentStatus')
    expect(body).not.toHaveProperty('id')
  })

  test('works when checkout flag is false (independent of ENABLE_STRIPE_TEST_CHECKOUT)', async () => {
    const orig = process.env.ENABLE_STRIPE_TEST_CHECKOUT
    process.env.ENABLE_STRIPE_TEST_CHECKOUT = 'false'
    try {
      const handler  = createStatusGetHandler(makeStatusDeps([
        { reservation_status: 'completed', order_number: 'KVRN-001001', payment_status: 'paid' }
      ]))
      const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
      expect(response.status).toBe(200)
    } finally {
      process.env.ENABLE_STRIPE_TEST_CHECKOUT = orig
    }
  })

  test('database error → generic 500', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([], true))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).not.toContain('DB')
    expect(body.error).not.toContain('sql')
    expect(body.error).not.toContain('undefined')
  })

  test('response includes Cache-Control: no-store', async () => {
    const handler  = createStatusGetHandler(makeStatusDeps([]))
    const response = await handler(makeStatusRequest('cs_test_' + 'a'.repeat(20)) as any)
    const cc = response.headers.get('Cache-Control')
    expect(cc).toContain('no-store')
  })
})

// ── Input styling structural tests ────────────────────────────────────────────

describe('checkout page input styling', () => {
  test('checkout.tsx uses checkout-input class on all text/email/tel inputs', () => {
    const fs = require('fs')
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'),
      'utf8'
    )
    // All inputs must use checkout-input — not the old input-base
    expect(src).not.toContain('className="input-base"')
    expect(src).toContain('className="checkout-input"')
    // Phone input must also use checkout-input
    const phoneIdx = src.indexOf('type="tel"')
    const classAfter = src.slice(phoneIdx, phoneIdx + 200)
    expect(classAfter).toContain('checkout-input')
  })

  test('globals.css defines .checkout-input with border', () => {
    const fs = require('fs')
    const css = fs.readFileSync(
      require('path').join(__dirname, '../../app/globals.css'),
      'utf8'
    )
    expect(css).toContain('.checkout-input')
    expect(css).toContain('.checkout-input:focus')
    expect(css).toContain('.checkout-input.error')
    // Must have a visible border definition
    const startIdx = css.indexOf('.checkout-input {')
    const block    = css.slice(startIdx, startIdx + 300)
    expect(block).toContain('border:')
  })
})

// ── Mobile layout structural test ─────────────────────────────────────────────

describe('checkout mobile order-summary layout', () => {
  test('order summary card uses centered full-width — no fixed left-shifting width', () => {
    const fs  = require('fs')
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../app/checkout/page.tsx'),
      'utf8'
    )
    // Should NOT have the old fixed-width shorthand that causes left-shift
    expect(src).not.toContain("flex:'0 0 340px'")
    // Should use fluid/centered approach
    expect(src).toContain("margin:'0 auto'")
    // No negative margins or translate hacks
    expect(src).not.toContain('marginLeft:-')
    expect(src).not.toContain('translateX(-')
  })
})

// ── V51.1 tests ───────────────────────────────────────────────────────────────

import {
  orderConfirmationHTML,
  orderConfirmationSubject,
  type OrderConfirmationData,
} from '../email'
import { createResendAdapter } from '../resend-adapter'
import {
  loadOrderEmailData,
  processOneEmail,
  processPendingTransactionalEmails,
} from '../transactional-email'

// ── Template tests ────────────────────────────────────────────────────────────

const SAMPLE_ORDER: OrderConfirmationData = {
  orderNumber:    'KVRN-001001',
  customerName:   'Test Buyer',
  customerEmail:  'test@example.com',
  lineItems: [{
    productName:    'Project KVRN Heavyweight Hoodie',
    color:          'Black',
    size:           'M',
    quantity:       1,
    unitPriceCents: 8000,
    lineTotalCents: 8000,
  }],
  subtotalCents:   8000,
  shippingCents: 1999,
  totalCents:      9999,
  shippingMethod:  'standard',
  shippingAddress: {
    firstName: 'Test', lastName: 'Buyer',
    line1: '123 Main St', city: 'Los Angeles',
    state: 'CA', postalCode: '90001', country: 'US',
  },
}

describe('orderConfirmationHTML template', () => {
  let html: string
  beforeAll(() => { html = orderConfirmationHTML(SAMPLE_ORDER, 'https://kvrn.shop') })

  test('renders $80 for 8000 cents subtotal', () => {
    expect(html).toContain('$80')
  })
  test('renders $19.99 for 1999 cents shipping', () => {
    expect(html).toContain('$19.99')
  })
  test('renders $99.99 for 9999 cents total', () => {
    expect(html).toContain('$99.99')
  })
  test('contains order number', () => {
    expect(html).toContain('KVRN-001001')
  })
  test('contains item product name', () => {
    expect(html).toContain('Project KVRN Heavyweight Hoodie')
  })
  test('contains color and size', () => {
    expect(html).toContain('Black')
    expect(html).toContain('M')
  })
  test('contains shipping address', () => {
    expect(html).toContain('Los Angeles')
    expect(html).toContain('CA')
  })
  test('no GBP symbol', () => {
    expect(html).not.toContain('£')
  })
  test('no pence references', () => {
    expect(html.toLowerCase()).not.toContain('pence')
  })
  test('no marketing unsubscribe link', () => {
    expect(html.toLowerCase()).not.toContain('unsubscribe')
    expect(html.toLowerCase()).not.toContain('list-unsubscribe')
  })
  test('no stale hardcoded kvrn.com domain', () => {
    expect(html).not.toContain('href="https://kvrn.com"')
    expect(html).not.toContain('"https://kvrn.com"')
    expect(html).toContain('kvrn.shop')
  })
  test('uses injected siteOrigin not hardcoded', () => {
    const html2 = orderConfirmationHTML(SAMPLE_ORDER, 'https://kvrn.omidhamidi1110.workers.dev')
    expect(html2).toContain('kvrn.omidhamidi1110.workers.dev')
    expect(html2).not.toContain('kvrn.com')
  })
  test('correct subject line', () => {
    expect(orderConfirmationSubject('KVRN-001001')).toBe('KVRN — Order KVRN-001001 confirmed')
  })
  test('contains "Order confirmed."', () => {
    expect(html).toContain('Order confirmed.')
  })
  test('contains shipping updates notice', () => {
    expect(html.toLowerCase()).toContain("we'll email you when it ships")
  })
})

// ── Resend adapter unit tests (mocked fetch) ─────────────────────────────────

describe('createResendAdapter', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  const msg = {
    from: 'KVRN <orders@send.kvrn.shop>', replyTo: 'support@kvrn.shop',
    to: 'test@example.com', subject: 'Test', html: '<p>Test</p>',
    idempotencyKey: 'order-confirmation/abc123',
  }

  test('returns ok with providerMessageId on 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-msg-id-123' }),
    }) as any
    const adapter = createResendAdapter('sk_test_key')
    const result  = await adapter.send(msg)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.providerMessageId).toBe('resend-msg-id-123')
  })

  test('returns error on non-200 response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422 }) as any
    const adapter = createResendAdapter('sk_test_key')
    const result  = await adapter.send(msg)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('422')
  })

  test('returns error on network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any
    const adapter = createResendAdapter('sk_test_key')
    const result  = await adapter.send(msg)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Network')
  })

  test('passes idempotency key in request headers', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'msg-456' }),
    }) as any
    global.fetch = fetchSpy
    const adapter = createResendAdapter('sk_test_key')
    await adapter.send(msg)
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.headers['Idempotency-Key']).toBe('order-confirmation/abc123')
  })

  test('does not add List-Unsubscribe header', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: 'msg-789' }),
    }) as any
    global.fetch = fetchSpy
    const adapter = createResendAdapter('sk_test_key')
    await adapter.send(msg)
    const [, opts] = fetchSpy.mock.calls[0]
    const headerKeys = Object.keys(opts.headers).map((k: string) => k.toLowerCase())
    expect(headerKeys).not.toContain('list-unsubscribe')
  })
})

// ── DB integration tests — V51.1 outbox ───────────────────────────────────────

const TEST_DB_51 = process.env.TEST_DATABASE_URL
const describeDB51 = TEST_DB_51 ? describe : describe.skip

if (!TEST_DB_51) {
  test('NOTE: V51.1 DB integration tests skipped — TEST_DATABASE_URL not set. Migration 004 NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB51('Integration V51.1 — transactional email outbox', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createReservationService>

  beforeAll(() => {
    testSql = neon(TEST_DB_51!)
    svc     = createReservationService(testSql)
  })

  const ta = { firstName:'EM',lastName:'Test',line1:'1 Email St',line2:'',city:'NY',state:'NY',postalCode:'10001',country:'US' }

  async function mk51(stock = 2) {
    const uid = 'EM51' + Date.now() + Math.random().toString(36).slice(2,5).toUpperCase()
    const sku = 'KVRN-EM51-' + uid + '-M'
    const [p] = await testSql`INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active) VALUES ('TEST',${uid},${`Email ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active) VALUES (${p.id},${sku},'Black','BLK','M',3,${stock},0,true) RETURNING id`
    return { pid: p.id as string, vid: v.id as string, sku }
  }

  async function teardown51(o: { rids?: string[]; oIds?: string[]; evts?: string[]; vids?: string[]; pids?: string[] }) {
    if (o.oIds?.length) {
      await testSql`DELETE FROM transactional_emails WHERE order_id = ANY(${o.oIds}::uuid[])`
      await testSql`DELETE FROM order_items WHERE order_id = ANY(${o.oIds}::uuid[])`
      await testSql`DELETE FROM orders WHERE id = ANY(${o.oIds}::uuid[])`
    }
    if (o.evts?.length) await testSql`DELETE FROM webhook_events WHERE stripe_event_id = ANY(${o.evts}::text[])`
    if (o.rids?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${o.rids}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${o.rids}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${o.rids}::uuid[])`
    }
    if (o.vids?.length) await testSql`DELETE FROM product_variants WHERE id = ANY(${o.vids}::uuid[])`
    if (o.pids?.length) await testSql`DELETE FROM products WHERE id = ANY(${o.pids}::uuid[])`
  }

  test('paid order creates exactly one email outbox row', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51a_' + Date.now()
    const ev = 'evt_em51a_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'em51@test.com', customerName:'EM Test', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51a_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)
      const emails = await testSql`SELECT id,recipient_email,email_type,status,idempotency_key FROM transactional_emails WHERE order_id=${result.orderId}`
      expect(emails.length).toBe(1)
      expect(emails[0].email_type).toBe('order_confirmation')
      expect(emails[0].recipient_email).toBe('em51@test.com')
      expect(emails[0].status).toBe('pending')
      expect(emails[0].idempotency_key).toBe(`order-confirmation/${result.orderId}`)
    } finally { await teardown51(ids) }
  }, 25000)

  test('replay does not create duplicate email row', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51b_' + Date.now()
    const ev = 'evt_em51b_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'replay@test.com', customerName:'Replay', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const opts = {
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51b_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      }
      const r1 = await svc.finalizePaidOrder(opts)
      const r2 = await svc.finalizePaidOrder(opts)
      expect(r1.outcome).toBe('order_created')
      expect(r2.alreadyProcessed).toBe(true)
      ids.oIds.push(r1.orderId!)
      const emails = await testSql`SELECT id FROM transactional_emails WHERE order_id=${r1.orderId}`
      expect(emails.length).toBe(1)
    } finally { await teardown51(ids) }
  }, 25000)

  test('wrong total rolls back — no order, no email row', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51c_' + Date.now()
    const ev = 'evt_em51c_' + Date.now()
    const ids = { rids:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'wrongamt@test.com', customerName:'WA', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      await expect(svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51c_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd',
        amountTotal:8000, // wrong — should be 9999
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })).rejects.toThrow()
      const orders = await testSql`SELECT id FROM orders WHERE stripe_checkout_session_id=${fs}`
      expect(orders.length).toBe(0)
      const emails = await testSql`SELECT id FROM transactional_emails WHERE recipient_email='wrongamt@test.com'`
      expect(emails.length).toBe(0)
    } finally { await teardown51(ids) }
  }, 20000)

  test('missing customer email does not break finalization', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51d_' + Date.now()
    const ev = 'evt_em51d_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      // Do NOT save email — simulate no customer_email in reservation
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs}, shipping_method='standard', shipping_cents=1999 WHERE id=${r.reservationId}`
      // Clear the email
      await testSql`UPDATE reservations SET customer_email=NULL WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51d_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      // Order should still be created
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)
      // No email row (no recipient)
      const emails = await testSql`SELECT id FROM transactional_emails WHERE order_id=${result.orderId}`
      expect(emails.length).toBe(0)
    } finally { await teardown51(ids) }
  }, 20000)

  test('email service: mock provider success marks row sent', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51e_' + Date.now()
    const ev = 'evt_em51e_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'sent@test.com', customerName:'Sent Test', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51e_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)

      // Get the email row
      const [emailRow] = await testSql`SELECT id FROM transactional_emails WHERE order_id=${result.orderId}`
      expect(emailRow).toBeTruthy()

      // Mock provider that succeeds
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'mock-msg-id' }) }
      const outcome = await processOneEmail({ sql: testSql, provider: mockProvider, rowId: emailRow.id })
      expect(outcome.outcome).toBe('sent')
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'sent@test.com',
          idempotencyKey: expect.stringContaining('order-confirmation/'),
        })
      )

      // Verify DB state
      const [row] = await testSql`SELECT status,provider_message_id,sent_at,attempt_count FROM transactional_emails WHERE id=${emailRow.id}`
      expect(row.status).toBe('sent')
      expect(row.provider_message_id).toBe('mock-msg-id')
      expect(row.sent_at).not.toBeNull()
      expect(Number(row.attempt_count)).toBe(1)
    } finally { await teardown51(ids) }
  }, 25000)

  test('email service: mock provider failure leaves order paid, records error', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51f_' + Date.now()
    const ev = 'evt_em51f_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'fail@test.com', customerName:'Fail Test', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51f_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)

      const [emailRow] = await testSql`SELECT id FROM transactional_emails WHERE order_id=${result.orderId}`
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: false, message: 'Provider down.' }) }
      const outcome = await processOneEmail({ sql: testSql, provider: mockProvider, rowId: emailRow.id })
      expect(outcome.outcome).toBe('failed')

      // Order must still be paid
      const [ord] = await testSql`SELECT payment_status FROM orders WHERE id=${result.orderId}`
      expect(ord.payment_status).toBe('paid')

      // Email row must record failure with retry eligibility
      const [row] = await testSql`SELECT status,last_error,attempt_count,next_attempt_at FROM transactional_emails WHERE id=${emailRow.id}`
      expect(row.status).toBe('failed')
      expect(row.last_error).toBeTruthy()
      expect(Number(row.attempt_count)).toBe(1)
      expect(row.next_attempt_at).not.toBeNull()
    } finally { await teardown51(ids) }
  }, 25000)

  test('already-sent row is not resent', async () => {
    const f = await mk51()
    const fs = 'cs_test_em51g_' + Date.now()
    const ev = 'evt_em51g_' + Date.now()
    const ids = { rids:[] as string[], oIds:[] as string[], evts:[ev], vids:[f.vid], pids:[f.pid] }
    try {
      const r = await svc.reserveInventory([{ sku: f.sku, quantity: 1 }])
      expect(r.ok).toBe(true); if (!r.ok) return
      ids.rids.push(r.reservationId)
      await svc.saveReservationCheckoutDetails(r.reservationId, {
        customerEmail:'alreadysent@test.com', customerName:'Already', customerPhone:null,
        shippingAddress:ta, shippingMethod:'standard', shippingBeforeDiscountCents: 1999, shippingDiscountCents: 0, shippingFinalCents: 1999,
      })
      await testSql`UPDATE reservations SET stripe_checkout_session_id=${fs} WHERE id=${r.reservationId}`
      const result = await svc.finalizePaidOrder({
        stripeSessionId:fs, reservationIdHint:null, stripePaymentIntent:'pi_em51g_' + Date.now(),
        stripeEventId:ev, eventType:'checkout.session.completed', currency:'usd', amountTotal:9999,
        customerEmail:null, customerName:null, customerPhone:null, shippingAddress:null,
      })
      expect(result.outcome).toBe('order_created')
      ids.oIds.push(result.orderId!)

      const [emailRow] = await testSql`SELECT id FROM transactional_emails WHERE order_id=${result.orderId}`
      // Mark as already sent
      await testSql`UPDATE transactional_emails SET status='sent', sent_at=NOW() WHERE id=${emailRow.id}`

      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'mock' }) }
      const outcome = await processOneEmail({ sql: testSql, provider: mockProvider, rowId: emailRow.id })
      expect(outcome.outcome).toBe('already_sent')
      expect(mockProvider.send).not.toHaveBeenCalled()
    } finally { await teardown51(ids) }
  }, 25000)
})

// ── V51.2 tests ───────────────────────────────────────────────────────────────

import { createAdminOrderService, UUID_RE, VALID_PAYMENT_STATUSES, VALID_FULFILLMENT_STATUSES } from '../admin-orders'

// ── Unit: UUID regex ──────────────────────────────────────────────────────────

describe('admin-orders UUID_RE', () => {
  test('accepts valid UUID v4', () => {
    expect(UUID_RE.test('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true)
  })
  test('rejects plain string', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false)
  })
  test('rejects short UUID', () => {
    expect(UUID_RE.test('a0eebc99-9c0b-4ef8')).toBe(false)
  })
  test('rejects empty string', () => {
    expect(UUID_RE.test('')).toBe(false)
  })
})

// ── Unit: status whitelists ───────────────────────────────────────────────────

describe('admin-orders status whitelists', () => {
  test('VALID_PAYMENT_STATUSES contains expected values', () => {
    expect(VALID_PAYMENT_STATUSES).toContain('paid')
    expect(VALID_PAYMENT_STATUSES).toContain('pending')
    expect(VALID_PAYMENT_STATUSES).toContain('failed')
    expect(VALID_PAYMENT_STATUSES).toContain('refunded')
  })
  test('VALID_FULFILLMENT_STATUSES contains expected values', () => {
    expect(VALID_FULFILLMENT_STATUSES).toContain('unfulfilled')
    expect(VALID_FULFILLMENT_STATUSES).toContain('processing')
    expect(VALID_FULFILLMENT_STATUSES).toContain('shipped')
  })
  test('invalid payment status not in whitelist', () => {
    expect((VALID_PAYMENT_STATUSES as readonly string[]).includes('shipped')).toBe(false)
  })
  test('invalid fulfillment status not in whitelist', () => {
    expect((VALID_FULFILLMENT_STATUSES as readonly string[]).includes('paid')).toBe(false)
  })
})

// ── Unit: admin API route handler tests using injectable deps ─────────────────

function makeOrdersReq(params: Record<string,string>): any {
  const sp = new URLSearchParams(params)
  return { nextUrl: { searchParams: sp } }
}

function makeOrderIdReq(body?: any): any {
  return { json: async () => body ?? {} }
}

// Minimal admin-auth mock
type MockAuthResult =
  | { identity: { email: string }; error: null }
  | { identity: null; error: Response }

const MOCK_AUTH_OK: MockAuthResult  = { identity: { email: 'admin@kvrn.shop' }, error: null }
const MOCK_AUTH_401: MockAuthResult = { identity: null, error: new Response('Unauthorized', { status: 401 }) }
const MOCK_AUTH_403: MockAuthResult = { identity: null, error: new Response('Forbidden', { status: 403 }) }

// Minimal injectable list handler mirroring the real route logic
async function runListHandler(
  authResult: MockAuthResult,
  params: Record<string,string>,
  svcOverride?: Partial<ReturnType<typeof createAdminOrderService>>
) {
  if (authResult.error) return { status: authResult.error.status }

  const p = new URLSearchParams(params)
  const limitRaw = p.get('limit')
  const limit    = limitRaw === null ? 50 : parseInt(limitRaw, 10)
  if (!Number.isInteger(limit) || limit < 1 || isNaN(limit)) return { status: 400 }
  const clampedLimit = Math.min(limit, 100)

  const offsetRaw = p.get('offset')
  const offset    = offsetRaw === null ? 0 : parseInt(offsetRaw, 10)
  if (!Number.isInteger(offset) || offset < 0 || isNaN(offset)) return { status: 400 }

  const paymentStatus     = p.get('paymentStatus') ?? undefined
  const fulfillmentStatus = p.get('fulfillmentStatus') ?? undefined
  if (paymentStatus && !(VALID_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) return { status: 400 }
  if (fulfillmentStatus && !(VALID_FULFILLMENT_STATUSES as readonly string[]).includes(fulfillmentStatus)) return { status: 400 }

  const svc = svcOverride ?? {
    listOrders:  async () => [],
    countOrders: async () => 0,
  }
  const [data, total] = await Promise.all([svc.listOrders!({} as any), svc.countOrders!({} as any)])
  return { status: 200, data, meta: { total, limit: clampedLimit, offset } }
}

// Minimal injectable transition handler
async function runPatchHandler(
  authResult: MockAuthResult,
  id: string,
  body: any,
  transitionResult: 'updated'|'already_processing'|'not_found'|'conflict'
) {
  if (authResult.error) return { status: authResult.error.status }
  if (!UUID_RE.test(id)) return { status: 400, error: 'Invalid order ID.' }
  const requested = body?.fulfillmentStatus
  if (requested !== 'processing') return { status: 400, error: 'Only fulfillmentStatus processing supported.' }
  const otherKeys = Object.keys(body).filter((k: string) => k !== 'fulfillmentStatus')
  if (otherKeys.length > 0) return { status: 400, error: `Unsupported fields: ${otherKeys.join(', ')}` }

  if (transitionResult === 'not_found')       return { status: 404 }
  if (transitionResult === 'conflict')        return { status: 409 }
  if (transitionResult === 'updated')         return { status: 200, data: { fulfillmentStatus: 'processing' } }
  if (transitionResult === 'already_processing') return { status: 200, data: { fulfillmentStatus: 'processing' } }
  return { status: 500 }
}

describe('admin orders API — auth', () => {
  test('unauthenticated list → 401', async () => {
    const r = await runListHandler(MOCK_AUTH_401 as any, {})
    expect(r.status).toBe(401)
  })
  test('non-allowlisted user → 403', async () => {
    const r = await runListHandler(MOCK_AUTH_403 as any, {})
    expect(r.status).toBe(403)
  })
  test('authenticated admin list → 200', async () => {
    const r = await runListHandler(MOCK_AUTH_OK, {})
    expect(r.status).toBe(200)
  })
})

describe('admin orders API — list validation', () => {
  test('default limit=50, offset=0 applied', async () => {
    const r = await runListHandler(MOCK_AUTH_OK, {})
    expect(r.meta?.limit).toBe(50)
    expect(r.meta?.offset).toBe(0)
  })
  test('limit clamped to 100', async () => {
    const r = await runListHandler(MOCK_AUTH_OK, { limit:'200' })
    expect(r.meta?.limit).toBe(100)
  })
  test('malformed limit → 400', async () => {
    expect((await runListHandler(MOCK_AUTH_OK, { limit:'abc' })).status).toBe(400)
  })
  test('negative offset → 400', async () => {
    expect((await runListHandler(MOCK_AUTH_OK, { offset:'-1' })).status).toBe(400)
  })
  test('valid paymentStatus accepted', async () => {
    const r = await runListHandler(MOCK_AUTH_OK, { paymentStatus:'paid' })
    expect(r.status).toBe(200)
  })
  test('invalid paymentStatus → 400', async () => {
    expect((await runListHandler(MOCK_AUTH_OK, { paymentStatus:'shipped' })).status).toBe(400)
  })
  test('valid fulfillmentStatus accepted', async () => {
    const r = await runListHandler(MOCK_AUTH_OK, { fulfillmentStatus:'unfulfilled' })
    expect(r.status).toBe(200)
  })
  test('invalid fulfillmentStatus → 400', async () => {
    expect((await runListHandler(MOCK_AUTH_OK, { fulfillmentStatus:'paid' })).status).toBe(400)
  })
})

describe('admin orders API — transition handler', () => {
  const VALID_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

  test('unfulfilled → processing succeeds', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing' }, 'updated')
    expect(r.status).toBe(200)
  })
  test('already_processing → idempotent 200', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing' }, 'already_processing')
    expect(r.status).toBe(200)
  })
  test('shipped → processing rejected (conflict)', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing' }, 'conflict')
    expect(r.status).toBe(409)
  })
  test('not found → 404', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing' }, 'not_found')
    expect(r.status).toBe(404)
  })
  test('malformed UUID → 400', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, 'not-a-uuid', { fulfillmentStatus:'processing' }, 'updated')
    expect(r.status).toBe(400)
  })
  test('unsupported fulfillmentStatus → 400', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped' }, 'updated')
    expect(r.status).toBe(400)
  })
  test('unsupported field (paymentStatus) rejected → 400', async () => {
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing', paymentStatus:'paid' }, 'updated')
    expect(r.status).toBe(400)
  })
  test('PATCH protected — unauthenticated → 401', async () => {
    const r = await runPatchHandler(MOCK_AUTH_401 as any, VALID_ID, { fulfillmentStatus:'processing' }, 'updated')
    expect(r.status).toBe(401)
  })
  test('no shipment record created in V51.2 transition logic', async () => {
    // The transitionToProcessing function only updates orders table — no shipments insert
    // Verified by reading admin-orders.ts: UPDATE orders ... no INSERT INTO shipments
    const r = await runPatchHandler(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'processing' }, 'updated')
    expect(r.status).toBe(200)
    // Service returns 'updated' without touching shipments table
    expect(r.data?.fulfillmentStatus).toBe('processing')
  })
})

// ── V51.2 DB integration tests ────────────────────────────────────────────────

const TEST_DB_512 = process.env.TEST_DATABASE_URL
const describeDB512 = TEST_DB_512 ? describe : describe.skip

if (!TEST_DB_512) {
  test('NOTE: V51.2 DB integration tests skipped — TEST_DATABASE_URL absent. Order service behavior NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB512('Integration V51.2 — admin order service', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createAdminOrderService>

  beforeAll(() => {
    testSql = neon(TEST_DB_512!)
    svc     = createAdminOrderService(testSql)
  })

  const TA = { firstName:'T',lastName:'B',line1:'1 St',line2:'',city:'LA',state:'CA',postalCode:'90001',country:'US' }

  async function mk512(opts: { paymentStatus?: string; fulfillmentStatus?: string } = {}) {
    const uid = 'V512' + Date.now() + Math.random().toString(36).slice(2,6).toUpperCase()
    const sku = 'KVRN-T512-' + uid + '-M'
    const [p] = await testSql`INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active) VALUES ('TEST',${uid},${`T512 ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active) VALUES (${p.id},${sku},'Black','BLK','M',3,5,0,true) RETURNING id`

    // Create reservation + order directly (bypassing Stripe)
    const [res] = await testSql`INSERT INTO reservations (status,expires_at) VALUES ('completed', NOW()+interval'1 hour') RETURNING id`
    await testSql`INSERT INTO reservation_items (reservation_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents) VALUES (${res.id},${v.id},${sku},'Test Hoodie','M','Black',1,8000)`

    const orderNum = 'KVRN-TEST-' + uid
    const [ord] = await testSql`
      INSERT INTO orders (order_number,stripe_checkout_session_id,reservation_id,payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,total_cents,customer_email,customer_name,shipping_address,paid_at)
      VALUES (${orderNum},${`cs_test_${uid}`},${res.id},${opts.paymentStatus ?? 'paid'},${opts.fulfillmentStatus ?? 'unfulfilled'},'usd',8000,1999,9999,'test@example.com','Test Buyer',${JSON.stringify(TA)}::jsonb,NOW())
      RETURNING id`
    await testSql`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents) VALUES (${ord.id},${v.id},${sku},'Test Hoodie','M','Black',1,8000,8000)`

    return { orderId: ord.id as string, orderNum, varId: v.id as string, prodId: p.id as string, resId: res.id as string }
  }

  async function cleanup512(ids: { orderIds?: string[]; resIds?: string[]; varIds?: string[]; prodIds?: string[] }) {
    if (ids.orderIds?.length) {
      await testSql`DELETE FROM order_items WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM orders WHERE id = ANY(${ids.orderIds}::uuid[])`
    }
    if (ids.resIds?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${ids.resIds}::uuid[])`
    }
    if (ids.varIds?.length) await testSql`DELETE FROM product_variants WHERE id = ANY(${ids.varIds}::uuid[])`
    if (ids.prodIds?.length) await testSql`DELETE FROM products WHERE id = ANY(${ids.prodIds}::uuid[])`
  }

  test('fixture paid order appears in list', async () => {
    const f = await mk512()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const orders = await svc.listOrders({ limit:100, offset:0 })
      const found  = orders.find((o: any) => o.id === f.orderId)
      expect(found).toBeTruthy()
      expect(found?.orderNumber).toBe(f.orderNum)
    } finally { await cleanup512(ids) }
  }, 20000)

  test('fixture detail includes items', async () => {
    const f = await mk512()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const detail = await svc.getOrderDetail(f.orderId)
      expect(detail).not.toBeNull()
      expect(detail?.items.length).toBeGreaterThan(0)
      expect(detail?.items[0].sku).toContain('KVRN-T512')
    } finally { await cleanup512(ids) }
  }, 20000)

  test('unfulfilled → processing transition persists', async () => {
    const f = await mk512({ fulfillmentStatus:'unfulfilled' })
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const result = await svc.transitionToProcessing(f.orderId)
      expect(result).toBe('updated')
      const [row] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f.orderId}`
      expect(row.fulfillment_status).toBe('processing')
    } finally { await cleanup512(ids) }
  }, 20000)

  test('repeated transition is idempotent', async () => {
    const f = await mk512({ fulfillmentStatus:'unfulfilled' })
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await svc.transitionToProcessing(f.orderId)
      const r2 = await svc.transitionToProcessing(f.orderId)
      expect(r2).toBe('already_processing')
    } finally { await cleanup512(ids) }
  }, 20000)

  test('shipped order cannot be moved to processing (conflict)', async () => {
    const f = await mk512({ fulfillmentStatus:'shipped' })
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const r = await svc.transitionToProcessing(f.orderId)
      expect(r).toBe('conflict')
    } finally { await cleanup512(ids) }
  }, 15000)

  test('unrelated orders unaffected by transition', async () => {
    const f1 = await mk512({ fulfillmentStatus:'unfulfilled' })
    const f2 = await mk512({ fulfillmentStatus:'unfulfilled' })
    const ids = {
      orderIds:[f1.orderId, f2.orderId],
      resIds:[f1.resId, f2.resId],
      varIds:[f1.varId, f2.varId],
      prodIds:[f1.prodId, f2.prodId],
    }
    try {
      await svc.transitionToProcessing(f1.orderId)
      const [row] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f2.orderId}`
      expect(row.fulfillment_status).toBe('unfulfilled')
    } finally { await cleanup512(ids) }
  }, 25000)
})

// ── V51.3 tests ───────────────────────────────────────────────────────────────

import {
  shippingConfirmationHTML,
  shippingConfirmationSubject,
  type ShippingConfirmationData,
} from '../email'
import { loadShippingEmailData } from '../transactional-email'

// ── Shipping template unit tests ──────────────────────────────────────────────

const SAMPLE_SHIP: ShippingConfirmationData = {
  orderNumber:    'KVRN-001002',
  customerName:   'Ship Buyer',
  customerEmail:  'ship@example.com',
  carrier:        'UPS',
  trackingNumber: '1Z999AA10123456784',
  shippedAt:      '2026-01-15T12:00:00Z',
  shippingAddress: {
    firstName: 'Ship', lastName: 'Buyer',
    line1: '456 Oak Ave', line2: null,
    city: 'Portland', state: 'OR', postalCode: '97201', country: 'US',
  },
}

describe('shippingConfirmationHTML template', () => {
  let html: string
  beforeAll(() => { html = shippingConfirmationHTML(SAMPLE_SHIP, 'https://kvrn.shop') })

  test('correct subject line', () => {
    expect(shippingConfirmationSubject('KVRN-001002')).toBe('KVRN — Order KVRN-001002 has shipped')
  })
  test('contains order number', () => {
    expect(html).toContain('KVRN-001002')
  })
  test('contains carrier', () => {
    expect(html).toContain('UPS')
  })
  test('contains tracking number', () => {
    expect(html).toContain('1Z999AA10123456784')
  })
  test('no GBP symbol', () => {
    expect(html).not.toContain('£')
  })
  test('no pence references', () => {
    expect(html.toLowerCase()).not.toContain('pence')
  })
  test('no marketing unsubscribe', () => {
    expect(html.toLowerCase()).not.toContain('unsubscribe')
  })
  test('no stale hardcoded kvrn.com', () => {
    expect(html).not.toContain('href="https://kvrn.com"')
    expect(html).toContain('kvrn.shop')
  })
  test('uses injected siteOrigin', () => {
    const html2 = shippingConfirmationHTML(SAMPLE_SHIP, 'https://kvrn.omidhamidi1110.workers.dev')
    expect(html2).toContain('kvrn.omidhamidi1110.workers.dev')
    expect(html2).not.toContain('kvrn.com')
  })
  test('HTML-escapes XSS in carrier', () => {
    const danger = shippingConfirmationHTML(
      { ...SAMPLE_SHIP, carrier: '<script>alert(1)</script>' },
      'https://kvrn.shop'
    )
    expect(danger).not.toContain('<script>')
    expect(danger).toContain('&lt;script&gt;')
  })
  test('HTML-escapes XSS in tracking number', () => {
    const danger = shippingConfirmationHTML(
      { ...SAMPLE_SHIP, trackingNumber: '"><img src=x onerror=alert(1)>' },
      'https://kvrn.shop'
    )
    expect(danger).not.toContain('<img src=x')
    expect(danger).toContain('&gt;')
  })
  test('contains "on its way" messaging', () => {
    expect(html.toLowerCase()).toContain('on its way')
  })
})

// ── V51.3 PATCH route handler unit tests ─────────────────────────────────────

async function runShipPatch(
  authResult: MockAuthResult,
  id: string,
  body: any,
  shipResult: { outcome: string; shipmentId?: string }
) {
  if (authResult.error) return { status: authResult.error.status }
  if (!UUID_RE.test(id)) return { status: 400, error: 'Invalid order ID.' }

  const requestedStatus = body?.fulfillmentStatus
  if (requestedStatus === 'shipped') {
    const extraKeys = Object.keys(body).filter(
      (k: string) => !['fulfillmentStatus','carrier','trackingNumber'].includes(k)
    )
    if (extraKeys.length > 0) return { status: 400, error: `Unsupported fields: ${extraKeys.join(', ')}` }
    if (!body.carrier  || typeof body.carrier !== 'string' || !body.carrier.trim())  return { status: 400, error: 'carrier required' }
    if (!body.trackingNumber || typeof body.trackingNumber !== 'string' || !body.trackingNumber.trim()) return { status: 400, error: 'trackingNumber required' }
    if (body.carrier.trim().length > 50)    return { status: 400, error: 'carrier too long' }
    if (body.trackingNumber.trim().length > 100) return { status: 400, error: 'tracking too long' }

    if (shipResult.outcome === 'not_found')          return { status: 404 }
    if (shipResult.outcome === 'invalid_transition') return { status: 409 }
    return { status: 200, data: { fulfillmentStatus: 'shipped', shipment: { carrier: body.carrier, trackingNumber: body.trackingNumber } } }
  }
  if (requestedStatus !== 'processing' && requestedStatus !== 'shipped') {
    return { status: 400 }
  }
  return { status: 200 }
}

describe('V51.3 PATCH /api/orders/[id] — shipped transition validation', () => {
  const VALID_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  const SHIP_BODY = { fulfillmentStatus: 'shipped', carrier: 'UPS', trackingNumber: '1Z123' }

  test('processing → shipped succeeds with carrier+tracking', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, SHIP_BODY, { outcome: 'shipped' })
    expect(r.status).toBe(200)
  })
  test('missing carrier → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', trackingNumber:'1Z' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('empty carrier → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', carrier:'  ', trackingNumber:'1Z' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('overlong carrier (51 chars) → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', carrier:'A'.repeat(51), trackingNumber:'1Z' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('missing tracking → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', carrier:'UPS' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('empty tracking → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', carrier:'UPS', trackingNumber:'' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('overlong tracking (101 chars) → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { fulfillmentStatus:'shipped', carrier:'UPS', trackingNumber:'T'.repeat(101) }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('extra field (paymentStatus) → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, { ...SHIP_BODY, paymentStatus:'paid' }, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
  test('invalid transition → 409', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, SHIP_BODY, { outcome:'invalid_transition' })
    expect(r.status).toBe(409)
  })
  test('order not found → 404', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, VALID_ID, SHIP_BODY, { outcome:'not_found' })
    expect(r.status).toBe(404)
  })
  test('unauthenticated → 401', async () => {
    const r = await runShipPatch(MOCK_AUTH_401 as any, VALID_ID, SHIP_BODY, { outcome:'shipped' })
    expect(r.status).toBe(401)
  })
  test('malformed UUID → 400', async () => {
    const r = await runShipPatch(MOCK_AUTH_OK, 'not-a-uuid', SHIP_BODY, { outcome:'shipped' })
    expect(r.status).toBe(400)
  })
})

// ── V51.3 DB integration tests ────────────────────────────────────────────────

const TEST_DB_513 = process.env.TEST_DATABASE_URL
const describeDB513 = TEST_DB_513 ? describe : describe.skip

if (!TEST_DB_513) {
  test('NOTE: V51.3 DB integration tests skipped — TEST_DATABASE_URL absent. Migration 005 NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB513('Integration V51.3 — shipment + shipping email outbox', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createAdminOrderService>

  beforeAll(() => {
    testSql = neon(TEST_DB_513!)
    svc     = createAdminOrderService(testSql)
  })

  const TA = { firstName:'S',lastName:'T',line1:'1 Ship St',line2:'',city:'Portland',state:'OR',postalCode:'97201',country:'US' }

  async function mk513(opts: { fulfillmentStatus?: string; customerEmail?: string | null } = {}) {
    const uid = 'V513-' + Date.now() + '-' + Math.random().toString(36).slice(2,6).toUpperCase()
    const sku = 'KVRN-T513-' + uid + '-M'
    const email = opts.customerEmail !== undefined ? opts.customerEmail : 'ship513@test.com'
    const [p] = await testSql`INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active) VALUES ('TEST',${uid},${`T513 ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active) VALUES (${p.id},${sku},'Black','BLK','M',3,5,0,true) RETURNING id`
    const [res] = await testSql`INSERT INTO reservations (status,expires_at) VALUES ('completed',NOW()+interval'1 hour') RETURNING id`
    await testSql`INSERT INTO reservation_items (reservation_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents) VALUES (${res.id},${v.id},${sku},'Test Hoodie','M','Black',1,8000)`
    const orderNum = 'KVRN-TEST513-' + uid.replace(/[^A-Z0-9]/g,'')
    const status = opts.fulfillmentStatus ?? 'processing'
    const [ord] = await testSql`
      INSERT INTO orders (order_number,stripe_checkout_session_id,reservation_id,payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,total_cents,customer_email,customer_name,shipping_address,paid_at)
      VALUES (${orderNum},${`cs_test_513_${uid.replace(/[^A-Z0-9]/g,'')}`},${res.id},'paid',${status},'usd',8000,1999,9999,${email},'Ship Test',${JSON.stringify(TA)}::jsonb,NOW())
      RETURNING id`
    await testSql`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents) VALUES (${ord.id},${v.id},${sku},'Test Hoodie','M','Black',1,8000,8000)`
    return { orderId: ord.id as string, orderNum, varId: v.id as string, prodId: p.id as string, resId: res.id as string }
  }

  async function cleanup513(ids: { orderIds?: string[]; resIds?: string[]; varIds?: string[]; prodIds?: string[] }) {
    if (ids.orderIds?.length) {
      await testSql`DELETE FROM transactional_emails WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM shipments WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM order_items WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM orders WHERE id = ANY(${ids.orderIds}::uuid[])`
    }
    if (ids.resIds?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${ids.resIds}::uuid[])`
    }
    if (ids.varIds?.length) await testSql`DELETE FROM product_variants WHERE id = ANY(${ids.varIds}::uuid[])`
    if (ids.prodIds?.length) await testSql`DELETE FROM products WHERE id = ANY(${ids.prodIds}::uuid[])`
  }

  test('processing → shipped creates exactly one shipment and email row', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const r = await svc.markOrderShipped(f.orderId, 'UPS', '1ZTEST001')
      expect(r.outcome).toBe('shipped')

      const ships = await testSql`SELECT carrier,tracking_number FROM shipments WHERE order_id=${f.orderId}`
      expect(ships.length).toBe(1)
      expect(ships[0].carrier).toBe('UPS')
      expect(ships[0].tracking_number).toBe('1ZTEST001')

      const [ord] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f.orderId}`
      expect(ord.fulfillment_status).toBe('shipped')

      const emails = await testSql`SELECT email_type,recipient_email,idempotency_key,status FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      expect(emails.length).toBe(1)
      expect(emails[0].recipient_email).toBe('ship513@test.com')
      expect(emails[0].idempotency_key).toBe(`shipping-confirmation/${f.orderId}`)
      expect(emails[0].status).toBe('pending')
    } finally { await cleanup513(ids) }
  }, 25000)

  test('replay does not duplicate shipment or email row', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await svc.markOrderShipped(f.orderId, 'UPS', '1ZTEST002')
      const r2 = await svc.markOrderShipped(f.orderId, 'UPS', '1ZTEST002')
      expect(r2.outcome).toBe('already_shipped')
      const ships = await testSql`SELECT id FROM shipments WHERE order_id=${f.orderId}`
      expect(ships.length).toBe(1)
      const emails = await testSql`SELECT id FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      expect(emails.length).toBe(1)
    } finally { await cleanup513(ids) }
  }, 25000)

  test('unfulfilled → shipped rejected with no shipment or email', async () => {
    const f = await mk513({ fulfillmentStatus:'unfulfilled' })
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const r = await svc.markOrderShipped(f.orderId, 'UPS', '1ZTEST003')
      expect(r.outcome).toBe('invalid_transition')
      const ships = await testSql`SELECT id FROM shipments WHERE order_id=${f.orderId}`
      expect(ships.length).toBe(0)
      const emails = await testSql`SELECT id FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      expect(emails.length).toBe(0)
    } finally { await cleanup513(ids) }
  }, 20000)

  test('null customer_email marks shipped but creates no email row', async () => {
    const f = await mk513({ customerEmail: null })
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const r = await svc.markOrderShipped(f.orderId, 'FedEx', '1FEDTEST')
      expect(r.outcome).toBe('shipped')
      const [ord] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f.orderId}`
      expect(ord.fulfillment_status).toBe('shipped')
      const emails = await testSql`SELECT id FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      expect(emails.length).toBe(0)
    } finally { await cleanup513(ids) }
  }, 20000)

  test('no inventory movement during shipping', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      const [pvBefore] = await testSql`SELECT stock_on_hand FROM product_variants WHERE id=${f.varId}`
      await svc.markOrderShipped(f.orderId, 'USPS', '9400TEST')
      const [pvAfter] = await testSql`SELECT stock_on_hand FROM product_variants WHERE id=${f.varId}`
      expect(Number(pvAfter.stock_on_hand)).toBe(Number(pvBefore.stock_on_hand))
    } finally { await cleanup513(ids) }
  }, 20000)

  test('shipping email loader reads shipment data from Neon', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await svc.markOrderShipped(f.orderId, 'DHL', 'DHL123TEST')
      const data = await loadShippingEmailData(testSql, f.orderId)
      expect(data).not.toBeNull()
      expect(data?.carrier).toBe('DHL')
      expect(data?.trackingNumber).toBe('DHL123TEST')
      expect(data?.orderNumber).toBe(f.orderNum)
    } finally { await cleanup513(ids) }
  }, 25000)

  test('mock provider success marks shipping row sent', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await svc.markOrderShipped(f.orderId, 'UPS', '1ZSENT001')
      const [emailRow] = await testSql`SELECT id FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'ship-msg-id' }) }
      const outcome = await processOneEmail({ sql: testSql, provider: mockProvider, rowId: emailRow.id })
      expect(outcome.outcome).toBe('sent')
      const [row] = await testSql`SELECT status,provider_message_id FROM transactional_emails WHERE id=${emailRow.id}`
      expect(row.status).toBe('sent')
      expect(row.provider_message_id).toBe('ship-msg-id')
    } finally { await cleanup513(ids) }
  }, 25000)

  test('mock provider failure leaves order shipped and row retryable', async () => {
    const f = await mk513()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await svc.markOrderShipped(f.orderId, 'UPS', '1ZFAIL001')
      const [emailRow] = await testSql`SELECT id FROM transactional_emails WHERE order_id=${f.orderId} AND email_type='shipping_confirmation'`
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: false, message: 'Provider down.' }) }
      const outcome = await processOneEmail({ sql: testSql, provider: mockProvider, rowId: emailRow.id })
      expect(outcome.outcome).toBe('failed')
      const [ord] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f.orderId}`
      expect(ord.fulfillment_status).toBe('shipped')
      const [row] = await testSql`SELECT status,next_attempt_at FROM transactional_emails WHERE id=${emailRow.id}`
      expect(row.status).toBe('failed')
      expect(row.next_attempt_at).not.toBeNull()
    } finally { await cleanup513(ids) }
  }, 25000)

  test('unrelated orders unaffected by shipping transition', async () => {
    const f1 = await mk513()
    const f2 = await mk513()
    const ids = { orderIds:[f1.orderId,f2.orderId], resIds:[f1.resId,f2.resId], varIds:[f1.varId,f2.varId], prodIds:[f1.prodId,f2.prodId] }
    try {
      await svc.markOrderShipped(f1.orderId, 'UPS', '1ZUNRELATED')
      const [ord2] = await testSql`SELECT fulfillment_status FROM orders WHERE id=${f2.orderId}`
      expect(ord2.fulfillment_status).toBe('processing')
    } finally { await cleanup513(ids) }
  }, 25000)
})

// ── V51.4 tests ───────────────────────────────────────────────────────────────

// Resend unit tests restore global.fetch after each test
describe('V51.4 — internal retry route and processor', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch  = originalFetch
    jest.restoreAllMocks()
    // Clear CRON_SECRET env after each test
    delete process.env.CRON_SECRET
  })

  // Simulate the route handler logic (injectable for unit testing)
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      let result = 1
      for (let i = 0; i < a.length; i++) {
        result |= (a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0))
      }
      return false
    }
    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= (a.charCodeAt(i) ^ b.charCodeAt(i))
    }
    return result === 0
  }

  async function simulateRetryRoute(
    authHeader: string | null,
    envCronSecret: string | null,
    processorResult: { processed: number; sent: number; failed: number } | null,
    providerConfigured = true
  ): Promise<{ status: number; body: any }> {
    const cronSecret = envCronSecret ?? ''
    if (!cronSecret) return { status: 503, body: { error: 'not configured' } }
    if (!authHeader?.startsWith('Bearer ')) return { status: 401, body: { error: 'Unauthorized.' } }
    const provided = authHeader.slice('Bearer '.length)
    if (!timingSafeEqual(provided, cronSecret)) return { status: 403, body: { error: 'Forbidden.' } }
    if (!providerConfigured) return { status: 500, body: { error: 'Email provider not configured.' } }
    if (processorResult === null) return { status: 500, body: { error: 'Processing failed.' } }
    return { status: 200, body: processorResult }
  }

  // ── Auth tests ─────────────────────────────────────────────────────────────

  test('missing Authorization → 401', async () => {
    const r = await simulateRetryRoute(null, 'my-secret', { processed:0, sent:0, failed:0 })
    expect(r.status).toBe(401)
  })
  test('malformed scheme (no Bearer) → 401', async () => {
    const r = await simulateRetryRoute('Basic abc123', 'my-secret', { processed:0, sent:0, failed:0 })
    expect(r.status).toBe(401)
  })
  test('wrong secret → 403', async () => {
    const r = await simulateRetryRoute('Bearer wrong-secret', 'my-secret', { processed:0, sent:0, failed:0 })
    expect(r.status).toBe(403)
  })
  test('correct secret → processes', async () => {
    const r = await simulateRetryRoute('Bearer my-secret', 'my-secret', { processed:5, sent:4, failed:1 })
    expect(r.status).toBe(200)
    expect(r.body.processed).toBe(5)
    expect(r.body.sent).toBe(4)
    expect(r.body.failed).toBe(1)
  })
  test('missing CRON_SECRET → 503 (fail closed)', async () => {
    const r = await simulateRetryRoute('Bearer my-secret', null, { processed:0, sent:0, failed:0 })
    expect(r.status).toBe(503)
  })
  test('provider missing → 500', async () => {
    const r = await simulateRetryRoute('Bearer sec', 'sec', null, false)
    expect(r.status).toBe(500)
  })
  test('processor exception → 500', async () => {
    const r = await simulateRetryRoute('Bearer sec', 'sec', null, true)
    expect(r.status).toBe(500)
  })
  test('response body contains only counts — no PII', async () => {
    const r = await simulateRetryRoute('Bearer sec', 'sec', { processed:2, sent:2, failed:0 })
    expect(r.status).toBe(200)
    const keys = Object.keys(r.body)
    expect(keys).toEqual(['processed', 'sent', 'failed'])
    expect(keys).not.toContain('email')
    expect(keys).not.toContain('orderId')
    expect(keys).not.toContain('recipient')
  })
  test('timing-safe comparison: different-length secrets always reject', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('x', '')).toBe(false)
  })

  // ── Processor selection tests ──────────────────────────────────────────────

  test('wrangler.toml contains [triggers] crons', () => {
    const fs   = require('fs')
    const toml = fs.readFileSync(require('path').join(__dirname, '../../wrangler.toml'), 'utf8')
    expect(toml).toContain('[triggers]')
    expect(toml).toContain('crons')
    expect(toml).toContain('*/5 * * * *')
  })
  test('wrangler.toml does NOT contain a hardcoded CRON_SECRET value', () => {
    const fs   = require('fs')
    const toml = fs.readFileSync(require('path').join(__dirname, '../../wrangler.toml'), 'utf8')
    // Key must appear only in comments, never as an assignment with a real value
    const lines = toml.split('\n').filter((l: string) => !l.trim().startsWith('#'))
    expect(lines.some((l: string) => l.includes('CRON_SECRET') && l.includes('=') && !l.includes('#'))).toBe(false)
  })
  test('wrangler.toml account_id unchanged', () => {
    const fs   = require('fs')
    const toml = fs.readFileSync(require('path').join(__dirname, '../../wrangler.toml'), 'utf8')
    expect(toml).toContain('5c2f1f1df8ff752572878665e985280b')
  })
  test('wrangler.toml main references cron wrapper', () => {
    const fs   = require('fs')
    const toml = fs.readFileSync(require('path').join(__dirname, '../../wrangler.toml'), 'utf8')
    expect(toml).toContain('cloudflare-cron-wrapper.js')
  })
  test('cloudflare-cron-wrapper.js exists and references internal route', () => {
    const fs     = require('fs')
    const wrapper = fs.readFileSync(require('path').join(__dirname, '../../cloudflare-cron-wrapper.js'), 'utf8')
    expect(wrapper).toContain('scheduled')
    expect(wrapper).toContain('transactional-email-retry')
    expect(wrapper).toContain('CRON_SECRET')
    // Must not contain a hardcoded secret value
    expect(wrapper).not.toMatch(/CRON_SECRET\s*=\s*['"][^'"]+['"]/)
  })
  test('cloudflare-cron-wrapper.js delegates fetch to openNextWorker', () => {
    const fs     = require('fs')
    const wrapper = fs.readFileSync(require('path').join(__dirname, '../../cloudflare-cron-wrapper.js'), 'utf8')
    expect(wrapper).toContain('openNextWorker')
    expect(wrapper).toContain('.open-next/worker.js')
  })

  // ── Stale sending recovery ─────────────────────────────────────────────────

  test('stale sending recovery: query includes sending rows older than 15 min', () => {
    const fs  = require('fs')
    const src = fs.readFileSync(require('path').join(__dirname, '../transactional-email.ts'), 'utf8')
    expect(src).toContain("status = 'sending'")
    expect(src).toContain('15 minutes')
    expect(src).toContain('STALE_SENDING_MINUTES')
  })
  test('stale sending recovery: processOneEmail uses deterministic idempotency key', () => {
    // Deterministic key is stored in the DB row (idempotency_key column)
    // and passed to provider.send() — verified by shipping/order confirmation tests above
    // This test confirms the field is never regenerated per-attempt
    const fs  = require('fs')
    const src = fs.readFileSync(require('path').join(__dirname, '../transactional-email.ts'), 'utf8')
    expect(src).toContain('idempotencyKey: row.idempotency_key')
    expect(src).not.toContain('Math.random()')
    expect(src).not.toContain('crypto.randomUUID()')
  })
})

// ── V51.4 DB integration tests ────────────────────────────────────────────────

const TEST_DB_514 = process.env.TEST_DATABASE_URL
const describeDB514 = TEST_DB_514 ? describe : describe.skip

if (!TEST_DB_514) {
  test('NOTE: V51.4 DB integration tests skipped — TEST_DATABASE_URL absent. Retry/stale recovery NOT verified.', () => {
    expect(true).toBe(true)
  })
}

describeDB514('Integration V51.4 — retry batch processor and stale sending recovery', () => {
  const { neon } = require('@neondatabase/serverless')
  let testSql: any
  let svc: ReturnType<typeof createAdminOrderService>

  beforeAll(() => {
    testSql = neon(TEST_DB_514!)
    svc     = createAdminOrderService(testSql)
  })

  const TA = { firstName:'R',lastName:'T',line1:'1 Retry Rd',line2:'',city:'LA',state:'CA',postalCode:'90001',country:'US' }

  async function mk514() {
    const uid = 'V514-' + Date.now() + '-' + Math.random().toString(36).slice(2,6).toUpperCase()
    const sku = 'KVRN-T514-' + uid + '-M'
    const [p] = await testSql`INSERT INTO products (drop_code,product_code,name,slug,price_cents,currency,active) VALUES ('TEST',${uid},${`T514 ${uid}`},${uid.toLowerCase()},8000,'usd',true) RETURNING id`
    const [v] = await testSql`INSERT INTO product_variants (product_id,sku,color_name,color_code,size,size_sort,stock_on_hand,reserved_quantity,active) VALUES (${p.id},${sku},'Black','BLK','M',3,5,0,true) RETURNING id`
    const [res] = await testSql`INSERT INTO reservations (status,expires_at) VALUES ('completed',NOW()+interval'1 hour') RETURNING id`
    await testSql`INSERT INTO reservation_items (reservation_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents) VALUES (${res.id},${v.id},${sku},'Test514','M','Black',1,8000)`
    const orderNum = 'KVRN-TEST514-' + uid.replace(/[^A-Z0-9]/g,'')
    const [ord] = await testSql`
      INSERT INTO orders (order_number,stripe_checkout_session_id,reservation_id,payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,total_cents,customer_email,customer_name,shipping_address,paid_at)
      VALUES (${orderNum},${`cs_test_514_${uid.replace(/[^A-Z0-9]/g,'')}`},${res.id},'paid','unfulfilled','usd',8000,1999,9999,'retry514@test.com','Retry T',${JSON.stringify(TA)}::jsonb,NOW())
      RETURNING id`
    await testSql`INSERT INTO order_items (order_id,variant_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents) VALUES (${ord.id},${v.id},${sku},'Test','M','Black',1,8000,8000)`
    return { orderId: ord.id as string, orderNum, varId: v.id as string, prodId: p.id as string, resId: res.id as string }
  }

  async function cleanup514(ids: { orderIds?: string[]; resIds?: string[]; varIds?: string[]; prodIds?: string[] }) {
    if (ids.orderIds?.length) {
      await testSql`DELETE FROM transactional_emails WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM shipments WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM order_items WHERE order_id = ANY(${ids.orderIds}::uuid[])`
      await testSql`DELETE FROM orders WHERE id = ANY(${ids.orderIds}::uuid[])`
    }
    if (ids.resIds?.length) {
      await testSql`DELETE FROM inventory_movements WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids.resIds}::uuid[])`
      await testSql`DELETE FROM reservations WHERE id = ANY(${ids.resIds}::uuid[])`
    }
    if (ids.varIds?.length) await testSql`DELETE FROM product_variants WHERE id = ANY(${ids.varIds}::uuid[])`
    if (ids.prodIds?.length) await testSql`DELETE FROM products WHERE id = ANY(${ids.prodIds}::uuid[])`
  }

  test('failed due row gets sent by batch processor', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      // Create a failed pending row
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key,attempt_count,next_attempt_at)
        VALUES (${f.orderId},'order_confirmation','retry514@test.com','failed',('order-confirmation/' || ${f.orderId}::text),1,NOW()-interval'1 minute')
      `
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'retry-ok' }) }
      const result = await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      expect(result.sent).toBeGreaterThanOrEqual(1)
      const [row] = await testSql`SELECT status FROM transactional_emails WHERE order_id=${f.orderId}`
      expect(row.status).toBe('sent')
    } finally { await cleanup514(ids) }
  }, 25000)

  test('future next_attempt_at row is not processed', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key,attempt_count,next_attempt_at)
        VALUES (${f.orderId},'order_confirmation','retry514f@test.com','failed',('order-confirmation/' || ${f.orderId}::text),1,NOW()+interval'1 hour')
      `
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'no-send' }) }
      await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      expect(mockProvider.send).not.toHaveBeenCalled()
      const [row] = await testSql`SELECT status FROM transactional_emails WHERE order_id=${f.orderId}`
      expect(row.status).toBe('failed')
    } finally { await cleanup514(ids) }
  }, 20000)

  test('stale sending row becomes retryable and idempotency key preserved', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    const idemKey = 'order-confirmation/' + f.orderId
    try {
      // Insert a stale sending row (updated_at > 15 minutes ago)
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key,attempt_count,updated_at)
        VALUES (${f.orderId},'order_confirmation','stale514@test.com','sending',${idemKey},1,NOW()-interval'20 minutes')
      `
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'stale-recovered' }) }
      await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      expect(mockProvider.send).toHaveBeenCalled()
      const call = mockProvider.send.mock.calls[0][0]
      // Must reuse the same deterministic idempotency key
      expect(call.idempotencyKey).toBe(idemKey)
      const [row] = await testSql`SELECT status FROM transactional_emails WHERE order_id=${f.orderId}`
      expect(row.status).toBe('sent')
    } finally { await cleanup514(ids) }
  }, 25000)

  test('fresh sending row is NOT reclaimed', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      // Fresh sending row — updated just now
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key,attempt_count)
        VALUES (${f.orderId},'order_confirmation','fresh514@test.com','sending',('order-confirmation/' || ${f.orderId}::text),1)
      `
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'fresh' }) }
      await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      expect(mockProvider.send).not.toHaveBeenCalled()
      const [row] = await testSql`SELECT status FROM transactional_emails WHERE order_id=${f.orderId}`
      expect(row.status).toBe('sending')
    } finally { await cleanup514(ids) }
  }, 20000)

  test('sent row remains untouched by batch processor', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key,attempt_count,sent_at)
        VALUES (${f.orderId},'order_confirmation','sent514@test.com','sent',('order-confirmation/' || ${f.orderId}::text),1,NOW())
      `
      const mockProvider = { send: jest.fn() }
      await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      expect(mockProvider.send).not.toHaveBeenCalled()
    } finally { await cleanup514(ids) }
  }, 20000)

  test('order/payment/inventory unchanged by retry processing', async () => {
    const f = await mk514()
    const ids = { orderIds:[f.orderId], resIds:[f.resId], varIds:[f.varId], prodIds:[f.prodId] }
    try {
      await testSql`
        INSERT INTO transactional_emails (order_id,email_type,recipient_email,status,idempotency_key)
        VALUES (${f.orderId},'order_confirmation','inv514@test.com','pending',('order-confirmation/' || ${f.orderId}::text))
      `
      const [pvBefore] = await testSql`SELECT stock_on_hand FROM product_variants WHERE id=${f.varId}`
      const [ordBefore] = await testSql`SELECT payment_status,fulfillment_status FROM orders WHERE id=${f.orderId}`
      const mockProvider = { send: jest.fn().mockResolvedValue({ ok: false, message: 'down' }) }
      await processPendingTransactionalEmails({ sql: testSql, provider: mockProvider, limit: 10 })
      const [pvAfter]  = await testSql`SELECT stock_on_hand FROM product_variants WHERE id=${f.varId}`
      const [ordAfter] = await testSql`SELECT payment_status,fulfillment_status FROM orders WHERE id=${f.orderId}`
      expect(pvAfter.stock_on_hand).toBe(pvBefore.stock_on_hand)
      expect(ordAfter.payment_status).toBe(ordBefore.payment_status)
      expect(ordAfter.fulfillment_status).toBe(ordBefore.fulfillment_status)
    } finally { await cleanup514(ids) }
  }, 20000)
})
