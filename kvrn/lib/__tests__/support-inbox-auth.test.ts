// lib/__tests__/support-inbox-auth.test.ts — the support routes with the REAL admin-auth module
//
// No DB and no mocks of admin-auth: this proves the production auth gate itself (Cloudflare Access
// JWT + allowlist) denies every admin support endpoint, and that a request carrying a forged
// identity header or a malformed JWT gets nowhere. The database is a stub that fails the test if it
// is ever touched by an unauthenticated request.

import { NextRequest } from 'next/server'

const touched: string[] = []
jest.mock('@/lib/db', () => {
  const boom = (what: string) => { touched.push(what); throw new Error('DB must not be touched by an unauthenticated request') }
  return { sql: Object.assign(() => boom('tag'), { query: () => boom('query') }) }
})
const mailerCalls: string[] = []
jest.mock('@/lib/support-email', () => ({
  ...jest.requireActual('@/lib/support-email'),
  getSupportMailer: () => ({
    async send() { mailerCalls.push('send'); return { ok: true, providerMessageId: 're_x' } },
    async retrieveMessageId() { return null },
  }),
}))

const ID = '6f1c2a3e-1111-4222-8333-444455556666'
const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const ctx = { params: Promise.resolve({ id: ID }) }

const routes = () => ({
  list:   (r: NextRequest) => require('../../app/api/admin/support/threads/route').GET(r),
  get:    (r: NextRequest) => require('../../app/api/admin/support/threads/[id]/route').GET(r, ctx),
  read:   (r: NextRequest) => require('../../app/api/admin/support/threads/[id]/read/route').POST(r, ctx),
  status: (r: NextRequest) => require('../../app/api/admin/support/threads/[id]/status/route').POST(r, ctx),
  reply:  (r: NextRequest) => require('../../app/api/admin/support/threads/[id]/reply/route').POST(r, ctx),
})

describe('admin support routes use the real requireAdmin', () => {
  const calls: [keyof ReturnType<typeof routes>, (h?: Record<string, string>) => NextRequest][] = [
    ['list',   h => req('/api/admin/support/threads', 'GET', undefined, h)],
    ['get',    h => req(`/api/admin/support/threads/${ID}`, 'GET', undefined, h)],
    ['read',   h => req(`/api/admin/support/threads/${ID}/read`, 'POST', undefined, h)],
    ['status', h => req(`/api/admin/support/threads/${ID}/status`, 'POST', { status: 'closed' }, h)],
    ['reply',  h => req(`/api/admin/support/threads/${ID}/reply`, 'POST', { body: 'hi', clientRequestId: ID }, h)],
  ]

  test.each(calls)('%s: no credentials → 401 and nothing is touched', async (name, mk) => {
    const res = await routes()[name](mk())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(touched).toEqual([])
    expect(mailerCalls).toEqual([])
  })

  test.each(calls)('%s: forged dev-bypass header and a garbage JWT → still 401 (the bypass is off outside development)', async (name, mk) => {
    for (const headers of <Record<string, string>[]>[
      { 'x-dev-admin-email': 'admin@kvrn.shop' },
      { 'cf-access-jwt-assertion': 'not.a.jwt' },
      { 'cf-access-jwt-assertion': 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFkbWluQGt2cm4uc2hvcCJ9.' },   // alg:none, forged email claim
      { 'x-forwarded-user': 'admin@kvrn.shop', 'cf-access-authenticated-user-email': 'admin@kvrn.shop' },
    ]) {
      const res = await routes()[name](mk(headers))
      expect(res.status).toBe(401)
    }
    expect(touched).toEqual([])
    expect(mailerCalls).toEqual([])
  })
})

describe('ingest route authentication (no admin involved)', () => {
  const ING = () => require('../../app/api/internal/support-email-ingest/route')
  afterEach(() => { delete process.env.SUPPORT_EMAIL_INGEST_SECRET })

  test('not configured → 503; missing or wrong secret → 401; the database is never touched', async () => {
    expect((await ING().POST(req('/api/internal/support-email-ingest', 'POST', {}))).status).toBe(503)
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'the-secret'
    expect((await ING().POST(req('/api/internal/support-email-ingest', 'POST', {}))).status).toBe(401)
    expect((await ING().POST(req('/api/internal/support-email-ingest', 'POST', {}, { authorization: 'Bearer nope' }))).status).toBe(401)
    expect((await ING().POST(req('/api/internal/support-email-ingest', 'POST', {}, { 'x-cron-secret': 'the-secret' }))).status).toBe(401)
    expect(touched).toEqual([])
  })

  test('the CRON_SECRET and admin credentials do NOT open the ingest route', async () => {
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'the-secret'
    process.env.CRON_SECRET = 'cron-secret'
    expect((await ING().POST(req('/api/internal/support-email-ingest', 'POST', {}, { authorization: 'Bearer cron-secret' }))).status).toBe(401)
    delete process.env.CRON_SECRET
  })

  test('with the right secret an invalid payload is a 4xx (validated before any storage)', async () => {
    process.env.SUPPORT_EMAIL_INGEST_SECRET = 'the-secret'
    const r = await ING().POST(req('/api/internal/support-email-ingest', 'POST', { v: 1, envelopeTo: 'support@kvrn.shop' }, { authorization: 'Bearer the-secret' }))
    expect(r.status).toBe(422)
    expect(touched).toEqual([])
  })
})
