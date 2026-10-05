// lib/__tests__/recurring-expenses.test.ts
//
// Minimal recurring-expense support. No migration 023: expense_definitions already models
//   TYPE 1 fixed recurring   cadence monthly | annual  (+ renewal_date as start/anchor, active as the "ended" state)
//   TYPE 2 one-time manual   cadence one_time
//   TYPE 3 variable manual   cadence usage_based (no fixed amount; the REAL bill is entered as a transaction)
// A definition is an EXPECTATION. Only an expense_transaction is a recognised expense, and nothing here
// ever creates one on its own.
//
// Pure blocks always run; real-route blocks need a LOCAL TEST_DATABASE_URL (helpers/fi-pg.ts).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import {
  validateExpenseDefinition, validateExpenseTransaction, isCalendarDate, monthlyEquivalentCents,
} from '../expenses'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__RX_DENY) {
      return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    }
    return { identity: { email: 'recurring@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__RX_SQL } }))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const md5 = (p: string) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex')

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL
    ? 'NOTE: recurring-expense DB tests skipped — TEST_DATABASE_URL is not a local server.'
    : 'NOTE: recurring-expense real-PostgreSQL tests skipped — TEST_DATABASE_URL absent.', () => {
    expect(true).toBe(true)
  })
}

const monthly = { provider: 'Neon', category: 'infrastructure', name: 'Postgres plan', cadence: 'monthly',
                  expectedAmountCents: 1900, renewalDate: '2026-01-15' } as const

// ─────────────────────────────────────────────────────────────────────────────
// PURE: validation
// ─────────────────────────────────────────────────────────────────────────────
describe('calendar dates', () => {
  test.each(['2026-01-31', '2024-02-29', '2026-12-31', '2000-02-29'])('%s is valid', d => expect(isCalendarDate(d)).toBe(true))
  test.each(['2026-02-31', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-1', '26-01-01', '', null, 20260101])(
    '%p is not', d => expect(isCalendarDate(d as any)).toBe(false))
})

describe('TYPE 1 fixed recurring: monthly and annual', () => {
  test('a monthly definition with an integer amount and a start date is valid', () => {
    expect(validateExpenseDefinition({ ...monthly })).toEqual({ ok: true })
  })
  test('an annual definition is valid', () => {
    expect(validateExpenseDefinition({ ...monthly, cadence: 'annual', expectedAmountCents: 22800 })).toEqual({ ok: true })
  })
  test.each(['monthly', 'annual'] as const)('%s needs an amount', cadence => {
    for (const bad of [null, undefined]) {
      const r = validateExpenseDefinition({ ...monthly, cadence, expectedAmountCents: bad as any })
      expect(r.ok).toBe(false)
    }
  })
  test('the start/anchor date is optional (existing API compatibility)', () => {
    const { renewalDate: _ignored, ...noDate } = monthly
    expect(validateExpenseDefinition(noDate as any)).toEqual({ ok: true })
    expect(validateExpenseDefinition({ ...monthly, renewalDate: null })).toEqual({ ok: true })
  })
  test('an impossible date is a validation error, not a database error', () => {
    const r = validateExpenseDefinition({ ...monthly, renewalDate: '2026-02-31' })
    expect(r.ok).toBe(false)
    expect((r as any).error).toMatch(/valid date/)
  })
  test('active, when supplied, must be a boolean', () => {
    expect(validateExpenseDefinition({ ...monthly, active: false })).toEqual({ ok: true })
    expect(validateExpenseDefinition({ ...monthly, active: 'no' as any }).ok).toBe(false)
  })
  test('the monthly equivalent is display-only arithmetic and creates nothing', () => {
    expect(monthlyEquivalentCents('annual', 24000)).toBe(2000)
    expect(monthlyEquivalentCents('monthly', 1900)).toBe(1900)
  })
})

describe('integer-cent validation', () => {
  test.each([19.5, -1, NaN, Infinity, 100_000_01, '1900' as any])('definition amount %p is rejected', v => {
    expect(validateExpenseDefinition({ ...monthly, expectedAmountCents: v }).ok).toBe(false)
  })
  test.each([0, 1, 1900, 100_000_00])('definition amount %p is accepted', v => {
    expect(validateExpenseDefinition({ ...monthly, expectedAmountCents: v }).ok).toBe(true)
  })
  const tx = { provider: 'Twilio', category: 'communications', name: 'August invoice', amountCents: 315,
               paidAt: '2026-09-02' } as const
  test.each([3.15, -5, NaN, '315' as any, undefined as any, 100_000_01])('transaction amount %p is rejected', v => {
    expect(validateExpenseTransaction({ ...tx, amountCents: v }).ok).toBe(false)
  })
  test('transaction dates must be real calendar dates', () => {
    for (const f of ['periodStart', 'periodEnd', 'paidAt'] as const) {
      expect(validateExpenseTransaction({ ...tx, [f]: '2026-02-31' } as any).ok).toBe(false)
    }
    expect(validateExpenseTransaction({ ...tx, periodStart: '2026-08-01', periodEnd: '2026-08-31' })).toEqual({ ok: true })
    expect(validateExpenseTransaction({ ...tx, periodStart: '2026-08-31', periodEnd: '2026-08-01' }).ok).toBe(false)
  })
})

describe('TYPE 2 one-time manual and TYPE 3 variable manual are preserved', () => {
  test('one_time still requires a fixed amount', () => {
    expect(validateExpenseDefinition({ ...monthly, cadence: 'one_time' })).toEqual({ ok: true })
    expect(validateExpenseDefinition({ ...monthly, cadence: 'one_time', expectedAmountCents: null }).ok).toBe(false)
  })
  test('usage_based (variable bill) needs no amount; if one is given it is still integer cents', () => {
    expect(validateExpenseDefinition({ ...monthly, cadence: 'usage_based', expectedAmountCents: null })).toEqual({ ok: true })
    expect(validateExpenseDefinition({ ...monthly, cadence: 'usage_based', expectedAmountCents: undefined })).toEqual({ ok: true })
    expect(validateExpenseDefinition({ ...monthly, cadence: 'usage_based', expectedAmountCents: 1.5 }).ok).toBe(false)
    expect(monthlyEquivalentCents('usage_based', null)).toBeNull()
  })
  test('an unknown cadence is rejected', () => {
    expect(validateExpenseDefinition({ ...monthly, cadence: 'weekly' as any }).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: nothing can fabricate a payment
// ─────────────────────────────────────────────────────────────────────────────
describe('no automatic or duplicate transaction generation (source scan)', () => {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return ['node_modules', '.next', '__tests__'].includes(e.name) ? [] : walk(rel)
    return /\.(ts|tsx|js)$/.test(e.name) ? [rel] : []
  })
  const files = [...walk('app'), ...walk('lib'), ...walk('scripts'), 'cloudflare-cron-wrapper.js', 'middleware.ts']

  test('INSERT INTO expense_transactions exists in exactly one place: createTransaction', () => {
    const hits = files.filter(f => /INSERT\s+INTO\s+expense_transactions/i.test(read(f)))
    expect(hits).toEqual(['lib/expenses.ts'])
    const src = read('lib/expenses.ts')
    const at = src.search(/INSERT\s+INTO\s+expense_transactions/i)
    expect(src.lastIndexOf('async ', at)).toBe(src.lastIndexOf('async createTransaction', at))
  })
  test('no cron job, scheduler or SQL function writes expense_transactions', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => f.endsWith('.sql'))
    const writers = migrations.filter(f => /(INSERT\s+INTO|UPDATE)\s+expense_transactions/i.test(read(`db/migrations/${f}`)))
    // The only SQL that writes the table is void_expense_transaction (021), which sets voided_* on one row;
    // no migration or function inserts expense rows.
    for (const f of migrations) expect(read(`db/migrations/${f}`)).not.toMatch(/INSERT\s+INTO\s+expense_transactions/i)
    expect(writers).toEqual(['021_financial_integrity.sql'])
    const upd = read('db/migrations/021_financial_integrity.sql').match(/UPDATE\s+expense_transactions\s+SET\s+([^\n]+)/i)!
    expect(upd[1]).toMatch(/^voided_at = now\(\), voided_by = .*void_reason = /)
    expect(read('cloudflare-cron-wrapper.js')).not.toMatch(/expense/i)
  })
  test('setDefinitionActive touches only expense_definitions.active', () => {
    const src = read('lib/expenses.ts')
    const body = src.slice(src.indexOf('async setDefinitionActive'), src.indexOf('async deleteDefinition'))
    expect(body).toMatch(/UPDATE expense_definitions SET active = /)
    expect(body).not.toMatch(/expense_transactions/)
  })
  test('migration 023 was not needed and migrations 018-022 are byte-identical to the base', () => {
    expect(fs.existsSync(path.join(ROOT, 'db/migrations/023_recurring_expenses.sql'))).toBe(false)
    // (No migration of this feature exists. 023+ now exist for unrelated, later work; the frozen 018-022
    // hashes below still prove nothing before them was edited.)
    expect(fs.readdirSync(path.join(ROOT, 'db/migrations')).filter(f => /recurring/i.test(f))).toEqual([])
    expect({
      '018': md5('db/migrations/018_returns_exchanges_disputes.sql'),
      '019': md5('db/migrations/019_inventory_fifo_layers.sql'),
      '020': md5('db/migrations/020_affiliates.sql'),
      '021': md5('db/migrations/021_financial_integrity.sql'),
      '022': md5('db/migrations/022_late_payment_recovery.sql'),
    }).toEqual({
      '018': '385b099ac542032df47766dc78676b2b',
      '019': '922f36c20fb71d21e6fe2b0054a77716',
      '020': '9251fab7750f694dfa17303aad400f72',
      '021': 'e7e0cd801ec63b4f22345eb448a9ebba',
      '022': 'f8584f69152f130d8a61f285f5f3090e',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REAL ROUTES + POSTGRES
// ─────────────────────────────────────────────────────────────────────────────
let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_recur')
    ;(global as any).__RX_SQL = F.sql
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__RX_DENY = false })

const json = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
const defs = () => require('../../app/api/admin/expenses/definitions/route')
const defId = () => require('../../app/api/admin/expenses/definitions/[id]/route')
const txs = () => require('../../app/api/admin/expenses/transactions/route')
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const txCount = async () => (await q(`SELECT count(*)::int AS n FROM expense_transactions`))[0].n

describeDB('definitions API: existing behaviour is compatible, nothing is paid by creating one', () => {
  test('POST monthly -> 201, listed as active, and NO transaction exists', async () => {
    needDb()
    const before = await txCount()
    const res = await defs().POST(json('/api/admin/expenses/definitions', 'POST', monthly))
    expect(res.status).toBe(201)
    const list = await (await defs().GET(json('/api/admin/expenses/definitions', 'GET'))).json()
    const d = list.definitions.find((x: any) => x.name === 'Postgres plan')
    expect(d).toMatchObject({ cadence: 'monthly', expectedAmountCents: 1900, active: true, renewalDate: '2026-01-15',
                              monthlyEquivalentCents: 1900 })
    expect(await txCount()).toBe(before)
  })
  test('POST annual without renewalDate/active (the old payload shape) -> 201', async () => {
    needDb()
    const res = await defs().POST(json('/api/admin/expenses/definitions', 'POST',
      { provider: 'Namecheap', category: 'domain', name: 'kvrn.com', cadence: 'annual', expectedAmountCents: 1500 }))
    expect(res.status).toBe(201)
    const list = await (await defs().GET(json('/x', 'GET'))).json()
    expect(list.definitions.find((x: any) => x.provider === 'Namecheap')).toMatchObject({ active: true, renewalDate: null })
  })
  test.each([
    ['impossible date', { ...monthly, renewalDate: '2026-02-31' }],
    ['fractional cents', { ...monthly, expectedAmountCents: 19.5 }],
    ['negative cents', { ...monthly, expectedAmountCents: -1 }],
    ['missing amount', { ...monthly, expectedAmountCents: null }],
    ['bad cadence', { ...monthly, cadence: 'weekly' }],
  ])('%s -> 400 (never a 500) and nothing stored', async (_n, body) => {
    needDb()
    const before = (await q(`SELECT count(*)::int AS n FROM expense_definitions`))[0].n
    const res = await defs().POST(json('/api/admin/expenses/definitions', 'POST', body))
    expect(res.status).toBe(400)
    expect((await q(`SELECT count(*)::int AS n FROM expense_definitions`))[0].n).toBe(before)
  })
  test('creating the same definition twice makes two expectations and ZERO transactions', async () => {
    needDb()
    const before = await txCount()
    for (let i = 0; i < 2; i++) await defs().POST(json('/x', 'POST', { ...monthly, name: 'Twice' }))
    expect((await q(`SELECT count(*)::int AS n FROM expense_definitions WHERE name='Twice'`))[0].n).toBe(2)
    expect(await txCount()).toBe(before)
  })
})

describeDB('PATCH: end / reactivate a recurring definition', () => {
  const mk = async (name: string) => {
    const res = await defs().POST(json('/x', 'POST', { ...monthly, name }))
    return (await res.json()).definition.id as string
  }
  test('ends it, audits it, and leaves every transaction exactly as it was', async () => {
    needDb()
    const id = await mk('To end')
    await q(`INSERT INTO expense_transactions (expense_definition_id,provider,category,name,amount_cents,paid_at,source)
             VALUES ($1,'Neon','infrastructure','Jan invoice',1900,'2026-01-20','manual')`, [id])
    const snap = JSON.stringify(await q(`SELECT * FROM expense_transactions ORDER BY id`))
    const res = await defId().PATCH(json(`/x/${id}`, 'PATCH', { active: false }), ctx(id))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, active: false })
    expect((await q(`SELECT active FROM expense_definitions WHERE id=$1`, [id]))[0].active).toBe(false)
    expect(JSON.stringify(await q(`SELECT * FROM expense_transactions ORDER BY id`))).toBe(snap)
    const audit = await q(`SELECT actor_email, action, resource, payload FROM admin_audit_logs WHERE resource='expense_definition' AND resource_id=$1 AND action='update'`, [id])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_email: 'recurring@test.local', payload: { active: false } })
  })
  test('can be reactivated', async () => {
    needDb()
    const id = await mk('Reactivate')
    await defId().PATCH(json('/x', 'PATCH', { active: false }), ctx(id))
    const res = await defId().PATCH(json('/x', 'PATCH', { active: true }), ctx(id))
    expect(await res.json()).toEqual({ ok: true, active: true })
  })
  test.each([[{}], [{ active: 'false' }], [{ active: 0 }], [{ active: null }], [{ cadence: 'annual' }]])(
    'body %j -> 400 and nothing changes', async body => {
      needDb()
      const id = await mk('Bad body')
      const res = await defId().PATCH(json('/x', 'PATCH', body), ctx(id))
      expect(res.status).toBe(400)
      expect((await q(`SELECT active FROM expense_definitions WHERE id=$1`, [id]))[0].active).toBe(true)
    })
  test('malformed id -> 400; unknown id -> 404', async () => {
    needDb()
    expect((await defId().PATCH(json('/x', 'PATCH', { active: false }), ctx('nope'))).status).toBe(400)
    expect((await defId().PATCH(json('/x', 'PATCH', { active: false }), ctx('00000000-0000-0000-0000-000000000000'))).status).toBe(404)
  })
  test('requires admin and does not touch the database without it', async () => {
    needDb()
    const id = await mk('Auth')
    ;(global as any).__RX_DENY = true
    const spy = jest.spyOn(F.db, 'query')
    const res = await defId().PATCH(json('/x', 'PATCH', { active: false }), ctx(id))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect((await q(`SELECT active FROM expense_definitions WHERE id=$1`, [id]))[0].active).toBe(true)
  })
  test('DELETE still works as before', async () => {
    needDb()
    const id = await mk('Deletable')
    expect((await defId().DELETE(json('/x', 'DELETE'), ctx(id))).status).toBe(200)
    expect((await q(`SELECT count(*)::int AS n FROM expense_definitions WHERE id=$1`, [id]))[0].n).toBe(0)
  })
})

describeDB('TYPE 2 / TYPE 3: manual transactions are the only way an expense appears', () => {
  test('one-time manual invoice: unchanged path, one row', async () => {
    needDb()
    const before = await txCount()
    const res = await txs().POST(json('/x', 'POST', { provider: 'Namecheap', category: 'domain', name: 'kvrn.com',
      amountCents: 1500, paidAt: '2026-03-02' }))
    expect(res.status).toBe(201)
    expect(await txCount()).toBe(before + 1)
  })
  test('variable bill: a usage_based definition has no amount; the real bill is entered by hand, once', async () => {
    needDb()
    const d = await defs().POST(json('/x', 'POST', { provider: 'Twilio', category: 'communications',
      name: 'SMS usage', cadence: 'usage_based', expectedAmountCents: null }))
    expect(d.status).toBe(201)
    const id = (await d.json()).definition.id
    expect((await q(`SELECT count(*)::int AS n FROM expense_transactions WHERE expense_definition_id=$1`, [id]))[0].n).toBe(0)
    const t = await txs().POST(json('/x', 'POST', { expenseDefinitionId: id, provider: 'Twilio',
      category: 'communications', name: 'August invoice', amountCents: 315, paidAt: '2026-09-02',
      periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceId: 'INV-8' }))
    expect(t.status).toBe(201)
    const rows = await q(`SELECT amount_cents, source FROM expense_transactions WHERE expense_definition_id=$1`, [id])
    expect(rows).toEqual([{ amount_cents: 315, source: 'manual' }])
  })
  test.each([
    ['fractional cents', { amountCents: 3.15 }],
    ['impossible paid date', { paidAt: '2026-02-31' }],
    ['impossible period', { periodStart: '2026-04-31', periodEnd: '2026-05-01' }],
  ])('transaction with %s -> 400 and nothing stored', async (_n, over) => {
    needDb()
    const before = await txCount()
    const res = await txs().POST(json('/x', 'POST', { provider: 'Twilio', category: 'communications',
      name: 'Bad', amountCents: 315, paidAt: '2026-09-02', ...over }))
    expect(res.status).toBe(400)
    expect(await txCount()).toBe(before)
  })
  test('only the explicit POSTs above added rows: ending/creating definitions never did', async () => {
    needDb()
    // Every transaction so far was entered by an explicit POST or the seed insert above.
    const rows = await q(`SELECT name FROM expense_transactions ORDER BY name`)
    expect(rows.map((r: any) => r.name).sort()).toEqual(['August invoice', 'Jan invoice', 'kvrn.com'])
  })
})

describeDB('an ended definition leaves the tax-export review count', () => {
  test('active fixed definition without a bill is counted; ending it removes it from the count', async () => {
    needDb()
    const Y = new Date().getUTCFullYear() - 1
    const id = (await q(`INSERT INTO expense_definitions (provider,category,name,cadence,expected_amount_cents,active,created_by,created_at)
      VALUES ('Resend','communications','Pro','monthly',2000,true,'jest',$1::timestamptz) RETURNING id`, [`${Y}-01-01T00:00:00Z`]))[0].id
    const { GET } = require('../../app/api/admin/financials/tax-export/route')
    const review = async () => {
      const text = await (await GET(new NextRequest(`http://localhost/api/admin/financials/tax-export?year=${Y}`))).text()
      const line = text.split('\r\n').find((l: string) => l.includes('Active fixed-recurring obligations'))!
      return Number(/Count: (\d+) /.exec(line)![1])
    }
    const n1 = await review()
    expect(n1).toBeGreaterThanOrEqual(1)
    await defId().PATCH(json('/x', 'PATCH', { active: false }), ctx(id))
    expect(await review()).toBe(n1 - 1)
    expect((await GET(new NextRequest(`http://localhost/api/admin/financials/tax-export?year=${Y}`))).status).toBe(200)
  })
})
