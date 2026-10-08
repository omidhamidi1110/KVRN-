// Compliance center, fraud-flag handling, UGC rights, paid-ad policy, suspension and the Admin routes — real PostgreSQL.
import { validateItemInput, validateWarningInput } from '../affiliate-compliance'
import { validateUgcGrant, mapUgcError } from '../affiliate-compliance-ugc'

let mockAdmin: { email: string } | null = { email: 'admin@kvrn.test' }
jest.mock('../admin-auth', () => ({
  requireAdmin: async () => (mockAdmin
    ? { identity: mockAdmin, error: null }
    : { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }),
}))
jest.mock('../db', () => ({ sql: (...a: any[]) => (globalThis as any).__affPortalTestSql(...a) }))

import { createAffiliateComplianceService } from '../affiliate-compliance'
import { createAffiliateUgcService } from '../affiliate-compliance-ugc'
import { canPayAffiliate } from '../affiliate-payout-gate'
import {
  HAVE_DB, PII, createPortalFx, installDb, makeReady, acceptAll, mkAffiliate, mkDraftPayout, mkReq, mkSale, promote, seedDocs, payPayout,
  type PortalFx,
} from './affiliate-portal-fixtures'

// ── pure validation ──────────────────────────────────────────────────────────
describe('compliance validation (pure)', () => {
  test('saved post links must be https; text is trimmed and bounded', () => {
    expect(validateItemInput({ url: 'http://x.example/p' }).ok).toBe(false)
    expect(validateItemInput({ url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateItemInput({ url: '' }).ok).toBe(false)
    const ok = validateItemInput({ url: 'https://www.instagram.com/p/abc/', title: '  Hoodie  ', note: 'x'.repeat(5000) })
    expect(ok.ok).toBe(true)
    if (ok.ok) { expect(ok.value.title).toBe('Hoodie'); expect(ok.value.note!.length).toBe(1000) }
  })
  test('warnings need a severity, a category and a message the affiliate can read', () => {
    expect(validateWarningInput({ severity: 'loud', category: 'brand', summary: 'abc' }).ok).toBe(false)
    expect(validateWarningInput({ severity: 'notice', category: 'nope', summary: 'abc' }).ok).toBe(false)
    expect(validateWarningInput({ severity: 'notice', category: 'brand', summary: ' ' }).ok).toBe(false)
    expect(validateWarningInput({ severity: 'notice', category: 'brand', summary: 'abc', itemId: 'not-a-uuid' }).ok).toBe(false)
    const ok = validateWarningInput({ severity: 'warning', category: 'disclosure', summary: 'Please add #ad' })
    expect(ok.ok && ok.value.notifyAffiliate).toBe(true)
  })
  test('UGC grant validation: broad rights need an agreement reference; durations and expiry are sane', () => {
    const base = { licenseVersion: 'v1', territory: 'Worldwide', channels: ['instagram'], rights: { organic: true } }
    expect(validateUgcGrant(base).ok).toBe(true)
    expect(validateUgcGrant({ ...base, rights: {} }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { organic: false } }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { telepathy: true } }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { paid_ads: true } }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { whitelisting: true } }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { likeness: true } }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, rights: { paid_ads: true }, evidenceRef: 'DocuSign #123' }).ok).toBe(true)
    expect(validateUgcGrant({ ...base, channels: ['myspace'] }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, territory: '' }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, durationMonths: 0 }).ok).toBe(false)
    expect(validateUgcGrant({ ...base, startsAt: '2030-01-01', expiresAt: '2029-01-01' }).ok).toBe(false)
    const dur = validateUgcGrant({ ...base, startsAt: '2030-01-01T00:00:00Z', durationMonths: 12 })
    expect(dur.ok && dur.value.expiresAt!.slice(0, 10)).toBe('2031-01-01')
    expect(mapUgcError(new Error('KVRN_AFFPORTAL|LICENSE_IMMUTABLE|x'))?.status).toBe(409)
    expect(mapUgcError(new Error('boom: secret SQL text'))).toBeNull()
  })
})

const d = HAVE_DB ? describe : describe.skip
d('compliance + UGC + fraud flags + Admin routes (real PostgreSQL)', () => {
  let fx: PortalFx
  let svc: ReturnType<typeof createAffiliateComplianceService>
  let ugc: ReturnType<typeof createAffiliateUgcService>
  let C: any, U: any, R: any, RS: any
  const post = (path: string, body: unknown) => mkReq(path, { method: 'POST', body })

  beforeAll(async () => {
    fx = await createPortalFx('affp_comp'); installDb(fx.sql); await seedDocs(fx.q)
    svc = createAffiliateComplianceService(fx.sql); ugc = createAffiliateUgcService(fx.sql)
    C = await import('../../app/api/admin/affiliates/compliance/route')
    U = await import('../../app/api/admin/affiliates/ugc/route')
    R = await import('../../app/api/admin/affiliates/payout-readiness/route')
    RS = await import('../../app/api/admin/affiliates/payout-readiness/statement/route')
  }, 120000)
  afterAll(async () => { await fx?.close() })
  beforeEach(() => { mockAdmin = { email: 'admin@kvrn.test' } })

  const audit = async (action: string, affiliateId: string) =>
    Number((await fx.q(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action=$1 AND resource_id=$2`, [action, affiliateId]))[0].n)

  test('every Admin route calls requireAdmin first: unauthenticated callers get 401 and touch no data', async () => {
    mockAdmin = null
    const spy = jest.fn(); installDb(Object.assign(spy, { query: spy }))
    try {
      const a = '11111111-1111-4111-8111-111111111111'
      const calls = [
        C.GET(mkReq('/api/admin/affiliates/compliance')), C.POST(post('/api/admin/affiliates/compliance', { kind: 'scan' })),
        U.GET(mkReq(`/api/admin/affiliates/ugc?affiliateId=${a}`)), U.POST(post('/api/admin/affiliates/ugc', { kind: 'revoke', affiliateId: a })),
        R.GET(mkReq('/api/admin/affiliates/payout-readiness')), R.POST(post('/api/admin/affiliates/payout-readiness', { kind: 'gate', affiliateId: a })),
        RS.GET(mkReq(`/api/admin/affiliates/payout-readiness/statement?payoutId=${a}`)),
      ]
      for (const res of await Promise.all(calls)) expect(res.status).toBe(401)
      expect(spy).not.toHaveBeenCalled()
    } finally { installDb(fx.sql) }
  })

  test('saved posts, status history and the review log are recorded with audit rows; nothing can be deleted', async () => {
    const a = await mkAffiliate(fx.q)
    const r = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_add', affiliateId: a.id, url: 'https://www.tiktok.com/@x/video/1', platform: 'tiktok', note: 'No #ad' }))
    expect(r.status).toBe(201)
    const itemId = (await r.json()).id
    expect(await audit('affiliate.compliance_item_add', a.id)).toBe(1)

    const bad = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_add', affiliateId: a.id, url: 'http://insecure.example/x' }))
    expect(bad.status).toBe(400)

    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_status', affiliateId: a.id, itemId, status: 'violation', note: 'missing disclosure' }))).status).toBe(200)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_status', affiliateId: a.id, itemId, status: 'bogus' }))).status).toBe(400)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_status', affiliateId: a.id, itemId: '22222222-2222-4222-8222-222222222222', status: 'resolved' }))).status).toBe(404)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'item_status', affiliateId: a.id, itemId, status: 'resolved', note: 'fixed' }))).status).toBe(200)
    const ev = await fx.q(`SELECT from_status, to_status FROM affiliate_compliance_item_events WHERE item_id=$1 ORDER BY created_at, id`, [itemId])
    expect(ev.map((e: any) => `${e.from_status ?? '-'}>${e.to_status}`)).toEqual(['->needs_review', 'needs_review>violation', 'violation>resolved'])
    await expect(fx.q(`DELETE FROM affiliate_compliance_items WHERE id=$1`, [itemId])).rejects.toThrow(/APPEND_ONLY/)
    await expect(fx.q(`UPDATE affiliate_compliance_item_events SET note='x' WHERE item_id=$1`, [itemId])).rejects.toThrow(/APPEND_ONLY/)

    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'review', affiliateId: a.id, outcome: 'issues_found', note: 'Checked 3 posts' }))).status).toBe(201)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'review', affiliateId: a.id, outcome: 'whatever' }))).status).toBe(400)
    expect(await audit('affiliate.compliance_review', a.id)).toBe(1)
    await expect(fx.q(`DELETE FROM affiliate_compliance_reviews WHERE affiliate_id=$1`, [a.id])).rejects.toThrow(/APPEND_ONLY/)

    const det = await (await C.GET(mkReq(`/api/admin/affiliates/compliance?affiliateId=${a.id}`))).json()
    expect(det.detail.items).toHaveLength(1)
    expect(det.detail.reviews).toHaveLength(1)
    expect(det.detail.lastReviewAt).not.toBeNull()
  })

  test('warning history is append-only: only open → resolved may change, and only the resolution fields', async () => {
    const a = await mkAffiliate(fx.q)
    const r = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'warning_issue', affiliateId: a.id, severity: 'warning', category: 'disclosure', summary: 'Please add #ad to your posts.', internalNote: 'second time' }))
    expect(r.status).toBe(201)
    const wid = (await r.json()).id
    expect(await audit('affiliate.compliance_warning', a.id)).toBe(1)

    // A notification was queued in the same statement, carrying only the affiliate-facing summary.
    const n = await fx.q(`SELECT kind, payload FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [a.id])
    expect(n).toHaveLength(1)
    expect(JSON.stringify(n[0].payload)).not.toContain('second time')

    await expect(fx.q(`UPDATE affiliate_compliance_warnings SET summary='softer' WHERE id=$1`, [wid])).rejects.toThrow(/WARNING_IMMUTABLE/)
    await expect(fx.q(`UPDATE affiliate_compliance_warnings SET severity='notice' WHERE id=$1`, [wid])).rejects.toThrow(/WARNING_IMMUTABLE/)
    await expect(fx.q(`DELETE FROM affiliate_compliance_warnings WHERE id=$1`, [wid])).rejects.toThrow(/APPEND_ONLY/)

    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'warning_resolve', affiliateId: a.id, warningId: wid, note: 'Corrected' }))).status).toBe(200)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'warning_resolve', affiliateId: a.id, warningId: wid }))).status).toBe(404)
    await expect(fx.q(`UPDATE affiliate_compliance_warnings SET resolution_note='rewrite' WHERE id=$1`, [wid])).rejects.toThrow(/WARNING_FINAL/)
    expect(await audit('affiliate.compliance_warning_resolve', a.id)).toBe(1)

    // A second warning stays alongside the first: history, not replacement.
    await C.POST(post('/api/admin/affiliates/compliance', { kind: 'warning_issue', affiliateId: a.id, severity: 'final', category: 'brand', summary: 'Final notice about brand rules', notifyAffiliate: false }))
    const det = await (await C.GET(mkReq(`/api/admin/affiliates/compliance?affiliateId=${a.id}`))).json()
    expect(det.detail.warnings.map((w: any) => w.status).sort()).toEqual(['open', 'resolved'])
    expect(Number((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [a.id]))[0].n)).toBe(1) // notify=false queued nothing
  })

  test('route input validation: ids, unknown actions, malformed bodies', async () => {
    const cases: Array<[any, number]> = [
      [{ kind: 'warning_issue', affiliateId: 'nope' }, 400],
      [{ kind: 'review' }, 400],
      [{ kind: 'flag_open', affiliateId: '11111111-1111-4111-8111-111111111111', signal: 'made_up' }, 400],
      [{ kind: 'suspend', affiliateId: '11111111-1111-4111-8111-111111111111', reason: 'x' }, 400],
      [{ kind: 'explode' }, 400],
    ]
    for (const [body, status] of cases) expect((await C.POST(post('/api/admin/affiliates/compliance', body))).status).toBe(status)
    const res = await C.POST(new (require('next/server').NextRequest)('https://kvrn.shop/api/admin/affiliates/compliance', { method: 'POST', body: '{nope' }))
    expect(res.status).toBe(400)
    expect((await C.GET(mkReq('/api/admin/affiliates/compliance?affiliateId=zzz'))).status).toBe(400)
    // Unknown affiliate: the foreign key is mapped to a clean 404, not a SQL error.
    const nf = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'warning_issue', affiliateId: '11111111-1111-4111-8111-111111111111', severity: 'notice', category: 'brand', summary: 'hello there' }))
    expect(nf.status).toBe(404)
    expect(JSON.stringify(await nf.json())).not.toMatch(/violates|constraint|affiliate_compliance/)
  })

  test('self-referral scan: idempotent, raises a REVIEW flag only (never freezes), stores no email', async () => {
    const a = await mkAffiliate(fx.q, { email: 'Self.Referrer+promo@gmail.com' })
    const other = await mkAffiliate(fx.q)
    const exact = await mkSale(fx.q, { code: a.code, customerEmail: 'self.referrer+promo@gmail.com' })
    const similar = await mkSale(fx.q, { code: a.code, customerEmail: 'selfreferrer@gmail.com' })
    const clean = await mkSale(fx.q, { code: a.code })
    const otherSale = await mkSale(fx.q, { code: other.code })

    const first = await svc.scanSelfReferral({ sinceDays: 7, actor: 'admin@kvrn.test' })
    expect(first.created).toBe(2)
    const second = await svc.scanSelfReferral({ sinceDays: 7, actor: 'admin@kvrn.test' })
    expect(second.created).toBe(0)

    const flags = await fx.q(`SELECT f.*, o.order_number FROM affiliate_fraud_flags f JOIN orders o ON o.id=f.order_id WHERE f.affiliate_id=$1 ORDER BY f.signal`, [a.id])
    expect(flags.map((f: any) => [f.signal, f.severity, f.freeze_commissions, f.status])).toEqual([
      ['customer_email_matches_affiliate', 'review', false, 'open'],
      ['customer_email_similar_to_affiliate', 'info', false, 'open'],
    ])
    const exactFlag = flags.find((f: any) => f.signal === 'customer_email_matches_affiliate')
    expect(exactFlag.order_id).toBe(exact.orderId)
    expect(flags.some((f: any) => f.order_id === clean.orderId || f.order_id === otherSale.orderId)).toBe(false)
    expect(similar.orderId).toBeTruthy()
    const dump = JSON.stringify(await fx.q(`SELECT * FROM affiliate_fraud_flags WHERE affiliate_id=$1`, [a.id]))
      + JSON.stringify(await fx.q(`SELECT * FROM affiliate_fraud_flag_events WHERE affiliate_id=$1`, [a.id]))
      + JSON.stringify(await fx.q(`SELECT payload FROM admin_audit_logs WHERE action='affiliate.fraud_flag_detected' AND resource_id=$1`, [a.id]))
    expect(dump.toLowerCase()).not.toContain('gmail')
    expect(dump.toLowerCase()).not.toContain('referrer')
    expect(dump).not.toContain(PII.email)

    // A review flag does NOT stop payout; it is surfaced as a warning only. The commission is untouched.
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id); await promote(fx.q, a.id)
    const gate = await canPayAffiliate(fx.sql, a.id)
    expect(gate.allowed).toBe(true)
    expect(gate.warnings.length).toBeGreaterThan(0)
    expect(Number((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_commissions WHERE affiliate_id=$1`, [a.id]))[0].n)).toBe(3)

    // via the Admin route as well
    const viaRoute = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'scan', sinceDays: 7 }))
    expect(viaRoute.status).toBe(200)
    expect((await viaRoute.json()).result.created).toBe(0)
  })

  test('fraud flag lifecycle: freeze blocks payout (and nothing else changes); closing needs a note; history is kept', async () => {
    const a = await mkAffiliate(fx.q)
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    const s = await mkSale(fx.q, { code: a.code }); await promote(fx.q, a.id)
    const before = await fx.q(`SELECT id, status, commission_cents FROM affiliate_commissions WHERE affiliate_id=$1`, [a.id])

    const open = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_open', affiliateId: a.id, signal: 'suspected_coupon_leakage', orderId: s.orderId, severity: 'high', note: 'Code posted on a coupon site', freeze: true }))
    expect(open.status).toBe(201)
    const flagId = (await open.json()).id
    expect((await canPayAffiliate(fx.sql, a.id)).blockers.map(b => b.code)).toContain('commissions_frozen')
    expect(await audit('affiliate.fraud_flag_open', a.id)).toBe(1)

    // Resolve without a note is refused; money-bearing rows are untouched by the freeze.
    const noNote = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_update', affiliateId: a.id, flagId, status: 'resolved' }))
    expect(noNote.status).toBe(409)
    expect((await canPayAffiliate(fx.sql, a.id)).allowed).toBe(false)
    expect(await fx.q(`SELECT id, status, commission_cents FROM affiliate_commissions WHERE affiliate_id=$1`, [a.id])).toEqual(before)

    // Unfreeze while still investigating
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_update', affiliateId: a.id, flagId, freeze: false, status: 'investigating', note: 'Looking into it' }))).status).toBe(200)
    expect((await canPayAffiliate(fx.sql, a.id)).allowed).toBe(true)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_update', affiliateId: a.id, flagId, freeze: true }))).status).toBe(200)
    expect((await canPayAffiliate(fx.sql, a.id)).allowed).toBe(false)

    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_update', affiliateId: a.id, flagId, status: 'dismissed', freeze: false, note: 'Legitimate promo partner' }))).status).toBe(200)
    expect((await canPayAffiliate(fx.sql, a.id)).allowed).toBe(true)
    // closed flags are final
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'flag_update', affiliateId: a.id, flagId, status: 'open', note: 'reopen attempt' }))).status).toBe(409)
    const events = await fx.q(`SELECT action FROM affiliate_fraud_flag_events WHERE flag_id=$1 ORDER BY created_at, id`, [flagId])
    expect(events.map((e: any) => e.action)).toEqual(['opened', 'unfreeze', 'freeze', 'unfreeze'])
    await expect(fx.q(`DELETE FROM affiliate_fraud_flags WHERE id=$1`, [flagId])).rejects.toThrow(/APPEND_ONLY/)
    await expect(fx.q(`UPDATE affiliate_fraud_flag_events SET note='x' WHERE flag_id=$1`, [flagId])).rejects.toThrow(/APPEND_ONLY/)
  })

  test('paid-ad permission is a recorded decision, validated, audited and visible to the gate-independent profile', async () => {
    const a = await mkAffiliate(fx.q)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'paid_ads', affiliateId: a.id, policy: 'anything' }))).status).toBe(400)
    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'paid_ads', affiliateId: a.id, policy: 'written_approval', note: 'Agreed by email' }))).status).toBe(200)
    expect((await fx.q(`SELECT paid_ads_policy FROM affiliate_profiles WHERE affiliate_id=$1`, [a.id]))[0].paid_ads_policy).toBe('written_approval')
    expect(await audit('affiliate.paid_ads_policy', a.id)).toBe(1)
    const none = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'paid_ads', affiliateId: '33333333-3333-4333-8333-333333333333', policy: 'approved' }))
    expect([404, 400]).toContain(none.status)
  })

  test('compliance suspension: code stops qualifying NEW sales, history intact, portal revoked on request, sessions ended, audited', async () => {
    const a = await mkAffiliate(fx.q)
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    await mkSale(fx.q, { code: a.code }); await promote(fx.q, a.id)
    const ledgerBefore = await fx.q(`SELECT id, adjustment_cents FROM affiliate_commission_adjustments WHERE affiliate_id=$1 ORDER BY id`, [a.id])

    expect((await C.POST(post('/api/admin/affiliates/compliance', { kind: 'suspend', affiliateId: a.id, reason: 'x' }))).status).toBe(400)
    const res = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'suspend', affiliateId: a.id, reason: 'Undisclosed paid ads', revokePortal: false }))
    expect(res.status).toBe(200)
    expect((await res.json()).result.outcome).toBe('suspended')
    expect((await fx.q(`SELECT status FROM affiliates WHERE id=$1`, [a.id]))[0].status).toBe('paused')
    const p = (await fx.q(`SELECT program_status, portal_access, suspended_at FROM affiliate_profiles WHERE affiliate_id=$1`, [a.id]))[0]
    expect(p.program_status).toBe('suspended'); expect(['enabled', 'read_only']).toContain(p.portal_access);   // the real 033 sync trigger may already have made it read-only
     expect(p.suspended_at).not.toBeNull()
    await expect(mkSale(fx.q, { code: a.code })).rejects.toThrow(/not attributed/)
    expect(await fx.q(`SELECT id, adjustment_cents FROM affiliate_commission_adjustments WHERE affiliate_id=$1 ORDER BY id`, [a.id])).toEqual(ledgerBefore)
    expect((await canPayAffiliate(fx.sql, a.id)).blockers.map(b => b.code)).toEqual(expect.arrayContaining(['program_suspended']))
    expect(await audit('affiliate.suspend', a.id)).toBe(1)

    // idempotent; second call with portal revocation
    const again = await C.POST(post('/api/admin/affiliates/compliance', { kind: 'suspend', affiliateId: a.id, reason: 'Undisclosed paid ads', revokePortal: true }))
    expect((await again.json()).result.outcome).toBe('already_suspended')
    expect((await fx.q(`SELECT portal_access FROM affiliate_profiles WHERE affiliate_id=$1`, [a.id]))[0].portal_access).toBe('revoked')
  })

  test('UGC rights are separate from affiliate status: none by default, granted only by an explicit Admin license, revoke is one-way', async () => {
    const a = await mkAffiliate(fx.q)
    for (const right of ['organic', 'website', 'email', 'paid_ads', 'whitelisting', 'editing', 'likeness'] as const) {
      expect(await ugc.rightActive(a.id, right)).toBe(false)
    }
    // approving, activating and paying an affiliate grants nothing
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    expect(await ugc.rightActive(a.id, 'organic')).toBe(false)

    const body = { kind: 'grant', affiliateId: a.id, licenseVersion: 'v1', rights: { organic: true, website: true }, channels: ['instagram', 'website'], territory: 'Worldwide', durationMonths: 12, compensationNote: 'Free product', evidenceRef: 'Drive: ugc/aff-1.pdf' }
    expect((await U.POST(post('/api/admin/affiliates/ugc', { ...body, rights: { paid_ads: true }, evidenceRef: null }))).status).toBe(400)
    const g = await U.POST(post('/api/admin/affiliates/ugc', body))
    expect(g.status).toBe(201)
    const licenseId = (await g.json()).id
    expect(await audit('affiliate.ugc_license_granted', a.id)).toBe(1)
    expect(await ugc.rightActive(a.id, 'organic')).toBe(true)
    expect(await ugc.rightActive(a.id, 'website')).toBe(true)
    expect(await ugc.rightActive(a.id, 'paid_ads')).toBe(false)    // never granted
    expect(await ugc.rightActive(a.id, 'organic', new Date(Date.now() + 400 * 86400_000))).toBe(false) // expired after 12 months
    expect(await ugc.rightActive(a.id, 'organic', new Date(Date.now() - 86400_000 * 30))).toBe(false)  // before it started

    const list = await (await U.GET(mkReq(`/api/admin/affiliates/ugc?affiliateId=${a.id}`))).json()
    expect(list.licenses).toHaveLength(1)
    expect(list.licenses[0]).toMatchObject({ active: true, evidenceRef: 'Drive: ugc/aff-1.pdf' })

    // immutable evidence: no edit, no delete
    await expect(fx.q(`UPDATE affiliate_ugc_licenses SET rights='{"paid_ads": true}'::jsonb WHERE id=$1`, [licenseId])).rejects.toThrow(/LICENSE_IMMUTABLE/)
    await expect(fx.q(`DELETE FROM affiliate_ugc_licenses WHERE id=$1`, [licenseId])).rejects.toThrow(/APPEND_ONLY/)

    // suspending the affiliate does not silently change the license either way
    await C.POST(post('/api/admin/affiliates/compliance', { kind: 'suspend', affiliateId: a.id, reason: 'Compliance hold' }))
    expect(await ugc.rightActive(a.id, 'organic')).toBe(true)

    expect((await U.POST(post('/api/admin/affiliates/ugc', { kind: 'revoke', affiliateId: a.id, licenseId, reason: 'x' }))).status).toBe(400)
    expect((await U.POST(post('/api/admin/affiliates/ugc', { kind: 'revoke', affiliateId: a.id, licenseId, reason: 'Creator asked us to stop' }))).status).toBe(200)
    expect(await ugc.rightActive(a.id, 'organic')).toBe(false)
    expect((await U.POST(post('/api/admin/affiliates/ugc', { kind: 'revoke', affiliateId: a.id, licenseId, reason: 'Again please' }))).status).toBe(404)
    await expect(fx.q(`UPDATE affiliate_ugc_licenses SET revoke_reason='edited' WHERE id=$1`, [licenseId])).rejects.toThrow(/LICENSE_FINAL/)
    expect(await audit('affiliate.ugc_license_revoked', a.id)).toBe(1)
    // history kept
    expect((await (await U.GET(mkReq(`/api/admin/affiliates/ugc?affiliateId=${a.id}`))).json()).licenses[0].revokedAt).not.toBeNull()
  })

  test('UGC: the affiliate-facing API has no way to grant a license', async () => {
    const fs = require('fs'); const path = require('path')
    const dir = path.join(__dirname, '../../app/api/affiliate')
    const walk = (p: string): string[] => fs.readdirSync(p, { withFileTypes: true }).flatMap((e: any) => e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)])
    for (const f of walk(dir)) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src).not.toMatch(/affiliate_ugc_licenses|createAffiliateUgcService/)
    }
  })

  test('payout-readiness route: gate, readiness attestation, masked account refs, access, attempts — all audited and validated', async () => {
    const a = await mkAffiliate(fx.q)
    const P = '/api/admin/affiliates/payout-readiness'
    // positive states need an attestation note
    const noNote = await R.POST(post(P, { kind: 'readiness', affiliateId: a.id, domain: 'kyc', status: 'verified' }))
    expect(noNote.status).toBe(400)
    expect(JSON.stringify(await noNote.json())).not.toMatch(/KVRN_AFFPORTAL/)
    expect((await R.POST(post(P, { kind: 'readiness', affiliateId: a.id, domain: 'kyc', status: 'verified', note: 'Checked ID in dashboard' }))).status).toBe(200)
    expect((await R.POST(post(P, { kind: 'readiness', affiliateId: a.id, domain: 'nope', status: 'verified' }))).status).toBe(400)
    expect((await R.POST(post(P, { kind: 'readiness', affiliateId: a.id, domain: 'kyc', status: 'nope' }))).status).toBe(400)
    expect((await R.POST(post(P, { kind: 'readiness', affiliateId: a.id, domain: 'tax', status: 'pending' }))).status).toBe(200)

    // account: references and display strings only. Raw numbers are refused by the database CHECK and mapped cleanly.
    const okAcc = await R.POST(post(P, { kind: 'account', affiliateId: a.id, provider: 'manual', masked: { brand: 'Chase', last4: '4242' } }))
    expect(okAcc.status).toBe(200)
    const raw = await R.POST(post(P, { kind: 'account', affiliateId: a.id, provider: 'manual', masked: { accountNumber: '000123456789', routing: '110000000' } }))
    expect(raw.status).toBe(400)
    expect(JSON.stringify(await raw.json())).not.toMatch(/000123456789|constraint/)
    expect((await R.POST(post(P, { kind: 'account', affiliateId: a.id, provider: 'paypal' }))).status).toBe(400)
    expect(JSON.stringify(await fx.q(`SELECT masked_metadata FROM affiliate_payout_accounts WHERE affiliate_id=$1`, [a.id]))).not.toContain('000123456789')

    expect((await R.POST(post(P, { kind: 'access', affiliateId: a.id, access: 'read_only', note: 'Compliance review' }))).status).toBe(200)
    expect((await R.POST(post(P, { kind: 'access', affiliateId: a.id, access: 'god_mode' }))).status).toBe(400)
    expect((await fx.q(`SELECT portal_access FROM affiliate_profiles WHERE affiliate_id=$1`, [a.id]))[0].portal_access).toBe('read_only')

    const gate = await (await R.POST(post(P, { kind: 'gate', affiliateId: a.id }))).json()
    expect(gate.gate.allowed).toBe(false)
    expect(gate.gate.blockers.map((b: any) => b.code)).toEqual(expect.arrayContaining(['tax_incomplete', 'payout_method_not_ready']))

    const det = await (await R.GET(mkReq(`${P}?affiliateId=${a.id}`))).json()
    expect(det.gate.allowed).toBe(false)
    expect(det.detail.events.length).toBeGreaterThanOrEqual(2)
    const list = await (await R.GET(mkReq(P))).json()
    expect(list.affiliates.some((x: any) => x.affiliateId === a.id)).toBe(true)
    expect((await R.GET(mkReq(`${P}?affiliateId=zzz`))).status).toBe(400)

    for (const action of ['affiliate.readiness', 'affiliate.portal_access', 'affiliate.payout_account']) {
      const n = Number((await fx.q(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action LIKE $1 AND resource_id=$2`, [`${action}%`, a.id]))[0].n)
      expect(n).toBeGreaterThan(0)
    }
  })

  test('Admin statement route: includes the order number for reconciliation; affiliate-only fields are not required; CSV is a download', async () => {
    const a = await mkAffiliate(fx.q)
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    const s = await mkSale(fx.q, { code: a.code, subtotalCents: 20000 }); await promote(fx.q, a.id)
    const p = await mkDraftPayout(fx.q, a.id, [s.commissionId])
    const url = `/api/admin/affiliates/payout-readiness/statement?payoutId=${p.payout_id}`
    const j = await (await RS.GET(mkReq(url))).json()
    expect(j.statement.payoutNumber).toBe(p.payout_number)
    expect(j.statement.lines[0].orderNumber).toBe(s.orderNumber)
    expect(j.statement.totals).toMatchObject({ reconciled: true, netCents: 2000 })
    const csv = await RS.GET(mkReq(`${url}&format=csv`))
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    expect(csv.headers.get('content-disposition')).toMatch(/attachment/)
    expect((await csv.text())).toContain('Net payout,20.00')
    expect((await RS.GET(mkReq('/api/admin/affiliates/payout-readiness/statement?payoutId=bad'))).status).toBe(400)
    expect((await RS.GET(mkReq('/api/admin/affiliates/payout-readiness/statement?payoutId=44444444-4444-4444-8444-444444444444'))).status).toBe(404)
    await payPayout(fx.q, p.payout_id)
  })

  test('route attempts: failed then retried through the Admin route, with idempotent replay', async () => {
    const a = await mkAffiliate(fx.q)
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    const s = await mkSale(fx.q, { code: a.code }); await promote(fx.q, a.id)
    const p = await mkDraftPayout(fx.q, a.id, [s.commissionId])
    const P = '/api/admin/affiliates/payout-readiness'
    const r1 = await R.POST(post(P, { kind: 'attempt', payoutId: p.payout_id, idempotencyKey: 'press-0001-aaaa' }))
    expect(r1.status).toBe(201)
    const at1 = (await r1.json()).result
    const replay = await (await R.POST(post(P, { kind: 'attempt', payoutId: p.payout_id, idempotencyKey: 'press-0001-aaaa' }))).json()
    expect(JSON.stringify(replay)).toContain(JSON.stringify(at1.attempt_id ?? at1.id ?? at1).slice(1, 9).replace(/"/g, ''))
    expect(Number((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_payout_attempts WHERE payout_id=$1`, [p.payout_id]))[0].n)).toBe(1)
    const attemptId = (await fx.q(`SELECT id FROM affiliate_payout_attempts WHERE payout_id=$1`, [p.payout_id]))[0].id

    expect((await R.POST(post(P, { kind: 'attempt_complete', attemptId, outcome: 'maybe' }))).status).toBe(400)
    expect((await R.POST(post(P, { kind: 'attempt_complete', attemptId, outcome: 'failed', failureCode: 'bank_rejected', failureNote: 'Account closed' }))).status).toBe(200)
    expect((await fx.q(`SELECT status FROM affiliate_payouts WHERE id=$1`, [p.payout_id]))[0].status).toBe('draft') // still reserved
    const done = await R.POST(post(P, { kind: 'attempt_complete', attemptId, outcome: 'succeeded', reference: 'R1' }))
    expect(done.status).toBe(409)

    const r2 = await R.POST(post(P, { kind: 'attempt', payoutId: p.payout_id, idempotencyKey: 'press-0002-bbbb' }))
    expect(r2.status).toBe(201)
    const attempt2 = (await fx.q(`SELECT id, attempt_no FROM affiliate_payout_attempts WHERE payout_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [p.payout_id]))[0]
    expect(Number(attempt2.attempt_no)).toBe(2)
    expect((await R.POST(post(P, { kind: 'attempt_complete', attemptId: attempt2.id, outcome: 'succeeded', reference: 'WIRE-77', method: 'bank_transfer', paidAt: '2026-01-15' }))).status).toBe(200)
    expect((await fx.q(`SELECT status FROM affiliate_payouts WHERE id=$1`, [p.payout_id]))[0].status).toBe('paid')
    expect((await R.POST(post(P, { kind: 'attempt', payoutId: p.payout_id, idempotencyKey: 'press-0003-cccc' }))).status).toBe(409)
  })
})
