// lib/__tests__/owner-notifications-db.test.ts — the owner-notification SQL against REAL PostgreSQL
//
// Runs only against a LOCAL server named by TEST_DATABASE_URL (see helpers/fi-pg.ts). The mocked-sql unit tests
// cannot catch a wrong column name: every notify* function swallows its own errors by design, so a broken
// query would simply never notify. This file runs every query against the real schema (migrations 001-025) and
// proves the durable dedupe (claim / cooldown) behaves with a real database. No Pushover call is made.

import { HAVE_DB, TEST_DB_URL, createFiDb, mkOrder, oid, seedCatalog, V, type FiDb } from './helpers/fi-pg'

const pushSend = jest.fn<Promise<{ outcome: 'sent' }>, [any]>(async () => ({ outcome: 'sent' }))
jest.mock('../db', () => ({ get sql() { return (global as any).__ON_SQL } }))
jest.mock('../pushover', () => ({
  isPushoverConfigured: () => true,
  sendPushoverNotification: (n: any) => pushSend(n),
}))

import {
  notifyDispute, notifyFinancialIntegrityRun, notifyRefund, notifySaleAndInventory, notifySecurityAlert,
  readRefundStatusForNotify, recordProviderFailure,
} from '../owner-notifications'

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: owner-notification DB tests skipped — TEST_DATABASE_URL is not a local server.'
                   : 'NOTE: owner-notification DB tests skipped — TEST_DATABASE_URL absent.', () => { expect(true).toBe(true) })
}

let F: FiDb
let setupFail = ''
const titles = () => pushSend.mock.calls.map(c => c[0].title)
let errSpy: jest.SpyInstance

beforeAll(async () => {
  if (!HAVE_DB) return
  try { F = await createFiDb('kvrn_ownn'); (global as any).__ON_SQL = F.sql; await seedCatalog(F.q) }
  catch (e: any) { setupFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
beforeEach(() => {
  pushSend.mockClear()
  process.env.SITE_URL = 'https://kvrn.shop'
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errSpy.mockRestore() })
const need = () => { if (setupFail) throw new Error('DB setup failed: ' + setupFail) }
const skipped = () => errSpy.mock.calls.filter(c => String(c[0]).startsWith('[owner-notify]') && /skipped/.test(String(c[0])))
const audit = (action: string) => F.q(`SELECT * FROM admin_audit_logs WHERE action=$1 ORDER BY created_at`, [action])

describeDB('owner notifications on the real schema', () => {
  test('sale + low stock: every query is valid; the stock alert fires once even if re-evaluated', async () => {
    need()
    await mkOrder(F.q, 1, { consume: false })
    await F.q(`UPDATE product_variants SET stock_on_hand = 2 WHERE id = $1`, [V])        // 3 -> 2 after this order's unit
    await notifySaleAndInventory(oid(1))
    expect(titles()).toEqual(['KVRN SALE 💰', 'KVRN LOW STOCK 📦'])
    expect(pushSend.mock.calls[0][0].message).toContain('FI-001')
    expect(skipped()).toEqual([])

    pushSend.mockClear()
    await notifySaleAndInventory(oid(1))                                                  // concurrent / re-evaluated order
    expect(titles()).toEqual(['KVRN SALE 💰'])                                           // no second LOW STOCK
    expect(await audit('PUSHOVER_STOCK_ALERT')).toHaveLength(1)
  })

  test('sold out: fires on the transition to zero, once', async () => {
    need()
    await mkOrder(F.q, 2, { consume: false })
    await F.q(`UPDATE product_variants SET stock_on_hand = 0 WHERE id = $1`, [V])
    await notifySaleAndInventory(oid(2))
    await notifySaleAndInventory(oid(2))
    expect(titles().filter(t => t.includes('SOLD OUT'))).toHaveLength(1)
    expect(skipped()).toEqual([])
  })

  test('no alert when stock is healthy', async () => {
    need()
    await mkOrder(F.q, 3, { consume: false })
    await F.q(`UPDATE product_variants SET stock_on_hand = 500 WHERE id = $1`, [V])
    await notifySaleAndInventory(oid(3))
    expect(titles()).toEqual(['KVRN SALE 💰'])
  })

  test('refund: valid query; one push per Stripe refund id however many events arrive', async () => {
    need()
    await mkOrder(F.q, 4, { consume: false })
    await notifyRefund({ orderId: oid(4), stripeRefundId: 're_dup', amountCents: 1500, fullyRefunded: true })
    await notifyRefund({ orderId: oid(4), stripeRefundId: 're_dup', amountCents: 1500, fullyRefunded: true })
    await notifyRefund({ orderId: oid(4), stripeRefundId: 're_other', amountCents: 200, fullyRefunded: false })
    expect(titles()).toEqual(['KVRN REFUND ↩️', 'KVRN REFUND ↩️'])
    expect(pushSend.mock.calls[0][0].message).toContain('FI-004')
    expect(skipped()).toEqual([])
  })

  test('readRefundStatusForNotify, dispute and financial queries run against the real schema', async () => {
    need()
    await expect(readRefundStatusForNotify('re_none')).resolves.toBeNull()
    await notifyDispute({ stripeDisputeId: 'dp_none', amountCents: 100, status: 'needs_response' })
    await notifyFinancialIntegrityRun('f3300000-0000-0000-0000-000000000001')
    expect(skipped()).toEqual([])
    expect(titles()).toEqual(['KVRN DISPUTE 🚨'])        // unknown order label, but a real query ran without error
  })

  test('provider down: 3 failures -> ONE push; later failures write nothing (no audit growth)', async () => {
    need()
    for (let i = 0; i < 3; i++) await recordProviderFailure('Stripe', 'checkout_session_create')
    expect(titles()).toEqual(['KVRN PROVIDER DOWN ⚡'])
    expect(await audit('PUSHOVER_PROVIDER_ALERT')).toHaveLength(1)
    const before = (await audit('PUSHOVER_PROVIDER_FAILURE')).length
    for (let i = 0; i < 50; i++) await recordProviderFailure('Stripe', 'checkout_session_create')
    expect(titles()).toHaveLength(1)
    expect((await audit('PUSHOVER_PROVIDER_FAILURE')).length).toBe(before)
    expect(skipped()).toEqual([])
  })

  test('provider down is per provider; a failing Pushover is retried at most once per attempt window', async () => {
    need()
    pushSend.mockClear()
    pushSend.mockResolvedValue({ outcome: 'failed', reason: 'http_400' } as any)
    for (let i = 0; i < 20; i++) await recordProviderFailure('Shippo', 'checkout_missing_token')
    expect(pushSend).toHaveBeenCalledTimes(1)                                            // not 18
    expect(await audit('PUSHOVER_PROVIDER_FAILURE')).toEqual(expect.any(Array))
    expect((await F.q(`SELECT count(*)::int n FROM admin_audit_logs WHERE action='PUSHOVER_PROVIDER_FAILURE' AND resource_id='Shippo'`))[0].n).toBe(3)
    pushSend.mockResolvedValue({ outcome: 'sent' })
  })

  test('security alert: 3 denied identities -> ONE push; the stream afterwards writes nothing', async () => {
    need()
    pushSend.mockClear()
    for (let i = 0; i < 3; i++) await notifySecurityAlert('x')
    expect(titles()).toEqual(['KVRN SECURITY ALERT 🔐'])
    const n = (await audit('PUSHOVER_SECURITY_INCIDENT')).length
    for (let i = 0; i < 30; i++) await notifySecurityAlert('x')
    expect(titles()).toHaveLength(1)
    expect((await audit('PUSHOVER_SECURITY_INCIDENT')).length).toBe(n)
  })

  test('the push modules wrote ONLY admin_audit_logs rows: no business table changed', async () => {
    need()
    for (const t of ['order_refunds', 'order_disputes', 'order_cancellations']) {
      expect((await F.q(`SELECT count(*)::int n FROM ${t}`))[0].n).toBe(0)
    }
    const actions = (await F.q(`SELECT DISTINCT action FROM admin_audit_logs ORDER BY 1`)).map(r => r.action)
    expect(actions.every((a: string) => a.startsWith('PUSHOVER_'))).toBe(true)
  })
})
