// The admin security push hook must never weaken or change what requireAdmin returns.
// Uses the REAL lib/admin-auth with a real RS256-signed JWT and a stubbed Cloudflare Access JWKS endpoint.

import crypto from 'crypto'
import { NextRequest } from 'next/server'

process.env.CF_ACCESS_TEAM_DOMAIN = 'team.example.test'
process.env.CF_ACCESS_AUDIENCE = 'aud-123'
process.env.ADMIN_EMAIL_ALLOWLIST = 'owner@kvrn.test'

const notify = jest.fn<Promise<void>, [string]>(async () => {})
jest.mock('../owner-notifications', () => ({ notifySecurityAlert: (r: string) => notify(r) }))

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'k1', alg: 'RS256', use: 'sig' }
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwt(claims: Record<string, unknown>, key = privateKey) {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), body = b64(claims)
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')
  return `${head}.${body}.${sig}`
}
const req = (token?: string) => new NextRequest('http://localhost/api/admin/x', { headers: token ? { 'cf-access-jwt-assertion': token } : {} })
const future = () => Math.floor(Date.now() / 1000) + 600

let requireAdmin: (r: NextRequest) => Promise<any>
beforeAll(() => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as any
  requireAdmin = require('../admin-auth').requireAdmin
})
beforeEach(() => { notify.mockReset(); notify.mockResolvedValue(undefined) })

describe('requireAdmin + security push', () => {
  test('allowlisted owner: allowed, no push', async () => {
    const r = await requireAdmin(req(jwt({ email: 'owner@kvrn.test', aud: ['aud-123'], exp: future() })))
    expect(r.error).toBeNull(); expect(r.identity).toEqual({ email: 'owner@kvrn.test' })
    expect(notify).not.toHaveBeenCalled()
  })

  test('verified Access identity NOT on the allowlist: 403 and one security signal', async () => {
    const r = await requireAdmin(req(jwt({ email: 'stranger@example.com', aud: 'aud-123', exp: future() })))
    expect(r.identity).toBeNull(); expect(r.error.status).toBe(403)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).not.toMatch(/stranger|example\.com|eyJ/)       // no identity / token in the signal
  })

  test('routine noise never pushes: no token, garbage token, forged signature, wrong audience, expired', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    for (const t of [undefined, 'not.a.jwt',
      jwt({ email: 'stranger@example.com', aud: 'aud-123', exp: future() }, other),
      jwt({ email: 'stranger@example.com', aud: 'other', exp: future() }),
      jwt({ email: 'stranger@example.com', aud: 'aud-123', exp: 1 })]) {
      const r = await requireAdmin(req(t))
      expect(r.error.status).toBe(401)
    }
    expect(notify).not.toHaveBeenCalled()
  })

  test('a failing push can never change the answer (still 403, no throw)', async () => {
    notify.mockRejectedValue(new Error('push stack exploded'))
    const r = await requireAdmin(req(jwt({ email: 'stranger@example.com', aud: 'aud-123', exp: future() })))
    expect(r.identity).toBeNull(); expect(r.error.status).toBe(403)
  })
})
