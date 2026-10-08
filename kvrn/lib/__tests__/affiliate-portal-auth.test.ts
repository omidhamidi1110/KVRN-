// Affiliate login + session: pure rules, the real service against PostgreSQL, and the real route handlers.
// Substituted: the DB transport (pg instead of Neon HTTP) and the outbound mail provider (captured, never sent).
import { createHash } from 'crypto'
import { NextRequest } from 'next/server'

const mockSent: Array<{ to: string; subject: string; html: string; from: string }> = []
jest.mock('../resend-adapter', () => ({
  ...jest.requireActual('../resend-adapter'),
  getEmailProvider: () => ({ send: async (m: any) => { mockSent.push(m); return { ok: true, providerMessageId: 'msg_test' } } }),
}))
jest.mock('../db', () => ({ sql: (...a: any[]) => (globalThis as any).__affPortalTestSql(...a) }))
jest.mock('../owner-notifications', () => ({ notifySecurityAlert: async () => {}, isResendProviderFault: () => false, recordProviderFailure: async () => {} }))

import {
  AFFILIATE_COOKIE_PATHS, affiliateAuthPepperConfigured, buildClearCookies, buildSessionCookies, clientIp, constantTimeEqual, createAffiliateAuthService,
  decidePortalAccess, evaluateCsrf, evaluateOriginOnly, GENERIC_LOGIN_MESSAGE, isWellFormedToken, newToken, normalizeLoginEmail,
  parseCookies, sessionPredatesStatusChange, sha256Hex,
} from '../affiliate-auth'
import {
  HAVE_DB, ORIGIN, createPortalFx, installDb, loginAs, mkAffiliate, mkReq, seedDocs, sessionReq, setFlags, type PortalFx,
} from './affiliate-portal-fixtures'

// ═════════════════════════════════════════════════════════════════════════════
describe('pure auth rules', () => {
  test('tokens are 256-bit url-safe random values and well-formedness is strict', () => {
    const a = newToken(), b = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(a).not.toBe(b)
    expect(isWellFormedToken(a)).toBe(true)
    for (const bad of ['', 'short', a + 'x', a.slice(0, 42) + '!', null, undefined, 12, {}]) expect(isWellFormedToken(bad as any)).toBe(false)
  })
  test('email normalisation', () => {
    expect(normalizeLoginEmail('  Aff@Example.COM ')).toBe('aff@example.com')
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '<x>@y.com', null, 5, 'a'.repeat(250) + '@x.com']) expect(normalizeLoginEmail(bad as any)).toBeNull()
  })
  test('production affiliate auth fails closed without a >=32-char pepper', () => {
    expect(affiliateAuthPepperConfigured({ NODE_ENV: 'production' })).toBe(false)
    expect(affiliateAuthPepperConfigured({ NODE_ENV: 'production', AFFILIATE_AUTH_PEPPER: 'short' })).toBe(false)
    expect(affiliateAuthPepperConfigured({ NODE_ENV: 'production', AFFILIATE_AUTH_PEPPER: ' '.repeat(32) })).toBe(false)
    expect(affiliateAuthPepperConfigured({ NODE_ENV: 'production', AFFILIATE_AUTH_PEPPER: 'x'.repeat(32) })).toBe(true)
    expect(affiliateAuthPepperConfigured({ NODE_ENV: 'test' })).toBe(true)
  })
  test('constantTimeEqual', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true); expect(constantTimeEqual('abc', 'abd')).toBe(false); expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
  test('first cookie wins; later duplicates cannot override', () => {
    expect(parseCookies('kvrn_aff=good; kvrn_aff=evil; x=1')).toEqual({ kvrn_aff: 'good', x: '1' })
    expect(parseCookies(null)).toEqual({})
  })
  test('client ip prefers Cloudflare, then the first forwarded hop', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1')
    expect(clientIp(new Headers({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }))).toBe('2.2.2.2')
    expect(clientIp(new Headers())).toBe('unknown')
  })

  test('cookie flags: session HttpOnly, CSRF script-readable, SameSite=Lax, Secure in production, set on BOTH paths', () => {
    const c = buildSessionCookies({ sessionToken: 'S', csrfToken: 'C', maxAgeSeconds: 100 }, { secure: true })
    expect(c).toHaveLength(4)
    expect(AFFILIATE_COOKIE_PATHS).toEqual(['/affiliate', '/api/affiliate'])
    for (const path of AFFILIATE_COOKIE_PATHS) {
      const s = c.find(x => x.startsWith('kvrn_aff=') && x.includes(`Path=${path}`))!
      const k = c.find(x => x.startsWith('kvrn_aff_csrf=') && x.includes(`Path=${path}`))!
      expect(s).toMatch(/HttpOnly/); expect(s).toMatch(/Secure/); expect(s).toMatch(/SameSite=Lax/); expect(s).toMatch(/Max-Age=100/)
      expect(k).not.toMatch(/HttpOnly/); expect(k).toMatch(/Secure/); expect(k).toMatch(/SameSite=Lax/)
    }
    for (const x of c) expect(x).not.toMatch(/Domain=/i)          // host-only cookies
    expect(buildSessionCookies({ sessionToken: 'S', csrfToken: 'C', maxAgeSeconds: 1 }, { secure: false }).some(x => /Secure/.test(x))).toBe(false)
    const clear = buildClearCookies({ secure: true })
    expect(clear).toHaveLength(4); for (const x of clear) expect(x).toMatch(/Max-Age=0/)
  })

  const csrfBase = {
    method: 'POST', origin: ORIGIN, secFetchSite: 'same-origin', expectedOrigins: [ORIGIN],
    headerToken: 'tok', cookieToken: 'tok', csrfHash: sha256Hex('tok'),
  }
  test('CSRF: all layers must pass for a state-changing request', () => {
    expect(evaluateCsrf(csrfBase)).toEqual({ ok: true })
    expect(evaluateCsrf({ ...csrfBase, method: 'GET', headerToken: null, cookieToken: null, origin: null, secFetchSite: null })).toEqual({ ok: true })
    expect(evaluateCsrf({ ...csrfBase, secFetchSite: 'cross-site' })).toMatchObject({ ok: false, reason: 'origin' })
    expect(evaluateCsrf({ ...csrfBase, secFetchSite: 'same-site' })).toMatchObject({ ok: false, reason: 'origin' })
    expect(evaluateCsrf({ ...csrfBase, origin: 'https://evil.test' })).toMatchObject({ ok: false, reason: 'origin' })
    expect(evaluateCsrf({ ...csrfBase, origin: null, secFetchSite: null })).toMatchObject({ ok: false, reason: 'origin' })
    expect(evaluateCsrf({ ...csrfBase, headerToken: null })).toMatchObject({ ok: false, reason: 'token' })
    expect(evaluateCsrf({ ...csrfBase, cookieToken: null })).toMatchObject({ ok: false, reason: 'token' })
    expect(evaluateCsrf({ ...csrfBase, headerToken: 'other' })).toMatchObject({ ok: false, reason: 'token' })
    // header == cookie but NOT the token bound to this session (cookie planted by an attacker)
    expect(evaluateCsrf({ ...csrfBase, headerToken: 'x', cookieToken: 'x' })).toMatchObject({ ok: false, reason: 'token' })
  })
  test('origin-only check (unauthenticated verify)', () => {
    const b = { method: 'POST', origin: ORIGIN, secFetchSite: null as string | null, expectedOrigins: [ORIGIN] }
    expect(evaluateOriginOnly(b)).toBe(true)
    expect(evaluateOriginOnly({ ...b, origin: 'https://evil.test' })).toBe(false)
    expect(evaluateOriginOnly({ ...b, origin: null })).toBe(false)
    expect(evaluateOriginOnly({ ...b, secFetchSite: 'cross-site' })).toBe(false)
  })

  test.each([
    ['active', 'enabled', true, false], ['onboarding', 'enabled', true, false], ['active', 'read_only', true, true],
    ['suspended', 'enabled', true, true], ['terminated', 'enabled', true, true],
    ['active', 'revoked', false, true], ['suspended', 'revoked', false, true], ['terminated', 'revoked', false, true],
    [null, 'enabled', false, true], ['active', null, false, true], ['weird', 'enabled', false, true], ['active', 'weird', false, true],
  ])('portal access: status=%s access=%s -> allowed=%s readOnly=%s (fails closed on unknown)', (st, ac, allowed, ro) => {
    expect(decidePortalAccess(st as any, ac as any)).toMatchObject({ allowed, readOnly: ro })
  })
  test('a session issued before a suspension / termination is void', () => {
    const t0 = '2026-01-01T00:00:00Z', t1 = '2026-01-02T00:00:00Z'
    expect(sessionPredatesStatusChange(t0, t1, null)).toBe(true)
    expect(sessionPredatesStatusChange(t0, null, t1)).toBe(true)
    expect(sessionPredatesStatusChange(t1, t0, null)).toBe(false)
    expect(sessionPredatesStatusChange(t0, null, null)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
const d = HAVE_DB ? describe : describe.skip
d('auth service + routes (real PostgreSQL)', () => {
  let fx: PortalFx
  let reqPOST: any, verifyPOST: any, logoutPOST: any, mePOST: any, meGET: any
  beforeAll(async () => {
    fx = await createPortalFx('affp_auth'); installDb(fx.sql); await seedDocs(fx.q)
    reqPOST = (await import('../../app/api/affiliate/auth/request/route')).POST
    verifyPOST = (await import('../../app/api/affiliate/auth/verify/route')).POST
    logoutPOST = (await import('../../app/api/affiliate/auth/logout/route')).POST
    meGET = (await import('../../app/api/affiliate/me/route')).GET
    mePOST = (await import('../../app/api/affiliate/me/route') as any).POST
  }, 120000)
  afterAll(async () => { await fx?.close() })
  beforeEach(() => { setFlags({ portal: true }); mockSent.length = 0; process.env.SITE_URL = ORIGIN; jest.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { jest.restoreAllMocks(); setFlags({ portal: false }) })

  const bodyOf = async (r: Response) => ({ status: r.status, body: await r.json() })

  test('a link is created only for an eligible affiliate; only a HASH of the token is stored; the link uses the URL fragment', async () => {
    const a = await mkAffiliate(fx.q, { email: 'eligible@portal.test' })
    const svc = createAffiliateAuthService(fx.sql, { siteOrigin: () => ORIGIN, sendLoginEmail: async m => { mockSent.push({ to: m.to, subject: '', html: m.link, from: '' }); return true } })
    expect((await svc.requestLogin({ email: 'Eligible@Portal.test', ip: '198.51.100.1' })).status).toBe('sent')
    const link = mockSent[0].html
    expect(link).toMatch(/^https:\/\/kvrn\.shop\/affiliate\/login\/verify#t=[A-Za-z0-9_-]{43}$/)
    expect(link).not.toContain('?')
    const token = link.split('#t=')[1]
    const rows = await fx.q(`SELECT token_hash, email_hash, ip_hash FROM affiliate_login_tokens WHERE affiliate_id=$1`, [a.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    // The raw token / email / ip appear nowhere in the database.
    const dump = JSON.stringify(await fx.q(`SELECT * FROM affiliate_login_tokens UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL WHERE FALSE`).catch(() => []))
    expect(dump).not.toContain(token); expect(dump).not.toContain('eligible@portal.test'); expect(dump).not.toContain('198.51.100.1')
    // Unknown / malformed / revoked → 'ignored' (no row, no mail).
    const before = mockSent.length
    expect((await svc.requestLogin({ email: 'nobody@portal.test', ip: '198.51.100.2' })).status).toBe('ignored')
    expect((await svc.requestLogin({ email: 'not-an-email', ip: '198.51.100.3' })).status).toBe('ignored')
    expect((await svc.requestLogin({ email: 12345, ip: '198.51.100.4' })).status).toBe('ignored')
    await fx.q(`UPDATE affiliate_profiles SET portal_access='revoked' WHERE affiliate_id=$1`, [a.id])
    expect((await svc.requestLogin({ email: 'eligible@portal.test', ip: '198.51.100.5' })).status).toBe('ignored')
    expect(mockSent.length).toBe(before)
  })

  test('link expiry, single use, and malformed tokens', async () => {
    const a = await mkAffiliate(fx.q)
    let now = new Date()
    let link = ''
    const svc = createAffiliateAuthService(fx.sql, { now: () => now, siteOrigin: () => ORIGIN, sendLoginEmail: async m => { link = m.link; return true } })
    await svc.requestLogin({ email: a.email!, ip: '10.0.0.1' })
    const token = link.split('#t=')[1]
    // single use
    const first = await svc.redeemLoginToken({ token, ip: '10.0.0.1' })
    expect(first.ok).toBe(true)
    expect(await svc.redeemLoginToken({ token, ip: '10.0.0.1' })).toEqual({ ok: false, reason: 'invalid' })
    // expiry (15 minutes)
    await svc.requestLogin({ email: a.email!, ip: '10.0.0.2' })
    const t2 = link.split('#t=')[1]
    // Expiry is enforced by the database clock: age the row (created_at moves too, so the row stays internally consistent).
    await fx.q(`UPDATE affiliate_login_tokens SET created_at = NOW() - INTERVAL '16 minutes', expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash=$1`, [sha256Hex(t2)])
    expect(await svc.redeemLoginToken({ token: t2, ip: '10.0.0.2' })).toEqual({ ok: false, reason: 'invalid' })
    // A token one second before expiry still works.
    await svc.requestLogin({ email: a.email!, ip: '10.0.0.4' })
    const t3 = link.split('#t=')[1]
    await fx.q(`UPDATE affiliate_login_tokens SET created_at = NOW() - INTERVAL '14 minutes', expires_at = NOW() + INTERVAL '1 minute' WHERE token_hash=$1`, [sha256Hex(t3)])
    expect((await svc.redeemLoginToken({ token: t3, ip: '10.0.0.4' })).ok).toBe(true)
    now = new Date()
    for (const bad of ['', 'x', newToken(), null, undefined, 42]) expect(await svc.redeemLoginToken({ token: bad, ip: '10.0.0.3' })).toEqual({ ok: false, reason: 'invalid' })
  })

  test('concurrent redemption of one token opens exactly one session', async () => {
    const a = await mkAffiliate(fx.q)
    let link = ''
    const svc = createAffiliateAuthService(fx.sql, { siteOrigin: () => ORIGIN, sendLoginEmail: async m => { link = m.link; return true } })
    await svc.requestLogin({ email: a.email!, ip: '10.0.1.1' })
    const token = link.split('#t=')[1]
    const results = await Promise.all([1, 2, 3].map(() => svc.redeemLoginToken({ token, ip: '10.0.1.1' })))
    expect(results.filter(r => r.ok)).toHaveLength(1)
  })

  test('rate limits: per email, per ip, and verify attempts; limited identically for unknown emails', async () => {
    const a = await mkAffiliate(fx.q)
    const svc = createAffiliateAuthService(fx.sql, { siteOrigin: () => ORIGIN, sendLoginEmail: async () => true })
    const real = [] as string[], fake = [] as string[]
    for (let i = 0; i < 5; i++) real.push((await svc.requestLogin({ email: a.email!, ip: `10.1.0.${i}` })).status)
    for (let i = 0; i < 5; i++) fake.push((await svc.requestLogin({ email: 'ghost-account@portal.test', ip: `10.2.0.${i}` })).status)
    expect(real.indexOf('rate_limited')).toBe(3)                 // 3 per email per window
    expect(fake.indexOf('rate_limited')).toBe(3)                 // identical shape for an address that does not exist
    const ipHits: string[] = []
    for (let i = 0; i < 12; i++) ipHits.push((await svc.requestLogin({ email: `u${i}@portal.test`, ip: '10.3.0.1' })).status)
    expect(ipHits.indexOf('rate_limited')).toBe(10)              // 10 per ip per window
    const v: string[] = []
    for (let i = 0; i < 22; i++) v.push(((await svc.redeemLoginToken({ token: newToken(), ip: '10.4.0.1' })) as any).reason)
    expect(v.indexOf('rate_limited')).toBe(20)
  })

  test('session lifecycle: valid, sliding idle expiry, absolute expiry, logout, revoke-all', async () => {
    const a = await mkAffiliate(fx.q)
    const s = await loginAs(fx.sql, a.email!, '10.5.0.1')
    const svc = createAffiliateAuthService(fx.sql)
    const ctx = await svc.validateSession(s.sessionToken)
    expect(ctx).toMatchObject({ affiliateId: a.id, readOnly: false, programStatus: 'active', code: a.code })
    // only hashes in the DB
    const row = (await fx.q(`SELECT session_hash, csrf_hash FROM affiliate_sessions WHERE affiliate_id=$1`, [a.id]))[0]
    expect(row.session_hash).toBe(sha256Hex(s.sessionToken)); expect(row.csrf_hash).toBe(sha256Hex(s.csrfToken))
    expect(JSON.stringify(await fx.q(`SELECT * FROM affiliate_sessions`))).not.toContain(s.sessionToken)

    expect(await svc.validateSession('nope')).toBeNull()
    expect(await svc.validateSession(newToken())).toBeNull()
    expect(await svc.validateSession(undefined)).toBeNull()

    await fx.q(`UPDATE affiliate_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE session_hash=$1`, [sha256Hex(s.sessionToken)])
    expect(await svc.validateSession(s.sessionToken)).toBeNull()                     // idle expiry
    const s2 = await loginAs(fx.sql, a.email!, '10.5.0.2')
    await fx.q(`UPDATE affiliate_sessions SET created_at = NOW() - INTERVAL '31 days', last_seen_at = NOW() - INTERVAL '31 days', absolute_expires_at = NOW() - INTERVAL '1 second' WHERE session_hash=$1`, [sha256Hex(s2.sessionToken)])
    expect(await svc.validateSession(s2.sessionToken)).toBeNull()                    // absolute expiry
    const s3 = await loginAs(fx.sql, a.email!, '10.5.0.3')
    const c3 = (await svc.validateSession(s3.sessionToken))!
    await svc.logout(c3.sessionId, a.id)
    expect(await svc.validateSession(s3.sessionToken)).toBeNull()
    const s4 = await loginAs(fx.sql, a.email!, '10.5.0.4'), s5 = await loginAs(fx.sql, a.email!, '10.5.0.5')
    expect(await svc.revokeAllSessions(a.id, 'test', 'admin@kvrn.test')).toBe(2)
    expect(await svc.validateSession(s4.sessionToken)).toBeNull(); expect(await svc.validateSession(s5.sessionToken)).toBeNull()
  })

  test('session is one affiliate only: a session never resolves to another affiliate', async () => {
    const a = await mkAffiliate(fx.q), b = await mkAffiliate(fx.q)
    const sa = await loginAs(fx.sql, a.email!, '10.6.0.1'), sb = await loginAs(fx.sql, b.email!, '10.6.0.2')
    const svc = createAffiliateAuthService(fx.sql)
    expect((await svc.validateSession(sa.sessionToken))!.affiliateId).toBe(a.id)
    expect((await svc.validateSession(sb.sessionToken))!.affiliateId).toBe(b.id)
  })

  test('suspension / termination: still opens, but READ-ONLY; sessions older than the change are void; revoked access blocks entirely', async () => {
    const svc = createAffiliateAuthService(fx.sql)
    // suspended: a NEW login works read-only
    const a = await mkAffiliate(fx.q, { profile: { program_status: 'suspended' } })
    await fx.q(`UPDATE affiliate_profiles SET suspended_at = NOW() - INTERVAL '1 hour' WHERE affiliate_id=$1`, [a.id])
    const sa = await loginAs(fx.sql, a.email!, '10.7.0.1')
    expect(await svc.validateSession(sa.sessionToken)).toMatchObject({ readOnly: true, accessReason: 'suspended' })
    // terminated: read-only
    const t = await mkAffiliate(fx.q, { profile: { program_status: 'terminated' } })
    await fx.q(`UPDATE affiliate_profiles SET terminated_at = NOW() - INTERVAL '1 hour' WHERE affiliate_id=$1`, [t.id])
    const st = await loginAs(fx.sql, t.email!, '10.7.0.2')
    expect(await svc.validateSession(st.sessionToken)).toMatchObject({ readOnly: true, accessReason: 'terminated' })
    // a live session that predates a suspension is closed even if nobody called revoke
    const b = await mkAffiliate(fx.q)
    const sb = await loginAs(fx.sql, b.email!, '10.7.0.3')
    expect(await svc.validateSession(sb.sessionToken)).not.toBeNull()
    await fx.q(`UPDATE affiliate_profiles SET program_status='suspended', suspended_at = NOW() + INTERVAL '1 second' WHERE affiliate_id=$1`, [b.id])
    expect(await svc.validateSession(sb.sessionToken)).toBeNull()
    expect((await fx.q(`SELECT revoked_at FROM affiliate_sessions WHERE session_hash=$1`, [sha256Hex(sb.sessionToken)]))[0].revoked_at).not.toBeNull()
    // access revoked: existing session dies immediately and a new link is not issued
    const c = await mkAffiliate(fx.q)
    const sc = await loginAs(fx.sql, c.email!, '10.7.0.4')
    await fx.q(`SELECT set_affiliate_portal_access($1,'revoked','fraud review','admin@kvrn.test')`, [c.id])
    expect(await svc.validateSession(sc.sessionToken)).toBeNull()
    expect((await svc.requestLogin({ email: c.email!, ip: '10.7.0.5' })).status).toBe('ignored')
    // no profile at all fails closed
    const d2 = await mkAffiliate(fx.q, { profile: null })
    await fx.q(`INSERT INTO affiliate_sessions (session_hash,csrf_hash,affiliate_id,expires_at,absolute_expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',NOW()+INTERVAL '1 day')`, [sha256Hex('x'.repeat(43)), sha256Hex('y'), d2.id])
    expect(await svc.validateSession('x'.repeat(43))).toBeNull()
  })

  test('cleanup removes only dead rows', async () => {
    const svc = createAffiliateAuthService(fx.sql)
    const a = await mkAffiliate(fx.q)
    const live = await loginAs(fx.sql, a.email!, '10.8.0.1')
    await fx.q(`INSERT INTO affiliate_login_tokens (token_hash,affiliate_id,email_hash,ip_hash,created_at,expires_at) VALUES ($1,$2,'e','i',NOW() - INTERVAL '4 days',NOW() - INTERVAL '3 days')`, [sha256Hex('dead'), a.id])
    const r = await svc.cleanup()
    expect(r.tokens).toBeGreaterThanOrEqual(1)
    expect(await svc.validateSession(live.sessionToken)).not.toBeNull()
  })

  // ── routes ─────────────────────────────────────────────────────────────────
  test('flag OFF: request, verify and me all answer 404 and touch nothing', async () => {
    setFlags({ portal: false })
    const a = await mkAffiliate(fx.q)
    const s = await loginAs(fx.sql, a.email!, '10.9.0.1').catch(() => null)   // login service itself is flag-agnostic
    const before = (await fx.q(`SELECT COUNT(*)::int n FROM affiliate_login_tokens`))[0].n
    expect((await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email } }))).status).toBe(404)
    expect((await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token: newToken() } }))).status).toBe(404)
    expect((await meGET(sessionReq('/api/affiliate/me', s!))).status).toBe(404)         // even with a VALID session
    expect((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_login_tokens`))[0].n).toBe(before)
    expect(mockSent).toHaveLength(0)
  })

  test('NO ENUMERATION: known, unknown, malformed and revoked addresses get the same status, body and headers', async () => {
    const known = await mkAffiliate(fx.q, { email: 'enum-known@portal.test' })
    const revoked = await mkAffiliate(fx.q, { email: 'enum-revoked@portal.test', profile: { portal_access: 'revoked' } })
    const call = async (email: unknown, n: number) => reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email }, headers: { 'cf-connecting-ip': `10.20.0.${n}` } }))
    const outs = []
    let n = 1
    for (const e of [known.email, 'enum-unknown@portal.test', 'garbage', revoked.email, '', null]) {
      const r = await call(e, n++); outs.push({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control'), setCookie: r.headers.get('set-cookie') })
    }
    for (const o of outs) { expect(o.status).toBe(200); expect(o.body).toEqual({ ok: true, message: GENERIC_LOGIN_MESSAGE }); expect(o.cache).toBe('no-store'); expect(o.setCookie).toBeNull() }
    // exactly one mail went out, to the known + eligible address only
    expect(mockSent).toHaveLength(1); expect(mockSent[0].to).toBe('enum-known@portal.test')
    // a body that is not JSON at all is also generic
    const bad = await reqPOST(new NextRequest(`${ORIGIN}/api/affiliate/auth/request`, { method: 'POST', body: 'not json', headers: { origin: ORIGIN, 'cf-connecting-ip': '10.20.9.9' } }))
    expect(await bad.json()).toEqual({ ok: true, message: GENERIC_LOGIN_MESSAGE })
  }, 30000)

  test('the request route pads its response time so a hit is not faster/slower than a miss', async () => {
    const a = await mkAffiliate(fx.q)
    const time = async (email: string, n: number) => { const t = Date.now(); await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email }, headers: { 'cf-connecting-ip': `10.21.0.${n}` } })); return Date.now() - t }
    expect(await time(a.email!, 1)).toBeGreaterThanOrEqual(600)
    expect(await time('missing@portal.test', 2)).toBeGreaterThanOrEqual(600)
  })

  test('the emailed message carries a fragment link, never logs it, and has no other secrets', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {}); const err = console.error as jest.Mock
    const a = await mkAffiliate(fx.q)
    await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, headers: { 'cf-connecting-ip': '10.22.0.1' } }))
    expect(mockSent).toHaveLength(1)
    const html = mockSent[0].html
    const href = /href="([^"]+)"/.exec(html)![1]
    expect(href).toMatch(/^https:\/\/kvrn\.shop\/affiliate\/login\/verify#t=[A-Za-z0-9_-]{43}$/)
    const tok = href.split('#t=')[1]
    for (const spy of [log, err]) expect(JSON.stringify(spy.mock.calls)).not.toContain(tok)
    expect(mockSent[0].from).toMatch(/KVRN/)
  })

  test('request route: cross-site POST is refused; the 4th request for one email is limited (429) with no mail', async () => {
    const a = await mkAffiliate(fx.q)
    expect((await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, origin: 'https://evil.test' }))).status).toBe(403)
    expect((await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, origin: null }))).status).toBe(403)
    expect((await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, secFetchSite: 'cross-site' }))).status).toBe(403)
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, headers: { 'cf-connecting-ip': `10.23.0.${i}` } }))).status)
    expect(codes).toEqual([200, 200, 200, 429])
  })

  test('verify route: sets HttpOnly session + readable CSRF cookies on both paths; failures are identical; cross-site refused', async () => {
    const a = await mkAffiliate(fx.q)
    await reqPOST(mkReq('/api/affiliate/auth/request', { method: 'POST', body: { email: a.email }, headers: { 'cf-connecting-ip': '10.24.0.1' } }))
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(mockSent[mockSent.length - 1].html)![1]
    const cross = await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token }, origin: 'https://evil.test' }))
    expect(cross.status).toBe(403)
    const ok = await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token }, headers: { 'cf-connecting-ip': '10.24.0.2' } }))
    expect(ok.status).toBe(200)
    const cookies = ok.headers.getSetCookie()
    expect(cookies).toHaveLength(4)
    expect(cookies.filter((c: string) => c.startsWith('kvrn_aff=') && /HttpOnly/.test(c))).toHaveLength(2)
    expect(cookies.filter((c: string) => c.startsWith('kvrn_aff_csrf=') && !/HttpOnly/.test(c))).toHaveLength(2)
    expect(cookies.every((c: string) => /SameSite=Lax/.test(c))).toBe(true)
    expect(cookies.some((c: string) => /Path=\/affiliate(;|$)/.test(c))).toBe(true); expect(cookies.some((c: string) => /Path=\/api\/affiliate(;|$)/.test(c))).toBe(true)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    const again = await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token }, headers: { 'cf-connecting-ip': '10.24.0.3' } }))
    const junk = await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token: 'junk' }, headers: { 'cf-connecting-ip': '10.24.0.4' } }))
    expect(again.status).toBe(400); expect(junk.status).toBe(400)
    expect(await again.json()).toEqual(await junk.json())
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  test('production cookies are Secure', async () => {
    const prev = process.env.NODE_ENV; (process.env as any).NODE_ENV = 'production'
    try {
      const a = await mkAffiliate(fx.q)
      const svc = createAffiliateAuthService(fx.sql, { siteOrigin: () => ORIGIN, sendLoginEmail: async m => { mockSent.push({ to: '', subject: '', from: '', html: m.link }); return true } })
      await svc.requestLogin({ email: a.email!, ip: '10.25.0.1' })
      const token = mockSent[mockSent.length - 1].html.split('#t=')[1]
      const ok = await verifyPOST(mkReq('/api/affiliate/auth/verify', { method: 'POST', body: { token }, headers: { 'cf-connecting-ip': '10.25.0.2' } }))
      expect(ok.headers.getSetCookie().every((c: string) => /; Secure/.test(c))).toBe(true)
    } finally { (process.env as any).NODE_ENV = prev }
  })

  test('requireAffiliate: no cookie 401; CSRF layers on POST; read-only accounts cannot write; logout works for them', async () => {
    const a = await mkAffiliate(fx.q)
    const s = await loginAs(fx.sql, a.email!, '10.26.0.1')
    expect((await meGET(mkReq('/api/affiliate/me'))).status).toBe(401)
    expect((await meGET(sessionReq('/api/affiliate/me', s))).status).toBe(200)
    const patch = (await import('../../app/api/affiliate/profile/route')).PATCH
    const body = { displayName: 'New Name' }
    const send = (o: any) => patch(mkReq('/api/affiliate/profile', { method: 'PATCH', session: s.sessionToken, body, ...o }))
    expect((await send({ csrf: s.csrfToken })).status).toBe(200)
    expect((await send({ csrf: null })).status).toBe(403)                                   // no token
    expect((await send({ csrf: 'wrong', csrfCookie: 'wrong' })).status).toBe(403)           // header==cookie but not bound to the session
    expect((await send({ csrf: s.csrfToken, csrfCookie: 'other' })).status).toBe(403)       // header != cookie
    expect((await send({ csrf: s.csrfToken, origin: 'https://evil.test' })).status).toBe(403)
    expect((await send({ csrf: s.csrfToken, origin: null })).status).toBe(403)
    expect((await send({ csrf: s.csrfToken, secFetchSite: 'cross-site' })).status).toBe(403)
    // read-only
    await fx.q(`UPDATE affiliate_profiles SET portal_access='read_only' WHERE affiliate_id=$1`, [a.id])
    const ro = await send({ csrf: s.csrfToken })
    expect(ro.status).toBe(403); expect((await ro.json()).code).toBe('read_only')
    expect((await meGET(sessionReq('/api/affiliate/me', s))).status).toBe(200)               // reads still work
    const lo = await logoutPOST(mkReq('/api/affiliate/auth/logout', { method: 'POST', session: s.sessionToken, csrf: s.csrfToken, body: {} }))
    expect(lo.status).toBe(200); expect(lo.headers.getSetCookie().every((c: string) => /Max-Age=0/.test(c))).toBe(true)
    expect((await meGET(sessionReq('/api/affiliate/me', s))).status).toBe(401)
  })

  test('an invalid session clears the cookies it was sent with', async () => {
    const r = await meGET(mkReq('/api/affiliate/me', { session: newToken() }))
    expect(r.status).toBe(401); expect(r.headers.getSetCookie().length).toBe(4)
  })

  test('AFFILIATE ≠ ADMIN in both directions', async () => {
    const { requireAdmin } = await import('../admin-auth')
    const a = await mkAffiliate(fx.q)
    const s = await loginAs(fx.sql, a.email!, '10.27.0.1')
    // an affiliate session cookie (and CSRF) does not satisfy requireAdmin
    const adminReq = new NextRequest(`${ORIGIN}/api/admin/affiliates`, { headers: { cookie: `kvrn_aff=${s.sessionToken}; kvrn_aff_csrf=${s.csrfToken}` } })
    const r = await requireAdmin(adminReq)
    expect(r.error).not.toBeNull(); expect((r.error as Response).status).toBe(401)
    // admin identity headers do not satisfy requireAffiliate
    const asAdmin = new NextRequest(`${ORIGIN}/api/affiliate/me`, { headers: { 'cf-access-jwt-assertion': 'a.b.c', 'x-dev-admin-email': 'admin@kvrn.test' } })
    expect((await meGET(asAdmin)).status).toBe(401)
    // and the affiliate sessions table is the only thing that grants portal access
    expect((await meGET(mkReq('/api/affiliate/me', { session: sha256Hex('forged') }))).status).toBe(401)
  })
})
