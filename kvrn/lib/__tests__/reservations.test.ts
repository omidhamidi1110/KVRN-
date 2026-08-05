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
