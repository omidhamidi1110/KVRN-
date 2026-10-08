// /api/admin/content/** handlers against real PostgreSQL: authentication on every handler,
// the draft → publish → rollback flow over HTTP, stale-revision 409s, validation 400s and
// error bodies that never leak internals.
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'
import { para, heading } from '../content-richtext'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__CMS_DENY) return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    return { identity: { email: 'owner@kvrn.test' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__CMS_SQL } }))
// A cache that always succeeds: the invalidation plumbing is covered in cache-invalidation tests.
jest.mock('@/lib/cache-invalidation', () => {
  const actual = jest.requireActual('@/lib/cache-invalidation')
  return { ...actual, invalidateAfterCommit: async (_s: unknown, t: any) => ({ id: 'x', ok: true, paths: t.paths ?? [], tags: t.tags ?? [] }) }
})

const ROOT = path.resolve(__dirname, '../..')
const d = HAVE_DB ? describe : describe.skip
let F: FiDb
const BASE = 'http://localhost/api/admin/content'
const R = (p: string) => require(`../../app/api/admin/content/${p}/route`)
const call = async (mod: string, method: string, url: string, params: Record<string, string> = {}, body?: unknown) => {
  const req = new NextRequest(BASE + url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })
  const res = await R(mod)[method](req, { params: Promise.resolve(params) })
  return { status: res.status as number, json: await res.json() }
}
const policy = (slug: string, text = 'Body text.') => ({ slug, title: 'Warranty', style: 'legal', body: { v: 1, blocks: [heading('H'), para(text)] }, seo: {} })

beforeAll(async () => { if (HAVE_DB) { F = await createFiDb('content_routes'); (global as any).__CMS_SQL = F.sql } }, 120000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__CMS_DENY = false })

describe('every content route authenticates first', () => {
  const files: string[] = []
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); e.isDirectory() ? walk(p) : /route\.ts$/.test(e.name) && files.push(p) } }
  walk(path.join(ROOT, 'app/api/admin/content'))
  test('there are routes', () => { expect(files.length).toBeGreaterThanOrEqual(12) })
  test.each(files.map(f => [path.relative(ROOT, f), f]))('%s', (_n, f) => {
    const src = fs.readFileSync(f as string, 'utf8')
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
    expect(handlers.length).toBeGreaterThan(0)
    for (const h of handlers) {
      const start = src.indexOf(`export async function ${h}`)
      const body = src.slice(start, start + 400)
      expect(body).toMatch(/requireAdmin\(req\)/)
      expect(body.indexOf('requireAdmin(req)')).toBeLessThan(body.indexOf('respond(') === -1 ? 1e9 : body.indexOf('respond('))
    }
  })
})

d('content admin API (real PG)', () => {
  test('denied requests get 401 and touch nothing', async () => {
    ;(global as any).__CMS_DENY = true
    const r = await call('[kind]', 'GET', '/policies', { kind: 'policies' })
    expect(r.status).toBe(401)
    const w = await call('[kind]/[id]', 'PUT', '/policies/terms', { kind: 'policies', id: 'terms' }, { snapshot: {}, revision: 1 })
    expect(w.status).toBe(401)
    const s = await call('seo', 'PUT', '/seo', {}, { value: {}, revision: 0 })
    expect(s.status).toBe(401)
  })

  test('unknown kind is 404; bodies must be JSON objects', async () => {
    expect((await call('[kind]', 'GET', '/nope', { kind: 'nope' })).status).toBe(404)
    const req = new NextRequest(BASE + '/policies', { method: 'POST', body: '[1,2]', headers: { 'content-type': 'application/json' } })
    const res = await R('[kind]').POST(req, { params: Promise.resolve({ kind: 'policies' }) })
    expect(res.status).toBe(400)
    const req2 = new NextRequest(BASE + '/policies', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
    expect((await R('[kind]').POST(req2, { params: Promise.resolve({ kind: 'policies' }) })).status).toBe(400)
  })

  test('list returns seeded policies without bodies', async () => {
    const r = await call('[kind]', 'GET', '/policies', { kind: 'policies' })
    expect(r.status).toBe(200)
    expect(r.json.data.map((x: any) => x.id)).toEqual(expect.arrayContaining(['terms', 'privacy', 'cookies', 'shipping-returns']))
    expect(r.json.data[0].snapshot).toBeUndefined()
  })

  test('create → autosave → publish → edit → rollback, with invalidation reported', async () => {
    const c = await call('[kind]', 'POST', '/policies', { kind: 'policies' }, { snapshot: policy('warranty') })
    expect(c.status).toBe(201)
    const id = c.json.data.id as string
    const p = { kind: 'policies', id }
    const s1 = await call('[kind]/[id]', 'PUT', `/policies/${id}`, p, { snapshot: policy('warranty', 'First'), revision: c.json.data.revision })
    expect(s1.status).toBe(200)
    const pub = await call('[kind]/[id]', 'POST', `/policies/${id}`, p, { action: 'publish', revision: s1.json.data.revision })
    expect(pub.status).toBe(200); expect(pub.json.invalidation.ok).toBe(true)
    expect(pub.json.data.path).toBe('/legal/warranty')
    const g = await call('[kind]/[id]', 'GET', `/policies/${id}`, p)
    expect(g.json.data.isLive).toBe(true)
    const s2 = await call('[kind]/[id]', 'PUT', `/policies/${id}`, p, { snapshot: policy('warranty', 'Second'), revision: g.json.data.revision })
    const pub2 = await call('[kind]/[id]', 'POST', `/policies/${id}`, p, { action: 'publish', revision: s2.json.data.revision })
    const hist = await call('[kind]/[id]/versions', 'GET', `/policies/${id}/versions`, p)
    expect(hist.json.data.length).toBeGreaterThanOrEqual(2)
    const first = hist.json.data[hist.json.data.length - 1].version_no
    const one = await new NextRequest(`${BASE}/policies/${id}/versions?version=${first}`)
    const vr = await R('[kind]/[id]/versions').GET(one, { params: Promise.resolve(p) })
    expect(JSON.stringify((await vr.json()).data.snapshot)).toContain('First')
    const rb = await call('[kind]/[id]', 'POST', `/policies/${id}`, p, { action: 'rollback', versionNo: first, revision: pub2.json.data.revision })
    expect(rb.status).toBe(200)
    expect(JSON.stringify((await call('[kind]/[id]', 'GET', `/policies/${id}`, p)).json.data.published)).toContain('First')
  })

  test('stale revision is 409 with a safe message; missing revision is 400', async () => {
    const c = await call('[kind]', 'POST', '/blocks', { kind: 'blocks' }, { snapshot: { name: 'B', category: 'care', content: { v: 1, blocks: [para('x')] } } })
    const p = { kind: 'blocks', id: c.json.data.id }
    const snap = { name: 'B2', category: 'care', content: { v: 1, blocks: [para('y')] } }
    await call('[kind]/[id]', 'PUT', `/blocks/${p.id}`, p, { snapshot: snap, revision: c.json.data.revision })
    const stale = await call('[kind]/[id]', 'PUT', `/blocks/${p.id}`, p, { snapshot: snap, revision: c.json.data.revision })
    expect(stale.status).toBe(409); expect(stale.json.success).toBe(false)
    expect((await call('[kind]/[id]', 'PUT', `/blocks/${p.id}`, p, { snapshot: snap })).status).toBe(400)
    expect((await call('[kind]/[id]', 'POST', `/blocks/${p.id}`, p, { action: 'explode', revision: 1 })).status).toBe(400)
  })

  test('validation errors are 400 with field messages; unsafe URLs are refused', async () => {
    const bad = { ...policy('unsafe'), body: { v: 1, blocks: [{ t: 'p', c: [{ t: 'link', href: 'javascript:alert(1)', text: 'x' }] }] } }
    const r = await call('[kind]', 'POST', '/policies', { kind: 'policies' }, { snapshot: bad })
    expect(r.status).toBe(400); expect(r.json.code).toBe('invalid')
    expect(JSON.stringify(r.json)).not.toMatch(/stack|SELECT|content_/)
  })

  test('singletons use the fixed id; legacy policies cannot be archived', async () => {
    const f = await call('[kind]/[id]', 'GET', '/footer/main', { kind: 'footer', id: 'main' })
    expect(f.status).toBe(200)
    const a = await call('[kind]/[id]', 'POST', '/policies/terms', { kind: 'policies', id: 'terms' }, { action: 'archive', revision: 1 })
    expect(a.status).toBe(403)
  })

  test('translations over HTTP: legal pages need an explicit acknowledgement to publish a language', async () => {
    const p = { kind: 'policies', id: 'cookies' }
    const ov = await call('[kind]/[id]/translations', 'GET', '/policies/cookies/translations', p)
    expect(ov.json.data.legal).toBe(true)
    const f = Object.keys(ov.json.data.source)[0]
    const put = await call('[kind]/[id]/translations', 'PUT', '/policies/cookies/translations', p, { locale: 'es', field: f, value: 'Hola', status: 'draft' })
    expect(put.status).toBe(200)
    const noAck = await call('[kind]/[id]/translations', 'POST', '/policies/cookies/translations', p, { action: 'publish-locale', locale: 'es' })
    expect(noAck.status).toBe(403)
    const bad = await call('[kind]/[id]/translations', 'POST', '/policies/cookies/translations', p, { action: 'publish-locale', locale: '../x', acknowledge: true })
    expect(bad.status).toBe(400)
  })

  test('collections over HTTP: create, products, stale version, archive', async () => {
    const ps = await F.q(`INSERT INTO products (drop_code, product_code, name, slug, price_cents) VALUES ('D','Q1','Q one','q-one',100) RETURNING id`)
    const c = await call('collections', 'POST', '/collections', {}, { slug: 'spring', name: 'Spring', description: '', isActive: true, sortOrder: 1, seo: {} })
    expect(c.status).toBe(201)
    const id = c.json.data.id
    await new Promise(r => setTimeout(r, 15))
    const sp = await call('collections/[id]/products', 'PUT', `/collections/${id}/products`, { id }, { productIds: [ps[0].id], version: c.json.data.version })
    expect(sp.status).toBe(200)
    const stale = await call('collections/[id]/products', 'PUT', `/collections/${id}/products`, { id }, { productIds: [], version: c.json.data.version })
    expect(stale.status).toBe(409)
    const g = await call('collections/[id]', 'GET', `/collections/${id}`, { id })
    expect(g.json.data.products).toHaveLength(1)
    const search = await new NextRequest(`${BASE}/collections/product-search?q=q%20one`)
    expect((await (await R('collections/product-search').GET(search)).json()).data[0].slug).toBe('q-one')
    const ar = await call('collections/[id]', 'POST', `/collections/${id}`, { id }, { action: 'archive', version: g.json.data.version })
    expect(ar.status).toBe(200)
    expect((await call('collections/[id]', 'GET', '/collections/not-a-uuid', { id: 'not-a-uuid' })).status).toBe(404)
  })

  test('product size-guide contract: options, assign, duplicate-and-edit', async () => {
    const ps = await F.q(`INSERT INTO products (drop_code, product_code, name, slug, price_cents) VALUES ('D','Q2','Q two','q-two',100) RETURNING id`)
    const productId = ps[0].id
    const p = { productId }
    const g0 = await call('products/[productId]/size-guide', 'GET', `/products/${productId}/size-guide`, p)
    expect(g0.json.data.assigned).toBeNull(); expect(g0.json.data.options.length).toBeGreaterThanOrEqual(2)
    const as = await call('products/[productId]/size-guide', 'PUT', `/products/${productId}/size-guide`, p, { sizeGuideId: 'kvrn-hoodie' })
    expect(as.status).toBe(200)
    expect((await call('products/[productId]/size-guide', 'GET', `/products/${productId}/size-guide`, p)).json.data.assigned.id).toBe('kvrn-hoodie')
    const dup = await call('products/[productId]/size-guide', 'POST', `/products/${productId}/size-guide`, p, { action: 'duplicate', sizeGuideId: 'kvrn-hoodie' })
    expect(dup.status).toBe(201)
    const g1 = await call('products/[productId]/size-guide', 'GET', `/products/${productId}/size-guide`, p)
    expect(g1.json.data.assigned.id).toBe(dup.json.data.id)
    expect((await call('products/[productId]/size-guide', 'PUT', `/products/${productId}/size-guide`, p, { sizeGuideId: 'a b' })).status).toBe(400)
    const usage = await call('[kind]/[id]/usage', 'GET', '/size-guides/kvrn-hoodie/usage', { kind: 'size-guides', id: 'kvrn-hoodie' })
    expect(usage.json.data).toEqual([])
  })

  test('SEO over HTTP: get, put, stale conflict', async () => {
    const g = await call('seo', 'GET', '/seo')
    expect(g.json.data.value.siteName).toBe('KVRN')
    const ok = await call('seo', 'PUT', '/seo', {}, { value: { ...g.json.data.value, description: 'Changed' }, revision: g.json.data.revision })
    expect(ok.status).toBe(200)
    const stale = await call('seo', 'PUT', '/seo', {}, { value: g.json.data.value, revision: g.json.data.revision })
    expect(stale.status).toBe(409)
  })

  test('preview-context resolves only valid ids and only LIVE blocks', async () => {
    const req = new NextRequest(`${BASE}/preview-context?media=nope,'--&blocks=bad%20id`)
    const res = await R('preview-context').GET(req)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ media: {}, blocks: {} })
  })
})
