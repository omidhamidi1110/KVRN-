// lib/__tests__/tax-export.test.ts
//
// Minimal tax-ready export: GET /api/admin/financials/tax-export?year=YYYY
//
// Pure blocks always run. Real-PostgreSQL blocks run only with a LOCAL TEST_DATABASE_URL
// (see helpers/fi-pg.ts) and exercise the REAL route handler end to end.
//
// Each DB test uses its own tax year so seeded orders never leak between tests.

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import {
  parseTaxYear, taxYearRange, centsToUsd, taxRowsToCsv, buildTaxExportRows,
  taxExportFilename, TAX_EXPORT_DISCLAIMER, type TaxRow,
} from '../tax-export'
import { HAVE_DB, TEST_DB_URL, createFiDb, seedCatalog, mkOrder, addRefund, oid, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__TX_DENY) {
      return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    }
    return { identity: { email: 'tax@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__TX_SQL } }))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: tax-export DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: tax-export real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

// ── tiny RFC 4180 reader for the tests ───────────────────────────────────────
function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r') { /* swallow, \n ends the row */ }
    else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row) }
  return out
}
interface Line { section: string; amountUsd: string; amountCents: string; status: string; floorUsd: string; detail: string }
const toLines = (csv: string): Record<string, Line> => {
  const rows = parseCsv(csv); const m: Record<string, Line> = {}
  for (const r of rows.slice(1)) {
    m[r[1]] = { section: r[0], amountUsd: r[2], amountCents: r[3], status: r[4], floorUsd: r[5], detail: r[6] }
  }
  return m
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE
// ─────────────────────────────────────────────────────────────────────────────
describe('year validation is strict', () => {
  const now = new Date('2026-10-03T00:00:00Z')
  test.each(['2026', '2025', '2000'])('accepts %s', y => {
    expect(parseTaxYear(y, now)).toEqual({ ok: true, year: Number(y) })
  })
  test.each([
    null, undefined, '', 'abc', '26', '026', '20260', '2026.5', '-2026', ' 2026', '2026 ', '2026-01',
    '0x7EA', '1e3', '1999', '2027', '9999', '2026;DROP', '٢٠٢٦',
  ])('rejects %p', y => {
    expect(parseTaxYear(y as any, now).ok).toBe(false)
  })
  test('the range is the half-open UTC calendar year', () => {
    expect(taxYearRange(2025)).toEqual({ start: '2025-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' })
  })
  test('filename carries KVRN and the year', () => { expect(taxExportFilename(2026)).toBe('kvrn-tax-summary-2026.csv') })
})

describe('money text is exact integer arithmetic', () => {
  test.each([[0, '0.00'], [5, '0.05'], [100, '1.00'], [123456, '1234.56'], [-1250, '-12.50'], [-5, '-0.05']])(
    '%d cents -> %s', (c, s) => expect(centsToUsd(c)).toBe(s))
})

describe('CSV encoding', () => {
  const row = (over: Partial<TaxRow>): TaxRow => ({
    section: 'S', line: 'L', amountCents: 100, status: 'COMPLETE', knownSoFarCents: null, detail: 'd', ...over })

  test('CRLF endings, header first, trailing newline', () => {
    const csv = taxRowsToCsv([row({})])
    expect(csv.startsWith('section,line_item,amount_usd,amount_cents,status,known_so_far_usd,detail\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.split('\r\n').length).toBe(3)
  })
  test('a negative amount stays a real number, not text', () => {
    const csv = taxRowsToCsv([row({ amountCents: -1250 })])
    expect(csv).toContain(',-12.50,-1250,')
    expect(csv).not.toContain("'-12.50")
  })
  test('free text cannot start a formula (=, +, -, @, tab, CR)', () => {
    for (const evil of ['=HYPERLINK("x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) {
      const csv = taxRowsToCsv([row({ line: evil, detail: evil })])
      const cells = parseCsv(csv)[1]
      expect(cells[1].startsWith("'")).toBe(true)
      expect(cells[6].startsWith("'")).toBe(true)
    }
  })
  test('commas, quotes and newlines are quoted', () => {
    const cells = parseCsv(taxRowsToCsv([row({ detail: 'a,"b"\nc' })]))[1]
    expect(cells[6]).toBe('a,"b"\nc')
  })
  test('a null amount is an EMPTY cell, never 0', () => {
    const cells = parseCsv(taxRowsToCsv([row({ amountCents: null, status: 'INCOMPLETE', knownSoFarCents: 700 })]))[1]
    expect(cells[2]).toBe(''); expect(cells[3]).toBe(''); expect(cells[5]).toBe('7.00')
  })
})

describe('source: the route is admin-only, read-only and reuses the canonical report', () => {
  const route = read('app/api/admin/financials/tax-export/route.ts')
  const lib = read('lib/tax-export.ts')
  test('requireAdmin runs before the year is even parsed', () => {
    expect(route.indexOf('requireAdmin(req)')).toBeGreaterThan(-1)
    expect(route.indexOf('requireAdmin(req)')).toBeLessThan(route.indexOf('parseTaxYear('))
  })
  test('uses getPeriodReport; no second calculator', () => {
    expect(route).toContain('getPeriodReport(')
    expect(lib).not.toMatch(/computePeriodEconomics|computeOrderEconomics/)
  })
  test('writes nothing', () => {
    for (const src of [route, lib]) expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s/)
  })
  test('does not touch recurring definitions except to COUNT them', () => {
    expect(lib).toMatch(/SELECT COUNT\(\*\)/)
    expect(lib).not.toMatch(/INSERT INTO expense_transactions/)
  })
  test('logs only a truncated message', () => {
    expect(route).toContain('err?.message?.slice(0, 120)')
    expect(route).not.toMatch(/console\.\w+\([^)]*(email|order|req\b)/i)
  })
  test('says it is not a tax return and gives no tax conclusions', () => {
    expect(TAX_EXPORT_DISCLAIMER).toMatch(/NOT a filed tax return/)
    expect(TAX_EXPORT_DISCLAIMER).toMatch(/not\s+tax, legal or accounting advice/)
    expect(lib).not.toMatch(/deductible:|you may deduct|taxable income is/i)
  })
  test('the existing reconciliation export is untouched', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/api/admin/financials/integrity/export/route.ts'))).toBe(true)
  })
})

describe('builder: unknown is never zero (pure)', () => {
  // A period with one order that lacks a Stripe fee and COGS.
  const period: any = {
    orderCount: 1, grossMerchandiseCents: 1000, merchandiseDiscountCents: 0, merchandiseRevenueCents: 1000,
    shippingRevenueCents: 500, exchangeRevenueCents: 0, refundCents: 0, disputeLossCents: 0,
    disputeRefundOverlapCents: 0, netRevenueCents: 1500, taxCollectedCents: 80,
    cogsCents: 0, shippingCostCents: 450, stripeFeeCents: 0, returnCogsCreditCents: 0, exchangeCogsCents: 0,
    exchangeShippingCostCents: 0, returnLabelCostCents: 0, disputeFeeCents: 0, affiliateCommissionCents: 0,
    advertisingSpendCents: 0, recognizedOperatingExpensesCents: 0, recognizedDevelopmentExpensesCents: 0,
    writeOffCostCents: 0,
    canonicalOrderContributionCents: null, canonicalOperatingProfitCents: null,
    contributionProfitCents: 1050, nonAuthoritativeOperatingProfitCents: 1050, profitCompleteness: 'incomplete',
  }
  const orders = [{ economics: { reconciliation: { missing: [{ field: 'cogs' }, { field: 'stripe_fee' }] } } }]
  const lines = () => {
    const csv = taxRowsToCsv(buildTaxExportRows({
      year: 2025, generatedAt: '2026-10-03T00:00:00.000Z', now: new Date('2026-10-03T00:00:00Z'),
      period, orders, integrity: { state: 'INCOMPLETE', exceptionCount: 0, incompleteCount: 2, orderCohortCount: 1 },
      writeOffUnknown: false, cashRefundsPaidCents: 0, cashExpensePaymentsCents: 0, fixedDefinitionsWithoutPaidBill: 0,
    }))
    return toLines(csv)
  }
  test('unknown COGS and Stripe fee export BLANK with INCOMPLETE and a floor', () => {
    const l = lines()
    expect(l['Product COGS recognized']).toMatchObject({ amountUsd: '', amountCents: '', status: 'INCOMPLETE', floorUsd: '0.00' })
    expect(l['Stripe / payment processing fees']).toMatchObject({ amountCents: '', status: 'INCOMPLETE' })
  })
  test('known lines are still exported, flagged UNVERIFIED while the period is not reconciled', () => {
    const l = lines()
    expect(l['Shipping / fulfillment expense']).toMatchObject({ amountCents: '450', status: 'UNVERIFIED' })
    expect(l['Sales tax collected']).toMatchObject({ amountCents: '80' })
  })
  test('profit lines are blank, with the floor kept apart', () => {
    const l = lines()
    expect(l['Order contribution']).toMatchObject({ amountCents: '', status: 'INCOMPLETE', floorUsd: '10.50' })
    expect(l['Operating profit (before income tax)']).toMatchObject({ amountCents: '', status: 'INCOMPLETE' })
  })
  test('an exception period marks profit EXCEPTION', () => {
    const csv = taxRowsToCsv(buildTaxExportRows({
      year: 2025, generatedAt: 'x', period: { ...period, profitCompleteness: 'exception' }, orders,
      integrity: { state: 'EXCEPTION', exceptionCount: 1, incompleteCount: 0, orderCohortCount: 1 },
      writeOffUnknown: false, cashRefundsPaidCents: 0, cashExpensePaymentsCents: 0, fixedDefinitionsWithoutPaidBill: 0,
    }))
    expect(toLines(csv)['Operating profit (before income tax)'].status).toBe('EXCEPTION')
  })
  test('unknown write-off cost is blank, not zero', () => {
    const csv = taxRowsToCsv(buildTaxExportRows({
      year: 2025, generatedAt: 'x', period, orders: [],
      integrity: { state: 'RECONCILED', exceptionCount: 0, incompleteCount: 0, orderCohortCount: 0 },
      writeOffUnknown: true, cashRefundsPaidCents: 0, cashExpensePaymentsCents: 0, fixedDefinitionsWithoutPaidBill: 0,
    }))
    expect(toLines(csv)['Inventory write-offs']).toMatchObject({ amountCents: '', status: 'INCOMPLETE' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REAL ROUTE + POSTGRES
// ─────────────────────────────────────────────────────────────────────────────
let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const Y0 = new Date().getUTCFullYear() - 1       // a completed year; each test below uses its own offset
const yr = (k: number) => Y0 - k
const paidAt = (n: number, iso: string) => q(`UPDATE orders SET paid_at = $2::timestamptz WHERE id = $1`, [oid(n), iso])

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_taxexp')
    await seedCatalog(F.q)
    ;(global as any).__TX_SQL = F.sql
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close(); (global as any).__TX_DENY = false })
afterEach(() => { (global as any).__TX_DENY = false })

async function call(year: string | null) {
  const { GET } = require('../../app/api/admin/financials/tax-export/route')
  const url = 'http://localhost/api/admin/financials/tax-export' + (year === null ? '' : `?year=${year}`)
  return GET(new NextRequest(url))
}
async function exportOf(year: number) {
  const res = await call(String(year))
  expect(res.status).toBe(200)
  return toLines(await res.text())
}

describeDB('admin auth, validation and headers', () => {
  test('401 without admin, and the database is not consulted', async () => {
    needDb()
    ;(global as any).__TX_DENY = true
    const spy = jest.spyOn(F.db, 'query')
    const res = await call(String(yr(0)))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  test.each([null, '', 'abc', '26', '20260', '2026.5', '-2026', '1999', String(new Date().getUTCFullYear() + 1)])(
    'invalid year %p -> 400 and no database access', async y => {
      needDb()
      const spy = jest.spyOn(F.db, 'query')
      const res = await call(y)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/year/)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  test('content type, attachment filename with year, no-store', async () => {
    needDb()
    const res = await call(String(yr(0)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="kvrn-tax-summary-${yr(0)}.csv"`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
  test('carries the requested year, a generated timestamp and the not-a-tax-return notice', async () => {
    needDb()
    const l = await exportOf(yr(0))
    expect(l['Tax year requested'].detail).toBe(String(yr(0)))
    expect(l['Generated at (UTC)'].detail).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(l['Notice'].detail).toMatch(/NOT a filed tax return/)
    expect(l['Year status'].detail).toMatch(/Completed/)
  })
  test('an empty year is exact zeros (nothing is unknown) and the profit is a real 0', async () => {
    needDb()
    const l = await exportOf(yr(20))
    expect(l['Net revenue']).toMatchObject({ amountCents: '0', status: 'COMPLETE' })
    expect(l['Operating profit (before income tax)']).toMatchObject({ amountCents: '0', status: 'COMPLETE' })
  })
})

describeDB('year boundaries', () => {
  test('[Jan 1 00:00Z, next Jan 1 00:00Z) is half-open', async () => {
    needDb()
    const Y = yr(12)
    await mkOrder(F.q, 101); await paidAt(101, `${Y}-01-01T00:00:00.000Z`)          // IN  (first instant)
    await mkOrder(F.q, 102); await paidAt(102, `${Y}-12-31T23:59:59.999Z`)          // IN  (last instant)
    await mkOrder(F.q, 103); await paidAt(103, `${Y + 1}-01-01T00:00:00.000Z`)      // OUT (next year's first instant)
    await mkOrder(F.q, 104); await paidAt(104, `${Y - 1}-12-31T23:59:59.999Z`)      // OUT (previous year's last)
    const l = await exportOf(Y)
    expect(l['Gross merchandise sales'].amountCents).toBe('2000')      // exactly the two in-year orders
    expect(l['Net revenue'].amountCents).toBe('3000')
    expect((await exportOf(Y + 1))['Gross merchandise sales'].amountCents).toBe('1000')
    expect((await exportOf(Y - 1))['Gross merchandise sales'].amountCents).toBe('1000')
  })
})

describeDB('accounting rules', () => {
  test('sales tax is its own line and is excluded from every revenue line', async () => {
    needDb()
    const Y = yr(2)
    await mkOrder(F.q, 111, { tax: 80 }); await paidAt(111, `${Y}-06-15T12:00:00Z`)
    const l = await exportOf(Y)
    expect(l['Sales tax collected']).toMatchObject({ amountCents: '80', status: 'COMPLETE', section: 'SALES TAX' })
    expect(l['Gross merchandise sales'].amountCents).toBe('1000')
    expect(l['Shipping revenue'].amountCents).toBe('500')
    expect(l['Net revenue'].amountCents).toBe('1500')                  // 1000 + 500, never 1580
    expect(l['Operating profit (before income tax)'].amountCents).toBe('650')
  })

  test('COGS and the Stripe fee are counted once, even when the order has a refund', async () => {
    needDb()
    const Y = yr(3)
    await mkOrder(F.q, 121); await paidAt(121, `${Y}-03-01T12:00:00Z`)
    await mkOrder(F.q, 122); await paidAt(122, `${Y}-03-02T12:00:00Z`)
    await addRefund(F.q, 122, 're_tx122', 500, { fee: 0, merch: 500, ship: 0, taxPart: 0 })
    const l = await exportOf(Y)
    expect(l['Product COGS recognized'].amountCents).toBe('600')       // 2 x 300, not 900
    expect(l['Less: returned-stock COGS credit'].amountCents).toBe('0')
    expect(l['Replacement (exchange) COGS'].amountCents).toBe('0')
    expect(l['Stripe / payment processing fees'].amountCents).toBe('200')   // 2 x 100, not 300
    expect(l['Shipping / fulfillment expense'].amountCents).toBe('900')
    expect(l['Refunds paid to customers'].amountCents).toBe('500')
    expect(l['Net revenue'].amountCents).toBe('2500')                  // 3000 - 500, reversed once
  })

  test('a refund and a lost dispute over the same money are not reversed twice', async () => {
    needDb()
    const Y = yr(4)
    await mkOrder(F.q, 131); await paidAt(131, `${Y}-05-01T12:00:00Z`)
    await q(`SELECT upsert_order_dispute('du_tx131','ch_FI-131','pi_FI-131',1500,'usd','lost','lost','evt_tx131','charge.dispute.closed',now(),now()-interval '10 days','{}'::jsonb)`)
    await q(`INSERT INTO dispute_balance_transactions (dispute_id,stripe_balance_transaction_id,amount_cents,fee_cents,net_cents)
             SELECT id,'txn_du_tx131',-1500,1500,-3000 FROM order_disputes WHERE stripe_dispute_id='du_tx131'`)
    await addRefund(F.q, 131, 're_tx131', 500, { fee: 0, merch: 500, ship: 0, taxPart: 0 })
    const l = await exportOf(Y)
    expect(l['Refunds paid to customers'].amountCents).toBe('500')
    expect(l['Disputes lost (revenue reversed)'].amountCents).toBe('1000')                 // capped: 1500 - 500
    expect(l['Dispute amount already covered by refunds'].amountCents).toBe('500')         // reported, not reversed again
    expect(l['Net revenue'].amountCents).toBe('0')                                         // 1500 - 500 - 1000
    expect(l['Dispute fees'].amountCents).toBe('1500')
    // The scan flags this exact overlap as an EXCEPTION; the export must not call it verified or profit exact.
    const m = toLines(await (await call(String(Y))).text())
    expect(m['Reconciliation state'].detail).toMatch(/^EXCEPTION/)
    expect(m['Net revenue'].status).toBe('UNVERIFIED')
    expect(m['Operating profit (before income tax)']).toMatchObject({ amountCents: '', status: 'EXCEPTION' })
  })

  test('unknown Stripe fee / COGS stay blank (INCOMPLETE) and profit is blank, never zero', async () => {
    needDb()
    const Y = yr(5)
    await mkOrder(F.q, 141, { fee: null }); await paidAt(141, `${Y}-02-01T12:00:00Z`)
    await mkOrder(F.q, 142, { cogs: null, consume: false }); await paidAt(142, `${Y}-02-02T12:00:00Z`)
    await mkOrder(F.q, 143); await paidAt(143, `${Y}-02-03T12:00:00Z`)
    const l = await exportOf(Y)
    expect(l['Stripe / payment processing fees']).toMatchObject({ amountUsd: '', amountCents: '', status: 'INCOMPLETE', floorUsd: '2.00' })
    expect(l['Stripe / payment processing fees'].detail).toMatch(/1 order\(s\) lack this data/)
    expect(l['Product COGS recognized']).toMatchObject({ amountCents: '', status: 'INCOMPLETE', floorUsd: '6.00' })
    expect(l['Order contribution']).toMatchObject({ amountCents: '', status: 'INCOMPLETE' })
    expect(l['Operating profit (before income tax)']).toMatchObject({ amountCents: '', status: 'INCOMPLETE' })
    expect(l['Operating profit (before income tax)'].floorUsd).not.toBe('')
    // lines whose own inputs are known are not blanked
    expect(l['Gross merchandise sales'].amountCents).toBe('3000')
    expect(l['Shipping / fulfillment expense'].amountCents).toBe('1350')
  })
})

describeDB('recurring definitions are expectations, never expenses', () => {
  test('a monthly definition with no transaction adds NO expense, NO cash, and is only counted for review', async () => {
    needDb()
    const Y = yr(6)
    await mkOrder(F.q, 151); await paidAt(151, `${Y}-04-01T12:00:00Z`)
    await q(`INSERT INTO expense_definitions (provider,category,name,cadence,expected_amount_cents,active,created_by,created_at)
             VALUES ('Neon','infrastructure','Postgres plan','monthly',1900,true,'jest',$1::timestamptz)`, [`${Y}-01-01T00:00:00Z`])
    const before = (await q(`SELECT count(*)::int AS n FROM expense_transactions`))[0].n
    const l = await exportOf(Y)
    expect(l['Operating expenses (recognized)']).toMatchObject({ amountCents: '0' })
    expect(l['Development expenses (recognized)']).toMatchObject({ amountCents: '0' })
    expect(l['Expense invoices paid in year (cash basis)'].amountCents).toBe('0')
    expect(l['Operating profit (before income tax)'].amountCents).toBe('650')       // untouched by the definition
    expect(l['Active fixed-recurring obligations with no paid bill in year'].detail).toMatch(/^Count: 1 /)
    // exporting creates nothing
    expect((await q(`SELECT count(*)::int AS n FROM expense_transactions`))[0].n).toBe(before)
  })

  test('only an ACTUAL transaction is recognised; voiding it removes it again', async () => {
    needDb()
    const Y = yr(7)
    await mkOrder(F.q, 161); await paidAt(161, `${Y}-04-01T12:00:00Z`)
    const def = (await q(`INSERT INTO expense_definitions (provider,category,name,cadence,expected_amount_cents,active,created_by,created_at)
             VALUES ('Neon','infrastructure','Plan','monthly',1900,true,'jest',$1::timestamptz) RETURNING id`, [`${Y}-01-01T00:00:00Z`]))[0].id
    const tx = (await q(`INSERT INTO expense_transactions (expense_definition_id,provider,category,name,amount_cents,paid_at,source)
             VALUES ($1,'Neon','infrastructure','March invoice',1900,$2::date,'manual') RETURNING id`, [def, `${Y}-03-10`]))[0].id
    let l = await exportOf(Y)
    expect(l['Operating expenses (recognized)'].amountCents).toBe('1900')            // exactly the one real invoice, not 12 x 1900
    expect(l['Expense invoices paid in year (cash basis)'].amountCents).toBe('1900')
    expect(l['Operating profit (before income tax)'].amountCents).toBe(String(650 - 1900))
    expect(l['Active fixed-recurring obligations with no paid bill in year'].detail).toMatch(/^Count: 0 /)
    await q(`SELECT void_expense_transaction($1,'jest','test void')`, [tx])
    l = await exportOf(Y)
    expect(l['Operating expenses (recognized)'].amountCents).toBe('0')
    expect(l['Expense invoices paid in year (cash basis)'].amountCents).toBe('0')
  })

  test('annual bill paid last year but serving this year is recognised by service period, cash stays in its paid year', async () => {
    needDb()
    const Y = yr(8)
    await q(`INSERT INTO expense_transactions (provider,category,name,amount_cents,period_start,period_end,paid_at,source)
             VALUES ('Cloudflare','infrastructure','Annual',36500,$1::date,$2::date,$3::date,'manual')`,
            [`${Y}-01-01`, `${Y}-12-31`, `${Y - 1}-12-20`])
    const l = await exportOf(Y)
    expect(l['Operating expenses (recognized)'].amountCents).toBe('36500')
    expect(l['Expense invoices paid in year (cash basis)'].amountCents).toBe('0')
    expect((await exportOf(Y - 1))['Expense invoices paid in year (cash basis)'].amountCents).toBe('36500')
  })
})
