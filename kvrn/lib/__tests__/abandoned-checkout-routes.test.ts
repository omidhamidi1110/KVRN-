// HTTP behaviour of the abandoned-checkout routes with the service mocked (no database).
// The service itself is covered against real PostgreSQL in abandoned-checkout-db.test.ts.
import { NextRequest } from 'next/server'
import { RetryError } from '../abandoned-checkout'

const svc: any = {
  sweep: jest.fn(), listForAdmin: jest.fn(), summary: jest.fn(), getConfig: jest.fn(), deliveryReadiness: jest.fn(),
  saveConfig: jest.fn(), manualRetry: jest.fn(), resolveRecovery: jest.fn(), recordClick: jest.fn(), recordResumed: jest.fn(),
  unsubscribeByToken: jest.fn(),
}
const resume: any = { resume: jest.fn() }
const auditInserts: any[] = []

jest.mock('@/lib/abandoned-checkout-runtime', () => ({ get abandonedService() { return svc }, get resumeService() { return resume } }))
jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    ;(global as any).__ORDER.push('requireAdmin')
    if ((global as any).__DENY) return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    return { identity: { email: 'admin@test.local' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({
  sql: (strings: TemplateStringsArray, ...v: unknown[]) => { auditInserts.push({ text: strings.join('?'), v }); return Promise.resolve([]) },
}))

import { POST as sweepPOST } from '../../app/api/internal/abandoned-checkout-sweep/route'
import { GET as adminGET, PUT as adminPUT, POST as adminPOST } from '../../app/api/admin/abandoned-checkouts/route'
import { POST as recoverPOST } from '../../app/api/checkout/recover/route'
import { GET as unsubGET, POST as unsubPOST } from '../../app/api/checkout/recover/unsubscribe/route'

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-0c2d3e4f5a6b'
const req = (url: string, init: any = {}) => new NextRequest('http://localhost' + url, init)
const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  req(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => {
  Object.values(svc).forEach((f: any) => f.mockReset()); resume.resume.mockReset(); auditInserts.length = 0
  ;(global as any).__ORDER = []; ;(global as any).__DENY = false
  process.env.CRON_SECRET = 'cron-secret-for-tests'
  svc.deliveryReadiness.mockReturnValue({ ready: true })
})

describe('sweep route', () => {
  const call = (auth?: string) => sweepPOST(req('/api/internal/abandoned-checkout-sweep', { method: 'POST', headers: auth ? { Authorization: auth } : {} }))
  test('401 without bearer, 403 wrong, 503 unconfigured; the service is never reached', async () => {
    expect((await call()).status).toBe(401)
    expect((await call('Bearer nope')).status).toBe(403)
    delete process.env.CRON_SECRET
    expect((await call('Bearer anything')).status).toBe(503)
    expect(svc.sweep).not.toHaveBeenCalled()
  })
  test('200 with counts only', async () => {
    svc.sweep.mockResolvedValue({ abandoned: 1, queued: 1, sent: 1, sendSkipped: null })
    const r = await call('Bearer cron-secret-for-tests')
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ abandoned: 1, queued: 1, sent: 1, sendSkipped: null })
  })
  test('a failing sweep answers 500 with no detail', async () => {
    svc.sweep.mockRejectedValue(new Error('secret db detail'))
    const r = await call('Bearer cron-secret-for-tests'); expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).not.toMatch(/secret db detail/)
  })
})

describe('admin route', () => {
  test('every verb is rejected before touching the service when not admin', async () => {
    ;(global as any).__DENY = true
    expect((await adminGET(req('/api/admin/abandoned-checkouts'))).status).toBe(401)
    expect((await adminPUT(json('/api/admin/abandoned-checkouts', 'PUT', { revision: 0, config: {} }))).status).toBe(401)
    expect((await adminPOST(json('/api/admin/abandoned-checkouts', 'POST', { action: 'retry', id: UUID }))).status).toBe(401)
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled()
    expect(auditInserts).toHaveLength(0)
  })
  test('GET returns rows, summary, config, revision, readiness', async () => {
    svc.listForAdmin.mockResolvedValue([]); svc.summary.mockResolvedValue({ recovered: 0 })
    svc.getConfig.mockResolvedValue({ config: { enabled: true }, revision: 3 })
    const r = await adminGET(req('/api/admin/abandoned-checkouts?view=failed&limit=10'))
    const b = await r.json(); expect(r.status).toBe(200)
    expect(b.data).toMatchObject({ rows: [], revision: 3, readiness: { ready: true } })
    expect(svc.listForAdmin).toHaveBeenCalledWith({ view: 'failed', limit: 10, offset: 0 })
  })
  test('PUT: revision required, validation errors 400, stale 409, ok 200', async () => {
    expect((await adminPUT(json('/x', 'PUT', { config: {} }))).status).toBe(400)
    expect((await adminPUT(json('/x', 'PUT', { revision: -1, config: {} }))).status).toBe(400)
    svc.saveConfig.mockResolvedValueOnce({ ok: false, errors: { delay_minutes: 'bad' } })
    const bad = await adminPUT(json('/x', 'PUT', { revision: 1, config: { delay_minutes: 1 } }))
    expect(bad.status).toBe(400); expect((await bad.json()).errors.delay_minutes).toBe('bad')
    svc.saveConfig.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stale' }))
    expect((await adminPUT(json('/x', 'PUT', { revision: 1, config: {} }))).status).toBe(409)
    svc.saveConfig.mockResolvedValueOnce({ ok: true, config: { enabled: false }, revision: 2 })
    const ok = await adminPUT(json('/x', 'PUT', { revision: 1, config: { enabled: false } }))
    expect(ok.status).toBe(200); expect(svc.saveConfig).toHaveBeenLastCalledWith({ enabled: false }, 1, 'admin@test.local')
  })
  test('POST retry: only a real UUID and the retry action; audited with ids only', async () => {
    for (const body of [{}, { action: 'retry' }, { action: 'retry', id: 'not-a-uuid' }, { action: 'delete', id: UUID }, { action: 'retry', id: "x'; DROP TABLE a;--" }]) {
      expect((await adminPOST(json('/x', 'POST', body))).status).toBe(400)
    }
    expect(svc.manualRetry).not.toHaveBeenCalled()
    svc.manualRetry.mockResolvedValue(undefined)
    expect((await adminPOST(json('/x', 'POST', { action: 'retry', id: UUID }))).status).toBe(200)
    expect(svc.manualRetry).toHaveBeenCalledWith(UUID)
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0].text).toMatch(/admin_audit_logs/)
    expect(auditInserts[0].text).toContain("'abandoned.retry'")
    expect(JSON.stringify(auditInserts[0].v)).not.toMatch(/@(?!test\.local)/)
  })
  test('POST retry maps RetryError codes and writes no audit row on refusal', async () => {
    svc.manualRetry.mockRejectedValueOnce(new RetryError('not_found', 'Not found.'))
    expect((await adminPOST(json('/x', 'POST', { action: 'retry', id: UUID }))).status).toBe(404)
    svc.manualRetry.mockRejectedValueOnce(new RetryError('disabled', 'Off.'))
    expect((await adminPOST(json('/x', 'POST', { action: 'retry', id: UUID }))).status).toBe(409)
    expect(auditInserts).toHaveLength(0)
  })
})

describe('public recover route', () => {
  const call = (body: unknown, headers: Record<string, string> = {}) => recoverPOST(json('/api/checkout/recover', 'POST', body, headers))
  test.each([
    ['disabled', 404], ['unconfigured', 503], ['invalid', 400], ['expired', 410], ['already_ordered', 200],
  ])('%s -> %i, never a 500, no cookie, no side effects', async (status, code) => {
    svc.resolveRecovery.mockResolvedValue({ status })
    const r = await call({ t: 'abc' })
    expect(r.status).toBe(code); expect((await r.json()).status).toBe(status)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(svc.recordClick).not.toHaveBeenCalled(); expect(resume.resume).not.toHaveBeenCalled()
  })
  test('garbage body is handled as an invalid token', async () => {
    svc.resolveRecovery.mockResolvedValue({ status: 'invalid' })
    const r = await recoverPOST(req('/api/checkout/recover', { method: 'POST', body: 'not json' }))
    expect(r.status).toBe(400); expect(svc.resolveRecovery).not.toHaveBeenCalled()
  })
  const okResume = { ok: true, cart: [{ sku: 'A', quantity: 1 }], lines: [{ sku: 'A' }], subtotalCents: 100, priceChanged: false, currency: 'usd', discount: null, notices: [], affiliateSessionId: null }
  test('ok: returns the rebuilt bag, sets the httpOnly recovery cookie, records click + resume', async () => {
    svc.resolveRecovery.mockResolvedValue({ status: 'ok', row: { id: UUID } }); resume.resume.mockResolvedValue(okResume)
    const r = await call({ t: 'tok123' })
    const b = await r.json(); expect(r.status).toBe(200)
    expect(b).toMatchObject({ status: 'ok', redirectTo: '/checkout', subtotalCents: 100 })
    expect(b.affiliateSessionId).toBeUndefined()
    const c = r.headers.get('set-cookie')!; expect(c).toMatch(/kvrn_recover=tok123/); expect(c).toMatch(/HttpOnly/i)
    expect(svc.recordClick).toHaveBeenCalledTimes(1); expect(svc.recordResumed).toHaveBeenCalledWith({ id: UUID }, { lines: 1, priceChanged: false })
  })
  test('affiliate session restored only when the visitor has none', async () => {
    svc.resolveRecovery.mockResolvedValue({ status: 'ok', row: { id: UUID } })
    resume.resume.mockResolvedValue({ ...okResume, affiliateSessionId: 'a'.repeat(32) })
    const { AFFILIATE_SESSION_COOKIE } = await import('../affiliate-session')
    const without = await call({ t: 't' })
    expect(without.headers.get('set-cookie')).toContain(AFFILIATE_SESSION_COOKIE + '=' + 'a'.repeat(32))
    const withCookie = await call({ t: 't' }, { cookie: `${AFFILIATE_SESSION_COOKIE}=${'b'.repeat(32)}` })
    expect(withCookie.headers.get('set-cookie')).not.toContain(AFFILIATE_SESSION_COOKIE + '=' + 'a'.repeat(32))
  })
  test('nothing buyable: reports unavailable, sets no cookie, records no resume', async () => {
    svc.resolveRecovery.mockResolvedValue({ status: 'ok', row: { id: UUID } }); resume.resume.mockResolvedValue({ ok: false, code: 'all_unavailable' })
    const r = await call({ t: 't' })
    expect(await r.json()).toEqual({ status: 'unavailable', reason: 'all_unavailable' })
    expect(r.headers.get('set-cookie')).toBeNull(); expect(svc.recordResumed).not.toHaveBeenCalled()
  })
  test('responses are not cacheable or indexable', async () => {
    svc.resolveRecovery.mockResolvedValue({ status: 'expired' })
    const r = await call({ t: 't' }); expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('x-robots-tag')).toBe('noindex')
  })
})

describe('unsubscribe route', () => {
  test('GET never unsubscribes (mail scanners prefetch); it shows a confirm form', async () => {
    const r = await unsubGET(req('/api/checkout/recover/unsubscribe?t=' + 'a'.repeat(40)))
    expect(r.status).toBe(200); expect(await r.text()).toMatch(/<form method="POST"/)
    expect(svc.unsubscribeByToken).not.toHaveBeenCalled()
    expect(r.headers.get('x-robots-tag')).toBe('noindex')
  })
  test('GET rejects a malformed token without echoing it', async () => {
    const r = await unsubGET(req('/api/checkout/recover/unsubscribe?t=' + encodeURIComponent('<script>alert(1)</script>')))
    expect(r.status).toBe(400); expect(await r.text()).not.toContain('<script>alert')
  })
  test('POST: ok -> 200, unconfigured -> 503, otherwise 400', async () => {
    for (const [status, code] of [['ok', 200], ['unconfigured', 503], ['invalid', 400], ['expired', 400]] as const) {
      svc.unsubscribeByToken.mockResolvedValueOnce({ status })
      const r = await unsubPOST(req('/api/checkout/recover/unsubscribe?t=tok', { method: 'POST' }))
      expect(r.status).toBe(code)
    }
  })
})
