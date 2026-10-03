// lib/__tests__/financial-integrity-rev2.test.ts
//
// REVISION 2 regression suite (final surgical pass on REV1).
//
//   BLOCKER 1  order_refunds.fee_refunded_cents is write-once AT THE DATABASE, not only in the writer
//   BLOCKER 2  the recent-orders row shows the scan's per-order integrityState, never a green
//              "Reconciled" for an EXCEPTION order; the stale contribution formula is gone
//   BLOCKER 3  GET /api/admin/financials/orders/[id] exposes integrity + a canonical contribution
//
// Real-PostgreSQL blocks run only with a LOCAL TEST_DATABASE_URL (see helpers/fi-pg.ts).

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { createFinancialService } from '../financials'
import { mapOrderIntegrity } from '../financial-integrity'
import {
  canonicalOrderContribution, orderRowPresentation, RECONCILIATION_HREF,
} from '../financial-presentation'
import {
  HAVE_DB, TEST_DB_URL, createFiDb, seedCatalog, mkOrder, addRefund, oid, dayRange, type FiDb,
} from './helpers/fi-pg'

// The route handlers import `sql` from '@/lib/db' and `requireAdmin` from '@/lib/admin-auth'.
// Point them at the throwaway database and a fixed admin so the REAL handlers can be exercised.
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => ({ identity: { email: 'rev2@test.local' }, error: null }),
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__FI_REV2_SQL } }))

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: REV2 DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: REV2 real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_fi_rev2')
    await seedCatalog(F.q)
    ;(global as any).__FI_REV2_SQL = F.sql
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })

const rid = async (stripeId: string) => (await q(`SELECT id FROM order_refunds WHERE stripe_refund_id=$1`, [stripeId]))[0].id
const feeOf = async (id: string) => (await q(`SELECT fee_refunded_cents AS f FROM order_refunds WHERE id=$1`, [id]))[0].f

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 1 — refund fee immutability
// ─────────────────────────────────────────────────────────────────────────────
describeDB('BLOCKER 1 (SQL): a known refund fee return cannot be rewritten', () => {
  test('1. NULL -> known is allowed (the first write)', async () => {
    needDb()
    await mkOrder(F.q, 1, { fee: 100 }); await addRefund(F.q, 1, 're_1', 500, { fee: null })
    const id = await rid('re_1')
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=40 WHERE id=$1`, [id])).toBe('')
    expect(await feeOf(id)).toBe(40)
  })
  test('2. known -> the SAME value is allowed (harmless no-op)', async () => {
    needDb()
    const id = await rid('re_1')
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=40 WHERE id=$1`, [id])).toBe('')
    expect(await feeOf(id)).toBe(40)
  })
  test('3. known -> a DIFFERENT value is blocked', async () => {
    needDb()
    const id = await rid('re_1')
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=90 WHERE id=$1`, [id])).toContain('KVRN_REFUND|FEE_IMMUTABLE')
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=0 WHERE id=$1`, [id])).toContain('KVRN_REFUND|FEE_IMMUTABLE')
    expect(await feeOf(id)).toBe(40)
  })
  test('4. known -> NULL (back to "unknown") is blocked', async () => {
    needDb()
    const id = await rid('re_1')
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=NULL WHERE id=$1`, [id])).toContain('KVRN_REFUND|FEE_IMMUTABLE')
    expect(await feeOf(id)).toBe(40)
  })
  test('5. normal refund lifecycle / metadata updates with the fee unchanged still work', async () => {
    needDb()
    const id = await rid('re_1')
    expect(await F.err(`UPDATE order_refunds SET reason='customer request', updated_at=now() WHERE id=$1`, [id])).toBe('')
    expect(await F.err(`UPDATE order_refunds SET status='succeeded' WHERE id=$1`, [id])).toBe('')
    // an UPDATE that lists the column but leaves it unchanged is not a rewrite
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=fee_refunded_cents, reason='again' WHERE id=$1`, [id])).toBe('')
    expect((await q(`SELECT reason FROM order_refunds WHERE id=$1`, [id]))[0].reason).toBe('again')
    expect(await feeOf(id)).toBe(40)
  })
  test('5b. the Stripe webhook replay path (NULL fee) keeps the known value; a conflicting value is refused', async () => {
    needDb()
    const call = (fee: number | null) => F.err(
      `SELECT record_order_refund('re_1','pi_FI-001','ch_FI-001',500,'usd','succeeded',NULL,$1,now())`, [fee])
    expect(await call(null)).toBe('')
    expect(await feeOf(await rid('re_1'))).toBe(40)
    expect(await call(40)).toBe('')
    expect(await call(41)).toContain('KVRN_REFUND|FEE_IMMUTABLE')
  })
  test('6. record_refund_fee_returned() stays idempotent and write-once', async () => {
    needDb()
    await mkOrder(F.q, 2, { fee: 100 }); await addRefund(F.q, 2, 're_2', 500, { fee: null })
    const id = await rid('re_2')
    expect((await q(`SELECT record_refund_fee_returned($1,30,'ops@kvrn') AS r`, [id]))[0].r.outcome).toBe('recorded')
    expect((await q(`SELECT record_refund_fee_returned($1,30,'ops@kvrn') AS r`, [id]))[0].r.outcome).toBe('already_recorded')
    expect(await F.err(`SELECT record_refund_fee_returned($1,31,'ops@kvrn')`, [id])).toContain('FEE_ALREADY_RECORDED')
    expect(await feeOf(id)).toBe(30)
  })
  test('the guard is the only thing standing between a direct UPDATE and the economics', async () => {
    needDb()
    // fee economics of order 2 follow the recorded value and cannot be changed behind the writer's back
    const row = await createFinancialService(F.sql).getOrderEconomics(oid(2))
    expect(row!.economics.netStripeFeeCents).toBe(100 - 30)
    expect(await F.err(`UPDATE order_refunds SET fee_refunded_cents=NULL WHERE order_id=$1`, [oid(2)])).toContain('FEE_IMMUTABLE')
    expect((await createFinancialService(F.sql).getOrderEconomics(oid(2)))!.economics.netStripeFeeCents).toBe(70)
  })
})

describe('BLOCKER 1 (structure): 021 carries the guard and migration 015 is untouched', () => {
  const M021 = fs.readFileSync(path.join(__dirname, '../../db/migrations/021_financial_integrity.sql'), 'utf8')
  test('trigger is idempotent and scoped to fee_refunded_cents', () => {
    expect(M021).toMatch(/DROP TRIGGER IF EXISTS order_refund_fee_guard_trg ON order_refunds/)
    expect(M021).toMatch(/BEFORE UPDATE OF fee_refunded_cents ON order_refunds/)
    expect(M021).toMatch(/OLD\.fee_refunded_cents IS NOT NULL\s+AND NEW\.fee_refunded_cents IS DISTINCT FROM OLD\.fee_refunded_cents/)
  })
  test('no 022 and migration 015 is byte-identical to ab857ed', () => {
    const files = fs.readdirSync(path.join(__dirname, '../../db/migrations')).filter(f => /^\d+_/.test(f)).sort()
    expect(files[files.length - 1]).toBe('021_financial_integrity.sql')
    const md5 = require('crypto').createHash('md5')
      .update(fs.readFileSync(path.join(__dirname, '../../db/migrations/015_order_refunds.sql'))).digest('hex')
    expect(md5).toBe('84206072efa488bc87e0107667ff86d2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 2 — recent-orders row
// ─────────────────────────────────────────────────────────────────────────────
describe('BLOCKER 2 (pure): the order row follows the integrity state', () => {
  const row = (integrityState: any, extra: any = {}) => orderRowPresentation({
    integrityState, contributionProfitCents: 650, contributionMarginPct: 43.3, calculatorState: 'complete', ...extra,
  })

  test('1. RECONCILED + complete calculator -> numeric contribution and a reconciled (green) badge', () => {
    const r = row('RECONCILED')
    expect(r.contribution.kind).toBe('exact')
    expect(r.contribution.contributionProfitCents).toBe(650)
    expect(r.contribution.word).toBeNull()
    expect(r.badgeText).toBe('Reconciled'); expect(r.badgeTone).toBe('ok'); expect(r.href).toBeNull()
  })
  test('2. INCOMPLETE -> Unknown / non-exact, never green "Reconciled"', () => {
    const r = row('INCOMPLETE')
    expect(r.contribution.kind).toBe('unknown'); expect(r.contribution.word).toBe('Unknown')
    expect(r.contribution.contributionProfitCents).toBeNull()
    expect(r.badgeText).toBe('Incomplete'); expect(r.badgeTone).not.toBe('ok'); expect(r.href).toBe(RECONCILIATION_HREF)
  })
  test('3. EXCEPTION -> Invalid / non-exact, never green "Reconciled"', () => {
    const r = row('EXCEPTION')
    expect(r.contribution.kind).toBe('invalid'); expect(r.contribution.word).toBe('Invalid')
    expect(r.contribution.contributionProfitCents).toBeNull(); expect(r.contribution.contributionMarginPct).toBeNull()
    expect(r.badgeText).toBe('Exception'); expect(r.badgeTone).toBe('bad'); expect(r.href).toBe(RECONCILIATION_HREF)
  })
  test('4. calculator says COMPLETE but integrity says EXCEPTION -> EXCEPTION wins', () => {
    const r = row('EXCEPTION', { calculatorState: 'complete', contributionProfitCents: 123456 })
    expect(r.badgeText).toBe('Exception')
    expect(r.badgeText).not.toBe('Reconciled')
    expect(r.contribution.contributionProfitCents).toBeNull()
    expect(r.contribution.word).toBe('Invalid')
  })
  test('INCOMPLETE and EXCEPTION are visibly different statuses', () => {
    expect(row('INCOMPLETE').badgeText).not.toBe(row('EXCEPTION').badgeText)
    expect(row('INCOMPLETE').badgeTone).not.toBe(row('EXCEPTION').badgeTone)
  })
  test('a missing integrity state is never treated as reconciled', () => {
    const r = row(undefined)
    expect(r.badgeText).not.toBe('Reconciled'); expect(r.contribution.kind).not.toBe('exact')
  })
  test('RECONCILED but calculator inputs partial/unknown keeps the calculator detail and no exact number', () => {
    const p = row('RECONCILED', { calculatorState: 'partial', contributionProfitCents: null })
    expect(p.badgeText).toBe('Partial'); expect(p.contribution.word).toBe('Unknown'); expect(p.badgeTone).toBe('warn')
    const u = row('RECONCILED', { calculatorState: 'unknown', contributionProfitCents: null })
    expect(u.badgeText).toBe('Unreconciled'); expect(u.contribution.kind).not.toBe('exact')
  })
  test('a calculator "partial" can never be exact even if a stale number is passed with RECONCILED', () => {
    expect(row('RECONCILED', { calculatorState: 'partial', contributionProfitCents: 999 }).contribution.kind).not.toBe('exact')
  })
})

describe('BLOCKER 2 (source): the Financials page uses the row rule and the stale formula is gone', () => {
  const client = fs.readFileSync(path.join(__dirname, '../../app/admin/financials/FinancialsClient.tsx'), 'utf8')
  const rows = client.slice(client.indexOf('recentOrders.map('))
  test('the recent-orders row consumes integrityState through orderRowPresentation', () => {
    expect(rows).toMatch(/orderRowPresentation\(/)
    expect(rows).toMatch(/integrityState:\s*o\.integrityState/)
  })
  test('the row no longer renders the calculator state as the badge', () => {
    expect(client).not.toMatch(/<ReconciliationBadge\s+state=\{o\.reconciliation\.state\}/)
    expect(rows).not.toMatch(/moneyOrUnknown\(o\.contributionProfitCents/)
  })
  test('5. the stale simplified formula is removed and replaced with the canonical description', () => {
    expect(client).not.toContain('Contribution profit = net revenue − COGS − shipping cost − Stripe fees.')
    expect(client).toMatch(/Canonical order contribution = net revenue/)
    for (const w of ['return', 'exchange', 'dispute', 'affiliate']) expect(client).toContain(w)
  })
  test('known-so-far diagnostics elsewhere on the page are preserved', () => {
    expect(client).toContain('knownSoFarLabel')
    expect(client).toContain('profitPresentation')
  })
})

describeDB('BLOCKER 2 (route): the real summary handler sends canonical row values', () => {
  test('an EXCEPTION order has a numeric calculator figure but a null canonical contribution and state EXCEPTION', async () => {
    needDb()
    await mkOrder(F.q, 20); await mkOrder(F.q, 21)
    await q(`UPDATE orders SET total_cents = total_cents + 77 WHERE id=$1`, [oid(21)])
    const { GET } = require('../../app/api/admin/financials/summary/route')
    const res = await GET(new NextRequest('http://localhost/api/admin/financials/summary?range=30d'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const byId = (n: number) => body.recentOrders.find((o: any) => o.orderId === oid(n))
    expect(byId(20).integrityState).toBe('RECONCILED')
    expect(byId(20).contributionProfitCents).toBe(650)
    expect(byId(21).integrityState).toBe('EXCEPTION')
    expect(byId(21).contributionProfitCents).toBeNull()                       // authoritative: Invalid
    expect(byId(21).knownSoFarContributionProfitCents).toBe(650)              // raw diagnostic stays available
    expect(body.integrity.state).toBe('EXCEPTION')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 3 — single-order financial API
// ─────────────────────────────────────────────────────────────────────────────
describe('BLOCKER 3 (pure): canonical order contribution and the integrity fold', () => {
  test('RECONCILED + known -> exact; INCOMPLETE -> null/Unknown; EXCEPTION -> null/Invalid', () => {
    expect(canonicalOrderContribution({ integrityState: 'RECONCILED', contributionProfitCents: 5 }).contributionProfitCents).toBe(5)
    const i = canonicalOrderContribution({ integrityState: 'INCOMPLETE', contributionProfitCents: 5 })
    expect([i.contributionProfitCents, i.word]).toEqual([null, 'Unknown'])
    const e = canonicalOrderContribution({ integrityState: 'EXCEPTION', contributionProfitCents: 5 })
    expect([e.contributionProfitCents, e.word]).toEqual([null, 'Invalid'])
  })
  test('RECONCILED with an unknown calculator input is Unknown, never $0', () => {
    const c = canonicalOrderContribution({ integrityState: 'RECONCILED', contributionProfitCents: null })
    expect(c.contributionProfitCents).toBeNull(); expect(c.kind).toBe('unknown')
  })
  test('the fold: any exception -> EXCEPTION; else any incomplete -> INCOMPLETE; advisories never count', () => {
    const f = (...s: string[]) => mapOrderIntegrity(s.map(state => ({ issue_code: 'X', state, domain: 'd', summary: 's' })), 'now')
    expect(f().state).toBe('RECONCILED')
    expect(f('advisory').state).toBe('RECONCILED')
    expect(f('incomplete', 'advisory').state).toBe('INCOMPLETE')
    expect(f('incomplete', 'exception').state).toBe('EXCEPTION')
    expect(f('incomplete', 'exception')).toMatchObject({ exceptionCount: 1, incompleteCount: 1 })
  })
})

describeDB('BLOCKER 3 (SQL + real handler): /api/admin/financials/orders/[id] exposes integrity', () => {
  const get = async (n: number) => {
    const { GET } = require('../../app/api/admin/financials/orders/[id]/route')
    const res = await GET(new NextRequest(`http://localhost/api/admin/financials/orders/${oid(n)}`),
                          { params: Promise.resolve({ id: oid(n) }) })
    return { status: res.status, body: await res.json() }
  }

  test('1. clean order -> RECONCILED and a canonical exact numeric contribution', async () => {
    needDb()
    await mkOrder(F.q, 30)
    const { status, body } = await get(30)
    expect(status).toBe(200)
    expect(body.integrity.state).toBe('RECONCILED')
    expect(body.canonical).toMatchObject({ kind: 'exact', state: 'RECONCILED', contributionProfitCents: 1500 - 300 - 450 - 100 })
  })
  test('2. missing required input -> INCOMPLETE and canonical contribution null (Unknown)', async () => {
    needDb()
    await mkOrder(F.q, 31, { fee: null })
    const { body } = await get(31)
    expect(body.integrity.state).toBe('INCOMPLETE')
    expect(body.canonical).toMatchObject({ kind: 'unknown', contributionProfitCents: null, word: 'Unknown' })
    expect(body.order.economics.contributionProfitCents).toBeNull()
  })
  test('3. contradiction with ALL numeric inputs -> EXCEPTION and canonical contribution null (Invalid)', async () => {
    needDb()
    await mkOrder(F.q, 32)
    await q(`UPDATE orders SET total_cents = total_cents + 77 WHERE id=$1`, [oid(32)])
    const { body } = await get(32)
    expect(body.integrity.state).toBe('EXCEPTION')
    expect(body.integrity.byCode.map((c: any) => c.issueCode)).toContain('ORDER_TOTAL_MISMATCH')
    expect(body.canonical).toMatchObject({ kind: 'invalid', contributionProfitCents: null, word: 'Invalid' })
    // the RAW calculator figure is still there for diagnostics, but is flagged non-authoritative
    expect(body.order.economics.contributionProfitCents).toBe(650)
    expect(body.order.economics.reconciliation.state).toBe('complete')
    expect(body.order.authoritative).toBe(false)
  })
  test('4. correcting the contradiction restores RECONCILED and the exact number', async () => {
    needDb()
    await q(`UPDATE orders SET total_cents = total_cents - 77 WHERE id=$1`, [oid(32)])
    const { body } = await get(32)
    expect(body.integrity.state).toBe('RECONCILED')
    expect(body.canonical).toMatchObject({ kind: 'exact', contributionProfitCents: 650 })
  })
  test('a refund-component contradiction is also EXCEPTION', async () => {
    needDb()
    await mkOrder(F.q, 33)
    await addRefund(F.q, 33, 're_33', 500, { fee: 0 })
    await q(`UPDATE order_refunds SET merchandise_refund_cents = 400 WHERE stripe_refund_id='re_33'`)   // 400+0+0 <> 500
    const { body } = await get(33)
    expect(body.integrity.state).toBe('EXCEPTION')
    expect(body.canonical.contributionProfitCents).toBeNull()
  })
  test('unknown order -> 404, bad id -> 400', async () => {
    needDb()
    expect((await get(999)).status).toBe(404)
    const { GET } = require('../../app/api/admin/financials/orders/[id]/route')
    expect((await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(400)
  })
  test('single-order state equals the period per-order state for every order (one rule, one scan)', async () => {
    needDb()
    const period = await createFinancialService(F.sql).getPeriodReport(dayRange(5))
    for (const o of period.orders) {
      const single = await createFinancialService(F.sql).getOrderFinancialView(o.orderId)
      expect(single!.integrity.state).toBe(period.integrity.orderStates[o.orderId] ?? 'RECONCILED')
    }
    expect(period.orders.length).toBeGreaterThan(3)
  })
})

describe('BLOCKER 3 (source): the route reuses the scan and does not recompute reconciliation', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8')
  test('route is admin-gated first and returns integrity + canonical', () => {
    const src = read('app/api/admin/financials/orders/[id]/route.ts')
    expect(src.indexOf('requireAdmin(req)')).toBeLessThan(src.search(/\(sql\)|sql`/))
    expect(src).toMatch(/getOrderFinancialView\(/)
    expect(src).toMatch(/integrity:\s*row\.integrity/)
    expect(src).toMatch(/canonical:\s*row\.canonical/)
  })
  test('the order state comes from financial_integrity_scan(), not a second calculation', () => {
    const svc = read('lib/financial-integrity.ts')
    expect(svc).toMatch(/FROM financial_integrity_scan\(\)\s+WHERE order_id = \$1::uuid/)
  })
})
