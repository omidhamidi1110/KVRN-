/**
 * KVRN V49.4 tests
 * Unit tests: always run.
 * Integration: require TEST_DATABASE_URL — clearly skipped when absent.
 * DB behavior NOT verified when integration tests are skipped.
 */

import { aggregateAndValidate, createReservationService, parseDbErr } from '../reservations'
import { isValidTestCheckoutSessionId } from '../checkout-status'
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

describe('isValidTestCheckoutSessionId', () => {
  test('accepts cs_test_ ID', () => expect(isValidTestCheckoutSessionId('cs_test_' + 'a'.repeat(20))).toBe(true))
  test('rejects cs_live_', () => expect(isValidTestCheckoutSessionId('cs_live_' + 'a'.repeat(20))).toBe(false))
  test('rejects too short', () => expect(isValidTestCheckoutSessionId('cs_test_abc')).toBe(false))
  test('rejects null', () => expect(isValidTestCheckoutSessionId(null)).toBe(false))
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
        shippingCents:   1999,
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
        shippingAddress: testAddress, shippingMethod: 'standard', shippingCents: 1999,
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
        shippingCents:  1999,
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
        shippingAddress:ta, shippingMethod:'standard', shippingCents:1999,
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
        shippingAddress:ta, shippingMethod:'express', shippingCents:2999,
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
        shippingMethod:'standard', shippingCents:1999,
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
        shippingAddress:ta, shippingMethod:'standard', shippingCents:1999,
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
        shippingAddress:ta, shippingMethod:'express', shippingCents:2999,
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
        shippingCents:   1999,
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
