// Route-level tests for the affiliate program: REAL route handlers against REAL PostgreSQL (throwaway
// database, all migrations applied). Substituted: the database transport, admin identity and the email
// provider (no network). Requires TEST_DATABASE_URL pointing at a LOCAL server.
import fs from 'fs'
import path from 'path'
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'

const g = globalThis as any
jest.mock('../db', () => ({ get sql() { return (globalThis as any).__affSql } }))
jest.mock('../admin-auth', () => ({
  requireAdmin: async () => {
    if ((globalThis as any).__affDeny) {
      const { NextResponse } = require('next/server')
      return { identity: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }
    return { identity: { email: 'admin@kvrn.test' }, error: null }
  },
}))
const sent: any[] = []
jest.mock('../resend-adapter', () => ({
  getEmailProvider: () => ({ send: async (m: any) => { (globalThis as any).__affSent.push(m); return { ok: true, providerMessageId: 'msg_' + (globalThis as any).__affSent.length } } }),
}))
g.__affSent = sent

import { issueFormToken } from '../affiliate-application'
import { createAffiliateProgramAdmin } from '../affiliate-program-admin'

const d = HAVE_DB ? describe : describe.skip
const ROOT = path.resolve(__dirname, '../..')
const ACTOR = 'admin@kvrn.test'

function req(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const r: any = new Request(`https://kvrn.test${url}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  })
  r.nextUrl = new URL(`https://kvrn.test${url}`)
  return r
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

d('affiliate program HTTP', () => {
  let fi: FiDb
  let admin: ReturnType<typeof createAffiliateProgramAdmin>
  let n = 0
  const one = async (t: string, p?: unknown[]) => (await fi.q(t, p))[0]
  const count = async (table: string) => (await one(`SELECT count(*)::int AS n FROM ${table}`)).n
  const setFlag = (on: boolean) => { if (on) process.env.KVRN_FLAG_AFFILIATE_APPLICATIONS = 'true'; else delete process.env.KVRN_FLAG_AFFILIATE_APPLICATIONS }

  let apply: any, invitePOST: any, appsGET: any, appGET: any, appPOST: any, invitesPOST: any, invitesGET: any
  let profilesGET: any, profilePOST: any, docsGET: any, docsPOST: any, settingsGET: any, settingsPUT: any
  let emailsGET: any, emailsPOST: any, auditGET: any, mainPOST: any, mainGET: any, maintPOST: any

  async function publishAllReal() {
    for (const t of ['program_terms', 'disclosure_policy', 'privacy_notice']) {
      const s = await admin.saveDocumentDraft({ docType: t, title: `Final ${t}`, body: `# ${t}\n\nFinal reviewed wording used only by the test suite, long enough to publish.`, changeSummary: null }, ACTOR)
      await admin.publishDocument(s.document_id, false, ACTOR)
    }
  }
  async function body(over: Record<string, unknown> = {}) {
    const docs = await one(`SELECT (SELECT version FROM affiliate_documents WHERE doc_type='program_terms' AND published_at IS NOT NULL ORDER BY version_no DESC LIMIT 1) AS t,
      (SELECT version FROM affiliate_documents WHERE doc_type='disclosure_policy' AND published_at IS NOT NULL ORDER BY version_no DESC LIMIT 1) AS d,
      (SELECT version FROM affiliate_documents WHERE doc_type='privacy_notice' AND published_at IS NOT NULL ORDER BY version_no DESC LIMIT 1) AS p`)
    n++
    return {
      applicantName: 'Grace Hopper', email: `grace${n}@example.com`, country: 'US', stateRegion: 'NY',
      socialUrls: [`https://instagram.com/grace_${n}`], motivation: 'I make videos about fashion and love the brand.',
      promotionPlan: 'Weekly short videos and a link in my bio.', ageAttested: true, termsAccepted: true, disclosureAccepted: true,
      privacyAccepted: true, accuracyConfirmed: true, esignConsent: true, termsVersion: docs.t, disclosureVersion: docs.d, privacyVersion: docs.p,
      idempotencyKey: `k-${n}-${Math.random().toString(36).slice(2, 12)}`, formToken: await issueFormToken(Date.now() - 60_000), company_fax: '', ...over,
    } as Record<string, any>
  }
  const post = async (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const b = await body(over)
    return { b, res: await apply(req('/api/affiliates/apply', { body: b, headers: { 'cf-connecting-ip': `198.51.100.${(n % 200) + 1}`, ...headers } })) }
  }

  beforeAll(async () => {
    fi = await createFiDb('affhttp')
    g.__affSql = fi.sql
    admin = createAffiliateProgramAdmin(fi.sql)
    apply = (await import('../../app/api/affiliates/apply/route')).POST
    invitePOST = (await import('../../app/api/affiliates/invite/route')).POST
    appsGET = (await import('../../app/api/admin/affiliates/applications/route')).GET
    const ar = await import('../../app/api/admin/affiliates/applications/[id]/route'); appGET = ar.GET; appPOST = ar.POST
    const ir = await import('../../app/api/admin/affiliates/invites/route'); invitesGET = ir.GET; invitesPOST = ir.POST
    profilesGET = (await import('../../app/api/admin/affiliates/profiles/route')).GET
    profilePOST = (await import('../../app/api/admin/affiliates/profiles/[id]/route')).POST
    const dr = await import('../../app/api/admin/affiliates/documents/route'); docsGET = dr.GET; docsPOST = dr.POST
    const sr = await import('../../app/api/admin/affiliates/settings/route'); settingsGET = sr.GET; settingsPUT = sr.PUT
    const er = await import('../../app/api/admin/affiliates/emails/route'); emailsGET = er.GET; emailsPOST = er.POST
    auditGET = (await import('../../app/api/admin/affiliates/audit/route')).GET
    const mr = await import('../../app/api/admin/affiliates/route'); mainPOST = mr.POST; mainGET = mr.GET
    maintPOST = (await import('../../app/api/internal/affiliate-program-maintenance/route')).POST
  }, 120_000)
  afterAll(async () => { setFlag(false); if (fi) await fi.close() }, 60_000)
  beforeEach(() => { setFlag(false); g.__affDeny = false; sent.length = 0 })

  describe('POST /api/affiliates/apply', () => {
    test('flag ON but documents are still placeholders: closed (503) with a generic message and nothing stored', async () => {
      setFlag(true)
      const before = await count('affiliate_applications')
      const { res } = await post()
      expect(res.status).toBe(503)
      expect(JSON.stringify(await res.json())).not.toMatch(/placeholder|attorney|legal|flag/i)
      expect(await count('affiliate_applications')).toBe(before)
      expect(sent).toHaveLength(0)
    })

    test('flag OFF: 404, no rows, no rate-limit events, no email', async () => {
      await publishAllReal()
      const before = [await count('affiliate_applications'), await count('affiliate_rate_limit_events'), await count('affiliate_email_outbox')]
      const { res } = await post()
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect([await count('affiliate_applications'), await count('affiliate_rate_limit_events'), await count('affiliate_email_outbox')]).toEqual(before)
      expect(sent).toHaveLength(0)
    })

    test('flag ON: stores a pending application and emails a confirmation; no secrets or reasons leak', async () => {
      setFlag(true)
      const { b, res } = await post()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const row = await one(`SELECT status FROM affiliate_applications WHERE email_normalized = $1`, [b.email])
      expect(row.status).toBe('pending')
      expect(sent.map(m => m.to)).toContain(b.email)
      expect(sent.find(m => m.to === b.email).subject).toMatch(/received/i)
      expect(await count('affiliates')).toBe(0)
    })

    test('new, repeated and existing-affiliate submissions look identical to the applicant', async () => {
      setFlag(true)
      const first = await post()
      const repeat = await apply(req('/api/affiliates/apply', { body: { ...first.b, formToken: await issueFormToken(Date.now() - 60_000) }, headers: { 'cf-connecting-ip': '203.0.113.5' } }))
      const app = (await one(`SELECT id FROM affiliate_applications WHERE email_normalized = $1`, [first.b.email])).id
      await admin.approve(app, { code: 'SAMEBODY', commissionType: 'percentage', commissionRateBps: 1000, fixedReversalPolicy: 'proportional', attributionWindowDays: 30, commissionHoldDays: 30, paidAdsPolicy: 'not_permitted' }, ACTOR)
      const existing = await post({ email: first.b.email, idempotencyKey: 'another-key-98765' })
      expect([first.res.status, repeat.status, existing.res.status]).toEqual([200, 200, 200])
      expect(await existing.res.json()).toEqual({ ok: true })
      expect(await count('affiliates')).toBe(1)
    })

    test('validation errors return field messages and store nothing', async () => {
      setFlag(true)
      const { b, res } = await post({ ageAttested: false, termsAccepted: false })
      expect(res.status).toBe(400)
      const j = await res.json()
      expect(Object.keys(j.fields).sort()).toEqual(['ageAttested', 'termsAccepted'])
      expect(await one(`SELECT 1 FROM affiliate_applications WHERE email_normalized = $1`, [b.email])).toBeUndefined()
    })

    test('honeypot gets a success-looking response and stores nothing', async () => {
      setFlag(true)
      const { b, res } = await post({ company_fax: 'x' })
      expect(res.status).toBe(200)
      expect(await one(`SELECT 1 FROM affiliate_applications WHERE email_normalized = $1`, [b.email])).toBeUndefined()
    })

    test('oversize and malformed bodies are rejected before any work', async () => {
      setFlag(true)
      const big = await apply(req('/api/affiliates/apply', { body: JSON.stringify({ x: 'a'.repeat(40_000) }) }))
      expect(big.status).toBe(413)
      const bad = await apply(req('/api/affiliates/apply', { body: '{nope' }))
      expect(bad.status).toBe(400)
      const arr = await apply(req('/api/affiliates/apply', { body: '[1,2]' }))
      expect(arr.status).toBe(400)
    })

    test('forged or too-fast form tokens are refused with a retry message', async () => {
      setFlag(true)
      const fast = await post({ formToken: await issueFormToken(Date.now()) })
      expect(fast.res.status).toBe(409)
      const forged = await post({ formToken: '1800000000000.' + 'a'.repeat(64) })
      expect(forged.res.status).toBe(409)
    })

    test('rate limit returns 429 with Retry-After and does not create a row', async () => {
      setFlag(true)
      const cur = await admin.counts(); void cur
      await fi.q(`INSERT INTO site_settings (key, value, revision, updated_by) VALUES ('affiliate.program', '{"rateLimits":{"perIpPerHour":1,"perIpPerDay":50,"perEmailPerDay":50,"globalPerHour":1000}}'::jsonb, 1, 'test')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      const h = { 'cf-connecting-ip': '192.0.2.77' }
      const a = await post({}, h), b2 = await post({}, h)
      expect(a.res.status).toBe(200)
      expect(b2.res.status).toBe(429)
      expect(b2.res.headers.get('retry-after')).toBeTruthy()
      expect(await one(`SELECT 1 FROM affiliate_applications WHERE email_normalized = $1`, [b2.b.email])).toBeUndefined()
      await fi.q(`DELETE FROM site_settings WHERE key = 'affiliate.program'`)
    })

    test('no eligible countries configured: closed with a generic message (no internal reasons)', async () => {
      setFlag(true)
      await fi.q(`INSERT INTO site_settings (key, value, revision, updated_by) VALUES ('affiliate.program', '{"countries":[]}'::jsonb, 1, 'test') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      const { res } = await post()
      expect(res.status).toBe(503)
      const j = await res.json()
      expect(JSON.stringify(j)).not.toMatch(/placeholder|countries|flag/i)
      await fi.q(`DELETE FROM site_settings WHERE key = 'affiliate.program'`)
    })
  })

  describe('POST /api/affiliates/invite', () => {
    test('flag OFF -> 404; unknown token -> 404; valid token -> only the invitee name and email', async () => {
      const c = await admin.createInvite({ email: 'invitee@example.com', displayName: 'Invitee', socialLinks: [], proposedCode: 'SECRETCODE', commissionType: 'percentage', commissionRateBps: 2500 }, 14, ACTOR)
      const call = (t: string) => invitePOST(req('/api/affiliates/invite', { method: 'POST', body: { token: t } }))
      expect((await call(c.token)).status).toBe(404)
      setFlag(true)
      expect((await call('0'.repeat(64))).status).toBe(404)
      expect((await call('short')).status).toBe(404)
      const ok = await call(c.token)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('cache-control')).toBe('no-store')
      const j = await ok.json()
      expect(j).toEqual({ invite: { email: 'invitee@example.com', displayName: 'Invitee' } })
      expect(JSON.stringify(j)).not.toMatch(/SECRETCODE|2500/)
    })
  })

  describe('Admin routes require an admin and never run unauthenticated', () => {
    test('every handler returns 401 before touching data', async () => {
      g.__affDeny = true
      const before = [await count('affiliate_applications'), await count('admin_audit_logs'), await count('affiliate_documents')]
      const uuid = '00000000-0000-4000-8000-000000000001'
      const calls = [
        appsGET(req('/api/admin/affiliates/applications')), appGET(req(`/x`), params(uuid)), appPOST(req('/x', { body: { action: 'reject' } }), params(uuid)),
        invitesGET(req('/x')), invitesPOST(req('/x', { body: { action: 'create' } })), profilesGET(req('/x')), profilePOST(req('/x', { body: { action: 'suspend' } }), params(uuid)),
        docsGET(req('/x')), docsPOST(req('/x', { body: { action: 'publish' } })), settingsGET(req('/x')), settingsPUT(req('/x', { method: 'PUT', body: {} })),
        emailsGET(req('/x')), emailsPOST(req('/x', { body: {} })), auditGET(req('/x')), mainPOST(req('/x', { body: { kind: 'status' } })), mainGET(req('/x')),
      ]
      for (const r of await Promise.all(calls)) expect(r.status).toBe(401)
      expect([await count('affiliate_applications'), await count('admin_audit_logs'), await count('affiliate_documents')]).toEqual(before)
    })

    test('source guard: every new admin route calls requireAdmin first in every exported handler', () => {
      const dir = path.join(ROOT, 'app/api/admin/affiliates')
      const files: string[] = []
      const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : /route\.ts$/.test(e.name) && files.push(path.join(p, e.name)) }
      walk(dir)
      expect(files.length).toBeGreaterThanOrEqual(12)
      for (const f of files) {
        const src = fs.readFileSync(f, 'utf8')
        for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)) {
          const body = src.slice(m.index!, m.index! + 1500)
          expect(body).toMatch(/requireAdmin\(/)
          expect(src.indexOf('requireAdmin(', m.index!)).toBeLessThan(src.indexOf('sql`', m.index!) === -1 ? Infinity : src.indexOf('sql`', m.index!))
        }
        expect(src).toContain("export const dynamic = 'force-dynamic'")
      }
    })
  })

  describe('admin flows through the real routes', () => {
    let appId = '', affiliateId = '', email = ''
    test('applications list + detail include flags and acceptances', async () => {
      setFlag(true)
      const { b } = await post()
      email = b.email
      const list = await (await appsGET(req('/api/admin/affiliates/applications'))).json()
      const row = list.applications.find((a: any) => a.email === b.email)
      expect(row.status).toBe('pending')
      appId = row.id
      expect(list.counts.openApplications).toBeGreaterThanOrEqual(1)
      expect(list.readiness.open).toBe(true)
      const detail = await (await appGET(req(`/api/admin/affiliates/applications/${appId}`), params(appId))).json()
      expect(detail.application.acceptances).toHaveLength(3)
      expect((await appGET(req('/x'), params('not-a-uuid'))).status).toBe(400)
      expect((await appGET(req('/x'), params('00000000-0000-4000-8000-0000000000aa'))).status).toBe(404)
    })

    test('approve validates input, creates the affiliate once, and sends the approval email', async () => {
      const bad = await appPOST(req('/x', { body: { action: 'approve', config: { code: 'x' } } }), params(appId))
      expect(bad.status).toBe(400)
      const ok = await appPOST(req('/x', { body: { action: 'approve', config: { code: 'grace10', commissionType: 'percentage', commissionRateBps: 1500, discountType: 'percentage', discountBps: 1000, approvalMessage: 'Welcome' } } }), params(appId))
      expect(ok.status).toBe(200)
      affiliateId = (await ok.json()).result.affiliate_id
      expect(sent.some(m => m.to === email && /approved/i.test(m.subject))).toBe(true)
      const again = await appPOST(req('/x', { body: { action: 'approve', config: { code: 'grace11', commissionType: 'percentage', commissionRateBps: 1500 } } }), params(appId))
      expect(again.status).toBe(409)
      expect(await count('affiliates')).toBeGreaterThanOrEqual(1)
      expect((await appPOST(req('/x', { body: { action: 'nope' } }), params(appId))).status).toBe(400)
      expect((await appPOST(req('/x', { body: '{bad' }), params(appId))).status).toBe(400)
    })

    test('profile lifecycle through the route: activate, suspend (code off), terminate needs a reason, reinstate', async () => {
      const act = (action: string, extra: Record<string, unknown> = {}) => profilePOST(req('/x', { body: { action, ...extra } }), params(affiliateId))
      expect((await act('activate')).status).toBe(200)
      expect((await one(`SELECT d.active FROM discounts d JOIN affiliates a ON a.discount_id = d.id WHERE a.id = $1`, [affiliateId])).active).toBe(true)
      setFlag(true)
      expect((await act('suspend', { reason: 'review', message: 'Pausing while we check something.' })).status).toBe(200)
      expect((await one(`SELECT d.active FROM discounts d JOIN affiliates a ON a.discount_id = d.id WHERE a.id = $1`, [affiliateId])).active).toBe(false)
      expect(sent.some(m => m.to === email && /paused/i.test(m.subject))).toBe(true)
      expect((await act('terminate')).status).toBe(400)
      expect((await act('terminate', { reason: 'policy' })).status).toBe(200)
      expect((await act('reinstate')).status).toBe(400)
      expect((await act('reinstate', { reason: 'appeal' })).status).toBe(200)
      expect((await act('settings', { settings: { payoutSchedule: 'bogus' } })).status).toBe(400)
      expect((await act('settings', { settings: { payoutSchedule: 'monthly' } })).status).toBe(200)
      expect((await act('change_code', { code: 'bad code' })).status).toBe(400)
      expect((await profilePOST(req('/x', { body: { action: 'suspend' } }), params('nope'))).status).toBe(400)
      const list = await (await profilesGET(req('/x'))).json()
      expect(list.profiles.find((p: any) => p.id === affiliateId).programStatus).toBe('active')
    })

    test('the existing status endpoint maps onto the program lifecycle and keeps its response shape', async () => {
      setFlag(false)
      const sentBefore = sent.length
      const pause = await mainPOST(req('/api/admin/affiliates', { body: { kind: 'status', affiliateId, status: 'paused', reason: 'legacy ui' } }))
      expect(pause.status).toBe(200)
      expect(await pause.json()).toEqual({ ok: true })
      expect((await one(`SELECT program_status FROM affiliate_profiles WHERE affiliate_id = $1`, [affiliateId])).program_status).toBe('suspended')
      expect(sent.length).toBe(sentBefore)   // flag OFF: no program emails
      expect((await mainPOST(req('/x', { body: { kind: 'status', affiliateId, status: 'bogus' } }))).status).toBe(400)
      expect((await mainPOST(req('/x', { body: { kind: 'status', affiliateId: '00000000-0000-4000-8000-0000000000bb', status: 'paused' } }))).status).toBe(404)
      const back = await mainPOST(req('/x', { body: { kind: 'status', affiliateId, status: 'active' } }))
      expect(back.status).toBe(200)
      const aff = await mainGET(req('/api/admin/affiliates?range=30d'))
      expect(aff.status).toBe(200)
    })

    test('new terms go through the existing append-only terms function', async () => {
      const before = (await one(`SELECT count(*)::int AS n FROM affiliate_terms_events WHERE affiliate_id = $1`, [affiliateId])).n
      const r = await mainPOST(req('/x', { body: { kind: 'terms', affiliateId, commissionType: 'percentage', commissionRateBps: 2000, attributionWindowDays: 30, commissionHoldDays: 14, reason: 'raise' } }))
      expect(r.status).toBe(200)
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_terms_events WHERE affiliate_id = $1`, [affiliateId])).n).toBe(before + 1)
      expect((await mainPOST(req('/x', { body: { kind: 'terms', affiliateId, commissionType: 'percentage', commissionRateBps: 99999, attributionWindowDays: 30, commissionHoldDays: 14 } }))).status).toBe(400)
    })

    test('reject through the route sends only the applicant message', async () => {
      setFlag(true)
      const { b } = await post()
      const id = (await one(`SELECT id FROM affiliate_applications WHERE email_normalized = $1`, [b.email])).id
      await appPOST(req('/x', { body: { action: 'add_note', note: 'INTERNAL-ONLY-TEXT' } }), params(id))
      sent.length = 0
      const r = await appPOST(req('/x', { body: { action: 'reject', message: 'Thanks, but not this time.' } }), params(id))
      expect(r.status).toBe(200)
      const mail = sent.find(m => m.to === b.email)
      expect(mail.html).toContain('not this time')
      expect(mail.html).not.toContain('INTERNAL-ONLY-TEXT')
      expect((await appPOST(req('/x', { body: { action: 'request_info' } }), params(id))).status).toBe(400)
    })

    test('invites: held when the flag is off; emailed with a one-time link when on; token never returned', async () => {
      setFlag(false)
      const held = await invitesPOST(req('/x', { body: { action: 'create', invite: { email: 'held@example.com', displayName: 'Held Person' } } }))
      expect(held.status).toBe(201)
      expect((await held.json()).email).toBe('held')
      expect(sent).toHaveLength(0)
      setFlag(true)
      const ok = await invitesPOST(req('/x', { body: { action: 'create', invite: { email: 'sent@example.com', displayName: 'Sent Person' } } }))
      const j = await ok.json()
      expect(j.email).toBe('sent')
      expect(JSON.stringify(j)).not.toMatch(/[0-9a-f]{64}/)
      const mail = sent.find(m => m.to === 'sent@example.com')
      const tok = /#invite=([0-9a-f]{64})/.exec(mail.html)![1]
      expect(await admin.lookupInvite(tok)).toEqual({ email: 'sent@example.com', displayName: 'Sent Person' })
      expect(JSON.stringify(await fi.q(`SELECT * FROM affiliate_invites`))).not.toContain(tok)
      expect(JSON.stringify(await fi.q(`SELECT * FROM affiliate_email_outbox`))).not.toContain(tok)
      const list = await (await invitesGET(req('/x'))).json()
      expect(list.invites.find((i: any) => i.email === 'sent@example.com').emailStatus).toBe('sent')
      // Resend rotates the token; the old one stops working.
      const re = await invitesPOST(req('/x', { body: { action: 'resend', inviteId: j.inviteId } }))
      expect(re.status).toBe(200)
      expect(await admin.lookupInvite(tok)).toBeNull()
      const rev = await invitesPOST(req('/x', { body: { action: 'revoke', inviteId: j.inviteId } }))
      expect(rev.status).toBe(200)
      expect((await invitesPOST(req('/x', { body: { action: 'resend', inviteId: 'bad' } }))).status).toBe(400)
      setFlag(false)
      expect((await invitesPOST(req('/x', { body: { action: 'resend', inviteId: j.inviteId } }))).status).toBe(409)
    })

    test('documents: save, publish with a material change, reacceptance list; settings: audited with optimistic revision', async () => {
      const save = await docsPOST(req('/x', { body: { action: 'save_draft', document: { docType: 'program_terms', title: 'Program terms v-next', body: '# Terms\n\nUpdated final wording that is long enough to publish for the test.' } } }))
      expect(save.status).toBe(200)
      const docId = (await save.json()).result.document_id
      expect((await docsPOST(req('/x', { body: { action: 'save_draft', document: { docType: 'nope', title: 'x', body: 'y' } } }))).status).toBe(400)
      sent.length = 0
      const pub = await docsPOST(req('/x', { body: { action: 'publish', documentId: docId, material: true } }))
      expect(pub.status).toBe(200)
      expect((await docsPOST(req('/x', { body: { action: 'publish', documentId: docId, material: true } }))).status).toBe(409)
      const g1 = await (await docsGET(req('/x'))).json()
      expect(g1.documents.filter((x: any) => x.docType === 'program_terms' && x.isCurrent)).toHaveLength(1)
      expect(g1.reacceptance.length).toBeGreaterThanOrEqual(1)

      const s = await (await settingsGET(req('/x'))).json()
      const put = await settingsPUT(req('/x', { method: 'PUT', body: { revision: s.revision, settings: { ...s.settings, inviteExpiryDays: 7 } } }))
      expect(put.status).toBe(200)
      const stale = await settingsPUT(req('/x', { method: 'PUT', body: { revision: s.revision, settings: { ...s.settings, inviteExpiryDays: 9 } } }))
      expect(stale.status).toBe(409)
      expect((await settingsPUT(req('/x', { method: 'PUT', body: { revision: 5, settings: { ...s.settings, countries: ['USA'] } } }))).status).toBe(400)
      const audit = await (await auditGET(req('/x'))).json()
      expect(audit.entries.length).toBeGreaterThan(5)
      const em = await (await emailsGET(req('/x'))).json()
      expect(Array.isArray(em.emails)).toBe(true)
      expect(JSON.stringify(em)).not.toMatch(/@example\.com/)   // statuses only, no addresses
      expect((await emailsPOST(req('/x', { body: {} }))).status).toBe(200)
    })
  })

  describe('POST /api/internal/affiliate-program-maintenance', () => {
    const call = (auth?: string) => maintPOST(req('/api/internal/affiliate-program-maintenance', { method: 'POST', headers: auth ? { authorization: auth } : {} }))
    test('fails closed without a secret, rejects wrong bearer, returns counts only when authorised', async () => {
      const prev = process.env.CRON_SECRET
      delete process.env.CRON_SECRET
      expect((await call('Bearer x')).status).toBe(503)
      process.env.CRON_SECRET = 'cron-secret-test'
      expect((await call()).status).toBe(401)
      expect((await call('Bearer wrong')).status).toBe(403)
      const ok = await call('Bearer cron-secret-test')
      expect(ok.status).toBe(200)
      const j = await ok.json()
      expect(Object.keys(j).sort()).toEqual(['email', 'terminated'])
      if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev
    })
  })
})

describe('UI and page source guards', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const adminFiles = ['AffiliatesClient', 'AffiliateApplicationsTab', 'AffiliateProfilesTab', 'AffiliateTermsTab', 'AffiliateAuditTab', 'AffiliateComplianceTab', 'AffiliatePayoutReadinessTab']
    .map(f => `app/admin/financials/affiliates/${f}.tsx`)

  test('the Affiliates page keeps the existing financial invariants', () => {
    const ui = read('app/admin/financials/affiliates/AffiliatesClient.tsx').replace(/\s+/g, ' ')
    expect(ui).toContain('are separate costs and both may apply to one order')
    expect(ui).toContain('not</strong> treated as zero')
    expect(ui).toContain('recovery-attempt-key')
    expect(ui).not.toContain('commissionRateBps *')
  })
  test('tabs: Overview, Applications, Affiliates, Commissions, Payouts, Unresolved, Compliance, Payout readiness, Terms & settings, Audit', () => {
    const ui = read('lib/affiliate-program-ui.ts')
    for (const l of ['Overview', 'Applications', 'Affiliates', 'Commissions', 'Payouts', 'Unresolved', 'Compliance', 'Payout readiness', 'Terms & settings', 'Audit']) expect(ui).toContain(`'${l}'`)
    for (const f of ['AffiliateComplianceTab', 'AffiliatePayoutReadinessTab']) {
      const src = read(`app/admin/financials/affiliates/${f}.tsx`)
      expect(src).toMatch(new RegExp(`export function ${f}\\(\\)`))
      expect(src).toContain('AdminEmpty')
    }
  })
  test('Admin UI uses the shared primitives and avoids banned words in visible text', () => {
    for (const f of adminFiles) {
      const src = read(f)
      expect(src).not.toMatch(/dangerouslySetInnerHTML/)
      expect(src).not.toMatch(/\b(authoritative|deterministic|canonical)\b/i)
      expect(src).not.toMatch(/(?<![\w.])(alert|prompt)\(|window\.(confirm|alert|prompt)\(/)   // no native dialogs: useConfirm keeps warnings visible
    }
    expect(read('app/admin/financials/affiliates/AffiliatesClient.tsx')).toContain('AdminPageHeader')
    expect(read('app/admin/financials/affiliates/AffiliatesClient.tsx')).toContain('AdminTabs')
    // Page description is 3-8 words.
    const m = /description="([^"]+)"/.exec(read('app/admin/financials/affiliates/AffiliatesClient.tsx'))!
    const words = m[1].trim().split(/\s+/).length
    expect(words).toBeGreaterThanOrEqual(3); expect(words).toBeLessThanOrEqual(8)
  })
  test('destructive confirmations show their warning text inside the dialog, not in a tooltip', () => {
    const ui = read('lib/affiliate-program-ui.ts')
    expect(ui).toContain('PROFILE_ACTION_WARNING')
    const profiles = read('app/admin/financials/affiliates/AffiliateProfilesTab.tsx')
    expect(profiles).toContain('PROFILE_ACTION_WARNING[a]')
    expect(profiles).toMatch(/confirm\(PROFILE_ACTION_WARNING/)
  })
  test('public application form: every consent starts unchecked, honeypot present, no HTML injection', () => {
    const src = read('app/affiliates/apply/ApplyClient.tsx')
    expect(src).toMatch(/ageAttested: false, termsAccepted: false, disclosureAccepted: false, privacyAccepted: false, accuracyConfirmed: false, esignConsent: false/)
    expect(src).not.toMatch(/defaultChecked|checked=\{true\}/)
    expect(src).toContain('company_fax')
    expect(src).not.toMatch(/dangerouslySetInnerHTML/)
    expect(read('app/affiliates/_components/DocumentBody.tsx')).not.toMatch(/dangerouslySetInnerHTML/)
    for (const p of ['app/affiliates/apply/page.tsx', 'app/affiliates/documents/[docType]/page.tsx']) {
      const s = read(p)
      expect(s).toContain("isFeatureEnabled('AFFILIATE_APPLICATIONS')")
      expect(s).toMatch(/notFound\(\)/)
      expect(s).toContain("export const dynamic = 'force-dynamic'")
      expect(s).toMatch(/robots: \{ index: false/)
    }
  })
  test('public routes are flag-gated and never log tokens', () => {
    for (const p of ['app/api/affiliates/apply/route.ts', 'app/api/affiliates/invite/route.ts']) {
      const s = read(p)
      expect(s).toContain("isFeatureEnabled('AFFILIATE_APPLICATIONS')")
      expect(s).not.toMatch(/console\.(log|info)\(/)
      expect(s).not.toMatch(/console\.error\([^)]*(token|body|email)/i)
    }
  })
  test('no new dependencies were added', () => {
    const pkg = JSON.parse(read('package.json'))
    for (const dep of ['sharp', 'zod', 'uuid', 'nanoid', 'bcrypt', 'jsonwebtoken', 'nodemailer']) {
      expect(pkg.dependencies?.[dep]).toBeUndefined()
    }
  })
})
