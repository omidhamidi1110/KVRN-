// lib/__tests__/audit-b-fraud-db.test.ts
//
// Audit stage 1, area b: adversarial DB-backed checks of migration 031 (fraud review / hold) and the tag
// functions. Real PostgreSQL (local TEST_DATABASE_URL only).

import { createFraudReviewService } from '../fraud-review'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: audit-b DB tests skipped — not a local server.' : 'NOTE: audit-b DB tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const oid = (n: number) => `f3300000-0000-0000-0000-${String(n).padStart(12, '0')}`
const pi  = (n: number) => `pi_aud${String(n).padStart(6, '0')}`
const ch  = (n: number) => `ch_aud${String(n).padStart(6, '0')}`
const prv = (n: number, k = 1) => `prv_aud${String(n).padStart(6, '0')}${k}`
const svc = () => createFraudReviewService(F.sql)
const onFlag = () => { process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS = 'on' }

beforeAll(async () => { if (HAVE_DB) F = await createFiDb('kvrn_audb') }, 180_000)
afterAll(async () => { delete process.env.KVRN_FLAG_RADAR_FULFILLMENT_HOLDS; await F?.close() })
beforeEach(() => { onFlag() })

async function mkOrder(n: number, fulfillment = 'unfulfilled') {
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
      payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,
      shipping_quoted_cents,shipping_before_discount_cents,customer_email,customer_name)
    VALUES ($1,$2,$3,$4,$5,'paid',$6,'usd',8000,598,0,0,8598,now(),598,598,'buyer@example.com','Buyer')`,
    [oid(n), `AUD-${n}`, `cs_aud${n}`, pi(n), ch(n), fulfillment])
  return oid(n)
}
const review = (n: number, over: Record<string, any> = {}) => ({
  id: prv(n), open: true, reason: 'rule', opened_reason: 'rule', closed_reason: null, payment_intent: pi(n), charge: ch(n), ...over,
})
const evt = (id: string, type: string, object: any, created: number) => ({ id, type, created, data: { object } })
const row = async (n: number) => (await q(`SELECT * FROM order_fraud_reviews WHERE order_id=$1`, [oid(n)]))[0]

describeDB('B1. review lifecycle ordering', () => {
  test('a review.opened delivered AFTER review.closed in the SAME second must not re-open the review or hold the order', async () => {
    await mkOrder(1)
    const t = Math.floor(Date.now() / 1000)
    await svc().ingestStripeEvent(evt('evt_aud_close_1', 'review.closed', review(1, { open: false, closed_reason: 'approved' }), t))
    const r = await svc().ingestStripeEvent(evt('evt_aud_open_1', 'review.opened', review(1), t))
    expect(r).toMatchObject({ outcome: 'applied' })
    const x = await row(1)
    expect(x.stripe_review_state).toBe('closed')
    expect(x.hold_state).toBe('none')
  })

  test('a refresh that read the review as OPEN just before a webhook closed it must not hold the order', async () => {
    await mkOrder(2)
    const t = Math.floor(Date.now() / 1000)
    await svc().ingestStripeEvent(evt('evt_aud_close_2', 'review.closed', review(2, { open: false, closed_reason: 'approved' }), t + 5))
    // refresh read at t (before the close) and is applied late
    const stripe: any = { paymentIntents: { retrieve: async () => ({ id: pi(2), review: review(2),
      latest_charge: { id: ch(2), status: 'succeeded', payment_intent: pi(2), outcome: { risk_level: 'normal', type: 'authorized' } } }) } }
    const s = createFraudReviewService(F.sql, { now: () => new Date((t) * 1000) })
    const res = await s.refreshFromStripe(oid(2), 'owner@kvrn.test', () => stripe)
    expect(res.ok).toBe(true)
    const x = await row(2)
    expect(x.stripe_review_state).toBe('closed')
    expect(x.hold_state).toBe('none')
  })
})

describeDB('B2. order tags: delete vs assign', () => {
  test('assigning a tag that a concurrent delete is removing is a clean TAG_NOT_FOUND / IN_USE, never a raw FK error', async () => {
    await mkOrder(30)
    const tag = (await q(`SELECT order_tag_create('Race','neutral','owner@kvrn.test') AS r`))[0].r
    const { Client } = require('pg')
    const { pgConfig } = require('./helpers/fi-pg')
    const { isLocal: _l, ...cfg } = pgConfig(`kvrn_audb_${process.pid}`)
    const a = new Client(cfg); await a.connect()
    try {
      await a.query('BEGIN')
      await a.query(`SELECT order_tag_delete($1::uuid,'owner@kvrn.test')`, [tag.id])   // holds the tag row, tag deleted (uncommitted)
      setTimeout(() => { a.query('COMMIT').catch(() => {}) }, 400)
      let msg = ''
      try { await q(`SELECT order_tag_assign($1::uuid,$2::uuid,'owner@kvrn.test')`, [oid(30), tag.id]) } catch (e: any) { msg = String(e?.message ?? e) }
      expect(msg).toMatch(/KVRN_TAG\|(TAG_NOT_FOUND|IN_USE)/)
    } finally { try { await a.query('ROLLBACK') } catch { /* committed */ } await a.end() }
  })
})
