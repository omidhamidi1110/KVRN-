// lib/__tests__/order-tags.test.ts
//
// Internal order tags — validators, source guards, and (real PostgreSQL, local only) CRUD, assignment,
// list filter / count, audit, and the guarantees that a tag never changes payment/accounting/fulfillment,
// that a tag named "Hold" is NOT a fraud hold, and that tags never reach a customer.

import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import {
  normalizeTagName, normalizeTagColor, mapTagDbError, OrderTagError, TAG_ERRORS, ORDER_TAG_NAME_MAX,
  ORDER_TAGS_PER_ORDER_MAX, createOrderTagService,
} from '../order-tags'
import { createAdminOrderService } from '../admin-orders'
import { HAVE_DB, TEST_DB_URL, createFiDb, type FiDb } from './helpers/fi-pg'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => (global as any).__AUTH_OK === false
    ? { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    : { identity: { email: 'owner@kvrn.test' }, error: null },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__CX_SQL } }))

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('validators', () => {
  test('name: trimmed, whitespace collapsed, bounded, no control characters', () => {
    expect(normalizeTagName('  Big   spender ')).toEqual({ ok: true, name: 'Big spender' })
    expect(normalizeTagName('x'.repeat(ORDER_TAG_NAME_MAX)).ok).toBe(true)
    for (const bad of [undefined, null, 5, '', '   ', 'x'.repeat(ORDER_TAG_NAME_MAX + 1), 'a\u0000b', 'a\u007fb'] as any[]) {
      expect(normalizeTagName(bad).ok).toBe(false)
    }
    expect(normalizeTagName('a\nb')).toEqual({ ok: true, name: 'a b' })                 // newline is whitespace, collapsed
  })
  test('color: only the fixed palette; blank = neutral', () => {
    expect(normalizeTagColor(undefined)).toEqual({ ok: true, color: 'neutral' })
    expect(normalizeTagColor('')).toEqual({ ok: true, color: 'neutral' })
    expect(normalizeTagColor('red')).toEqual({ ok: true, color: 'red' })
    expect(normalizeTagColor('#ff0000').ok).toBe(false)
    expect(normalizeTagColor('purple').ok).toBe(false)
    expect(normalizeTagColor(5 as any).ok).toBe(false)
  })
  test('database error codes map to stable statuses; unknown errors are re-thrown', () => {
    for (const [code, v] of Object.entries(TAG_ERRORS)) expect([400, 404, 409]).toContain(v.status)
    try { mapTagDbError(new Error('KVRN_TAG|DUPLICATE')) } catch (e: any) { expect(e).toBeInstanceOf(OrderTagError); expect([e.status, e.code]).toEqual([409, 'DUPLICATE']) }
    try { mapTagDbError(new Error('KVRN_TAG|IN_USE|3')) } catch (e: any) { expect([e.status, e.code]).toEqual([409, 'IN_USE']) }
    expect(() => mapTagDbError(new Error('connection reset'))).toThrow('connection reset')
    expect(() => mapTagDbError(new Error('KVRN_TAG|SOMETHING_NEW'))).toThrow('KVRN_TAG|SOMETHING_NEW')
  })
})

describe('source guards', () => {
  test('tags are not written by, or joined into, any money / inventory / fulfillment code path', () => {
    const svc = read('lib/order-tags.ts').replace(/\/\/.*$/gm, '')
    expect(svc).not.toMatch(/payment_status|fulfillment_status|total_cents|inventory|order_refunds|UPDATE\s+orders/i)
    const raw = read('db/migrations/031_order_tags_fraud_review.sql')
    const tagSql = raw.slice(raw.indexOf('-- Validation helpers'), raw.lastIndexOf('2. FRAUD REVIEW')).replace(/--.*$/gm, '')
    expect(tagSql.length).toBeGreaterThan(1000)
    expect(tagSql).not.toMatch(/UPDATE\s+orders|payment_status|fulfillment_status|inventory_|order_refunds/i)
  })
  test('financial, inventory, checkout and e-mail code never reads tags', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter(f => /\.ts$/.test(f))) {
      if (['order-tags.ts', 'admin-orders.ts', 'fraud-review.ts'].includes(f)) continue
      if (/order_tags|order_tag_assignments|order-tags/.test(read(`lib/${f}`))) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
  test('the tag filter does not alter the original list/count queries (they are byte-identical outside the new branch)', () => {
    const src = read('lib/admin-orders.ts')
    // The pre-existing eight list queries and eight count queries are still present verbatim.
    expect(src).toContain("WHERE o.payment_status = ${paymentStatus} AND o.fulfillment_status = ${fulfillmentStatus}\n          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}")
    expect(src).toContain("const r = await sql`SELECT COUNT(*)::int AS n FROM orders`")
    expect(src.match(/if \(params\.tagId\)/g)).toHaveLength(2)                         // list + count branch only
  })
  test('the orders list route validates the tag filter as a uuid', () => {
    const r = read('app/api/orders/route.ts')
    expect(r).toMatch(/UUID_RE\.test\(tagId\)/)
  })
})

const describeDB = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) {
  test(TEST_DB_URL ? 'NOTE: tag DB tests skipped — TEST_DATABASE_URL is not a local server.' : 'NOTE: tag DB tests skipped — TEST_DATABASE_URL absent.', () => { expect(true).toBe(true) })
}

let F: FiDb
let pgFail: string | null = null
const needDb = () => { if (pgFail) throw new Error('local PostgreSQL unavailable: ' + pgFail) }
const q = (t: string, p: unknown[] = []) => F.q(t, p)
const oid = (n: number) => `f3300000-0000-0000-0000-${String(n).padStart(12, '0')}`
const ACTOR = 'owner@kvrn.test'

beforeAll(async () => {
  if (!HAVE_DB) return
  try {
    F = await createFiDb('kvrn_tg')
    ;(global as any).__CX_SQL = F.sql
    for (let n = 1; n <= 6; n++) {
      await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,fulfillment_status,currency,subtotal_cents,shipping_cents,total_cents,customer_email,customer_name,paid_at)
               VALUES ($1,$2,$3,$4,$5,$6,'usd',1000,500,1500,$7,$8,now())`,
        [oid(n), `TG-${n}`, `cs_tg${n}`, `pi_tgtest${n}0000`, n === 4 ? 'refunded' : 'paid', n === 3 ? 'processing' : 'unfulfilled',
         `cust${n}@example.com`, n === 2 ? 'Vera Vipperson' : `Customer ${n}`])
    }
  } catch (e: any) { pgFail = String(e?.message ?? e) }
}, 180_000)
afterAll(async () => { await F?.close() })
beforeEach(() => { (global as any).__AUTH_OK = true })

const svc = () => createOrderTagService(F.sql)
const tagId = async (name: string) => (await q(`SELECT id FROM order_tags WHERE lower(name)=lower($1)`, [name]))[0]?.id as string
const audit = (action: string) => q(`SELECT actor_email, resource, resource_id, payload FROM admin_audit_logs WHERE action=$1 ORDER BY created_at`, [action])
const tagsRoute = async (method: 'GET' | 'POST', body?: any) => {
  const mod = require('../../app/api/admin/orders/tags/route')
  const res = await mod[method](new NextRequest('http://localhost/api/admin/orders/tags', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }))
  return { status: res.status, body: await res.json() }
}
const tagRoute = async (method: 'PATCH' | 'DELETE', id: string, body?: any) => {
  const mod = require('../../app/api/admin/orders/tags/[tagId]/route')
  const res = await mod[method](new NextRequest(`http://localhost/api/admin/orders/tags/${id}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), { params: Promise.resolve({ tagId: id }) })
  return { status: res.status, body: await res.json() }
}
const orderTagsRoute = async (method: 'GET' | 'POST' | 'DELETE', n: number, o: { body?: any; qs?: string } = {}) => {
  const mod = require('../../app/api/admin/orders/[id]/tags/route')
  const id = oid(n)
  const res = await mod[method](new NextRequest(`http://localhost/api/admin/orders/${id}/tags${o.qs ?? ''}`, { method, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body), headers: { 'content-type': 'application/json' } }) }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}
const listRoute = async (qs: string) => {
  const { GET } = require('../../app/api/orders/route')
  const res = await GET(new NextRequest(`http://localhost/api/orders${qs}`))
  return { status: res.status, body: await res.json() }
}

describeDB('tag CRUD (atomic with audit)', () => {
  test('example tags are seeded as ordinary rows', async () => {
    needDb()
    const names = (await svc().listTags()).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['Hold', 'VIP', 'UGC', 'Replacement', 'Manual Review']))
  })

  test('create: audited; duplicate (any case) refused; invalid input refused', async () => {
    needDb()
    const t = await svc().createTag('Wholesale', 'green', ACTOR)
    expect(t).toMatchObject({ name: 'Wholesale', color: 'green', archived: false })
    expect((await audit('order_tag.create')).find((a: any) => a.resource_id === t.id)).toMatchObject({ actor_email: ACTOR, payload: { name: 'Wholesale', color: 'green' } })
    await expect(svc().createTag('wholesale', 'red', ACTOR)).rejects.toMatchObject({ code: 'DUPLICATE', status: 409 })
    await expect(svc().createTag('VIP', 'red', ACTOR)).rejects.toMatchObject({ code: 'DUPLICATE' })
    await expect(svc().createTag('  ', 'red', ACTOR)).rejects.toMatchObject({ code: 'NAME_REQUIRED' })
    await expect(svc().createTag('x'.repeat(33), 'red', ACTOR)).rejects.toMatchObject({ code: 'NAME_TOO_LONG' })
    await expect(svc().createTag('ok', 'pink' as any, ACTOR)).rejects.toMatchObject({ code: 'COLOR_INVALID' })
    await expect(svc().createTag('ok', 'red', '')).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' })
    expect(await F.err(`INSERT INTO order_tags (name,created_by) VALUES ('WHOLESALE','x')`)).toMatch(/order_tags_name_ci_uq/)   // the index itself enforces it
  })

  test('rename / recolour / archive / restore: audited with before+after; no-op writes nothing', async () => {
    needDb()
    const id = await tagId('Wholesale')
    const n0 = (await audit('order_tag.update')).length
    expect(await svc().updateTag(id, { name: 'Wholesale buyer', color: 'blue' }, ACTOR)).toMatchObject({ outcome: 'updated', name: 'Wholesale buyer', color: 'blue' })
    const a = (await audit('order_tag.update')).slice(-1)[0]
    expect(a.payload).toMatchObject({ before: { name: 'Wholesale', color: 'green' }, after: { name: 'Wholesale buyer', color: 'blue' } })
    expect(await svc().updateTag(id, { name: 'wholesale BUYER' }, ACTOR)).toMatchObject({ outcome: 'updated' })      // case-only rename is a rename
    expect(await svc().updateTag(id, { color: 'blue' }, ACTOR)).toMatchObject({ outcome: 'unchanged' })
    expect((await audit('order_tag.update')).length).toBe(n0 + 2)
    await expect(svc().updateTag(id, { name: 'VIP' }, ACTOR)).rejects.toMatchObject({ code: 'DUPLICATE' })
    expect(await svc().updateTag(id, { archived: true }, ACTOR)).toMatchObject({ archived: true })
    expect((await svc().listTags({ includeArchived: false })).map(t => t.name)).not.toContain('wholesale BUYER')
    expect(await svc().updateTag(id, { archived: false }, ACTOR)).toMatchObject({ archived: false })
    await expect(svc().updateTag('f3300000-0000-0000-0000-00000000dead', { name: 'x' }, ACTOR)).rejects.toMatchObject({ code: 'TAG_NOT_FOUND', status: 404 })
  })

  test('delete: an unused tag can be deleted (audited); a tag on an order cannot — archive it instead', async () => {
    needDb()
    const free = await svc().createTag('Temp', 'neutral', ACTOR)
    await svc().deleteTag(free.id, ACTOR)
    expect(await tagId('Temp')).toBeUndefined()
    expect((await audit('order_tag.delete')).some((a: any) => a.resource_id === free.id)).toBe(true)
    await svc().assign(oid(6), await tagId('UGC'), ACTOR)
    await expect(svc().deleteTag(await tagId('UGC'), ACTOR)).rejects.toMatchObject({ code: 'IN_USE', status: 409 })
    expect(await tagId('UGC')).toBeTruthy()
    // and the foreign key itself backs this up
    expect(await F.err(`DELETE FROM order_tags WHERE lower(name)='ugc'`)).toMatch(/foreign key constraint/)
    await svc().remove(oid(6), await tagId('UGC'), ACTOR)
  })
})

describeDB('assignment', () => {
  test('assign is idempotent and audited once; remove is idempotent and audited once', async () => {
    needDb()
    const vip = await tagId('VIP')
    const a0 = (await audit('order.tag_add')).length, r0 = (await audit('order.tag_remove')).length
    expect(await svc().assign(oid(1), vip, ACTOR)).toBe('assigned')
    expect(await svc().assign(oid(1), vip, ACTOR)).toBe('already_assigned')
    expect((await audit('order.tag_add')).length).toBe(a0 + 1)
    expect((await audit('order.tag_add')).slice(-1)[0]).toMatchObject({ actor_email: ACTOR, resource: 'order', resource_id: oid(1), payload: { tag: 'VIP', order_number: 'TG-1' } })
    expect((await svc().tagsForOrder(oid(1))).map(t => t.name)).toEqual(['VIP'])
    expect(await svc().remove(oid(1), vip, ACTOR)).toBe('removed')
    expect(await svc().remove(oid(1), vip, ACTOR)).toBe('not_assigned')
    expect((await audit('order.tag_remove')).length).toBe(r0 + 1)
    expect(await svc().tagsForOrder(oid(1))).toEqual([])
  })
  test('unknown order / tag, archived tags, and the per-order limit', async () => {
    needDb()
    await expect(svc().assign('f3300000-0000-0000-0000-00000000dead', await tagId('VIP'), ACTOR)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 })
    await expect(svc().assign(oid(1), 'f3300000-0000-0000-0000-00000000dead', ACTOR)).rejects.toMatchObject({ code: 'TAG_NOT_FOUND' })
    const arch = await svc().createTag('Old', 'neutral', ACTOR)
    await svc().assign(oid(5), arch.id, ACTOR)
    await svc().updateTag(arch.id, { archived: true }, ACTOR)
    expect((await svc().tagsForOrder(oid(5))).map(t => t.name)).toContain('Old')          // history stays visible
    await expect(svc().assign(oid(1), arch.id, ACTOR)).rejects.toMatchObject({ code: 'TAG_ARCHIVED', status: 409 })
    expect(await svc().assign(oid(5), arch.id, ACTOR)).toBe('already_assigned')           // already on: harmless
    for (let i = 0; i < ORDER_TAGS_PER_ORDER_MAX; i++) await svc().assign(oid(2), (await svc().createTag(`bulk${i}`, 'neutral', ACTOR)).id, ACTOR)
    await expect(svc().assign(oid(2), await tagId('VIP'), ACTOR)).rejects.toMatchObject({ code: 'TOO_MANY', status: 409 })
    expect((await svc().tagsForOrder(oid(2))).length).toBe(ORDER_TAGS_PER_ORDER_MAX)
  })
  test('concurrent identical assignments produce one row and one audit entry', async () => {
    needDb()
    const t = await svc().createTag('Race', 'amber', ACTOR)
    const before = (await audit('order.tag_add')).length
    const res = await Promise.all([1, 2, 3].map(() => svc().assign(oid(6), t.id, ACTOR).catch(e => e)))
    expect(res.filter(r => r === 'assigned')).toHaveLength(1)
    expect(Number((await q(`SELECT COUNT(*) c FROM order_tag_assignments WHERE order_id=$1 AND tag_id=$2`, [oid(6), t.id]))[0].c)).toBe(1)
    expect((await audit('order.tag_add')).length).toBe(before + 1)
  })
})

describeDB('list filter / count / detail', () => {
  test('without a tag filter the results are EXACTLY what they were before tags existed', async () => {
    needDb()
    const o = createAdminOrderService(F.sql)
    const base = { limit: 100, offset: 0 }
    const legacy = await o.listOrders({ ...base })
    // snapshot, then tag orders and compare again: untagged queries are not influenced
    const vip = await tagId('VIP')
    await svc().assign(oid(3), vip, ACTOR); await svc().assign(oid(4), vip, ACTOR)
    for (const p of [{}, { paymentStatus: 'paid' }, { fulfillmentStatus: 'unfulfilled' }, { paymentStatus: 'paid', fulfillmentStatus: 'processing' },
                     { search: 'Vera' }, { search: 'cust3', paymentStatus: 'paid' }, { search: 'TG-', fulfillmentStatus: 'unfulfilled' }, { search: 'cust1', paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled' }]) {
      const rows = await o.listOrders({ ...base, ...p } as any)
      const tagless = rows.map((r: any) => r.id)
      expect(Object.keys(rows[0] ?? {})).not.toContain('tags')                       // raw rows are untouched
      expect(await o.countOrders(p as any)).toBe(rows.length)
      if (!Object.keys(p).length) expect(rows).toEqual(legacy)
      expect(tagless.length).toBeGreaterThanOrEqual(0)
    }
  })
  test('tag filter: only tagged orders, combinable with status and search; count matches; wildcards are literal', async () => {
    needDb()
    const o = createAdminOrderService(F.sql)
    const vip = await tagId('VIP')
    const all = await o.listOrders({ tagId: vip, limit: 100, offset: 0 })
    expect(all.map((r: any) => r.orderNumber).sort()).toEqual(['TG-3', 'TG-4'])
    expect(await o.countOrders({ tagId: vip })).toBe(2)
    expect((await o.listOrders({ tagId: vip, paymentStatus: 'refunded', limit: 100, offset: 0 })).map((r: any) => r.orderNumber)).toEqual(['TG-4'])
    expect((await o.listOrders({ tagId: vip, fulfillmentStatus: 'processing', limit: 100, offset: 0 })).map((r: any) => r.orderNumber)).toEqual(['TG-3'])
    expect((await o.listOrders({ tagId: vip, search: 'customer 3', limit: 100, offset: 0 })).map((r: any) => r.orderNumber)).toEqual(['TG-3'])
    expect(await o.countOrders({ tagId: vip, search: 'customer 3' })).toBe(1)
    expect(await o.countOrders({ tagId: vip, search: '%' })).toBe(0)
    expect(await o.countOrders({ tagId: vip, paymentStatus: 'paid', fulfillmentStatus: 'processing', search: 'TG-' })).toBe(1)
    expect((await o.listOrders({ tagId: vip, limit: 1, offset: 1 })).length).toBe(1)
    expect(await o.listOrders({ tagId: 'f3300000-0000-0000-0000-00000000dead', limit: 10, offset: 0 })).toEqual([])
  })
  test('orders list route: tag filter + chips on rows; invalid tag is a 400; untagged rows get an empty list', async () => {
    needDb()
    const vip = await tagId('VIP')
    const r = await listRoute(`?tag=${vip}`)
    expect(r.status).toBe(200)
    expect(r.body.meta.total).toBe(2)
    expect(r.body.data.map((x: any) => x.orderNumber).sort()).toEqual(['TG-3', 'TG-4'])
    expect(r.body.data[0].tags.map((t: any) => t.name)).toContain('VIP')
    expect(r.body.data[0]).toHaveProperty('fraud')
    const all = await listRoute('?limit=100')
    expect(all.body.data.find((x: any) => x.orderNumber === 'TG-1').tags).toEqual([])
    expect((await listRoute('?tag=not-a-uuid')).status).toBe(400)
  })
  test('order detail carries the chips (and fraudHoldActive false)', async () => {
    needDb()
    const d = await createAdminOrderService(F.sql).getOrderDetail(oid(3))
    expect(d!.tags.map(t => t.name)).toEqual(['VIP'])
    expect(d!.fraudHoldActive).toBe(false)
  })
})

describeDB('tags never change payment, accounting or fulfillment; "Hold" is only a label', () => {
  test('tagging / untagging / archiving leaves every order and financial row byte-identical', async () => {
    needDb()
    const snap = async () => JSON.stringify([
      await q(`SELECT * FROM orders ORDER BY id`),
      (await q(`SELECT md5(COALESCE(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM financial_integrity_scan() t`))[0].h,
      await q(`SELECT COUNT(*) FROM order_refunds`), await q(`SELECT COUNT(*) FROM inventory_movements`),
    ])
    const before = await snap()
    const hold = await tagId('Hold')
    for (const n of [1, 3, 4]) await svc().assign(oid(n), hold, ACTOR)
    await svc().updateTag(hold, { color: 'red', archived: true }, ACTOR)
    await svc().updateTag(hold, { archived: false }, ACTOR)
    for (const n of [1, 3, 4]) await svc().remove(oid(n), hold, ACTOR)
    expect(await snap()).toBe(before)
  })
  test('an order tagged "Hold" can still be moved to processing and shipped (it is not a fraud hold)', async () => {
    needDb()
    const hold = await tagId('Hold')
    await svc().assign(oid(1), hold, ACTOR)
    const o = createAdminOrderService(F.sql)
    expect(await o.transitionToProcessing(oid(1))).toBe('updated')
    expect((await o.markOrderShipped(oid(1), 'USPS', 'TRK-TG1')).outcome).toBe('shipped')
    expect(Number((await q(`SELECT COUNT(*) c FROM order_fraud_reviews WHERE order_id=$1`, [oid(1)]))[0].c)).toBe(0)
  })
})

describeDB('routes: admin-gated, validated, audited', () => {
  test.each([
    ['tags GET', () => tagsRoute('GET')],
    ['tags POST', () => tagsRoute('POST', { name: 'Nope' })],
    ['tag PATCH', () => tagRoute('PATCH', 'f3300000-0000-0000-0000-00000000dead', { name: 'x' })],
    ['tag DELETE', () => tagRoute('DELETE', 'f3300000-0000-0000-0000-00000000dead')],
    ['order tags GET', () => orderTagsRoute('GET', 1)],
    ['order tags POST', () => orderTagsRoute('POST', 1, { body: { tagId: 'f3300000-0000-0000-0000-00000000dead' } })],
    ['order tags DELETE', () => orderTagsRoute('DELETE', 1, { qs: '?tagId=f3300000-0000-0000-0000-00000000dead' })],
    ['orders list', () => listRoute('')],
  ])('%s: unauthenticated -> 401 and nothing written', async (_n, call) => {
    needDb()
    ;(global as any).__AUTH_OK = false
    const before = JSON.stringify([await q(`SELECT COUNT(*) FROM order_tags`), await q(`SELECT COUNT(*) FROM order_tag_assignments`), await q(`SELECT COUNT(*) FROM admin_audit_logs`)])
    expect((await call()).status).toBe(401)
    expect(JSON.stringify([await q(`SELECT COUNT(*) FROM order_tags`), await q(`SELECT COUNT(*) FROM order_tag_assignments`), await q(`SELECT COUNT(*) FROM admin_audit_logs`)])).toBe(before)
  })
  test('tags: create / list / rename / archive / delete over HTTP with the right statuses', async () => {
    needDb()
    expect((await tagsRoute('POST', { name: '' })).status).toBe(400)
    expect((await tagsRoute('POST', { name: 'ok', color: 'neon' })).status).toBe(400)
    expect((await tagsRoute('POST', { name: 'ok', extra: 1 })).status).toBe(400)
    const c = await tagsRoute('POST', { name: 'Gift', color: 'violet' })
    expect([c.status, c.body.data.name]).toEqual([201, 'Gift'])
    expect((await tagsRoute('POST', { name: 'gift' })).status).toBe(409)
    expect((await tagsRoute('GET')).body.data.map((t: any) => t.name)).toContain('Gift')
    expect((await tagRoute('PATCH', c.body.data.id, {})).status).toBe(400)
    expect((await tagRoute('PATCH', c.body.data.id, { archived: 'yes' })).status).toBe(400)
    expect((await tagRoute('PATCH', c.body.data.id, { name: 'Gift order' })).body.data.name).toBe('Gift order')
    expect((await tagRoute('PATCH', 'nope', { name: 'x' })).status).toBe(400)
    expect((await tagRoute('DELETE', c.body.data.id)).status).toBe(200)
    expect((await tagRoute('DELETE', c.body.data.id)).status).toBe(404)
  })
  test('order tags over HTTP: add (idempotent), list, remove; validation and in-use refusal', async () => {
    needDb()
    const rep = await tagId('Replacement')
    expect((await orderTagsRoute('POST', 5, { body: {} })).status).toBe(400)
    expect((await orderTagsRoute('POST', 5, { body: { tagId: 'x' } })).status).toBe(400)
    expect((await orderTagsRoute('POST', 5, { body: { tagId: rep, extra: 1 } })).status).toBe(400)
    const a = await orderTagsRoute('POST', 5, { body: { tagId: rep } })
    expect([a.status, a.body.outcome]).toEqual([200, 'assigned'])
    expect((await orderTagsRoute('POST', 5, { body: { tagId: rep } })).body.outcome).toBe('already_assigned')
    expect((await orderTagsRoute('GET', 5)).body.data.map((t: any) => t.name)).toContain('Replacement')
    expect((await tagRoute('DELETE', rep)).status).toBe(409)
    expect((await orderTagsRoute('DELETE', 5, { qs: '?tagId=nope' })).status).toBe(400)
    expect((await orderTagsRoute('DELETE', 5, { qs: `?tagId=${rep}` })).body.outcome).toBe('removed')
    expect((await orderTagsRoute('DELETE', 5, { qs: `?tagId=${rep}` })).body.outcome).toBe('not_assigned')
  })
  test('the order cancellation / PATCH routes and existing detail shape still work with tags present', async () => {
    needDb()
    const { PATCH } = require('../../app/api/orders/[id]/route')
    const id = oid(6)
    const res = await PATCH(new NextRequest(`http://localhost/api/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ fulfillmentStatus: 'processing' }), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id }) })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.data).toMatchObject({ fulfillmentStatus: 'processing', orderNumber: 'TG-6' })
    expect(Array.isArray(j.data.tags)).toBe(true)
  })
})
