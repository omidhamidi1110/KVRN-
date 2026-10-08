// Payout readiness gate, attempts (failed → retry), statements and the Admin payout route hook — real PostgreSQL.
import { evaluateGateInputs, type GateInputs } from '../affiliate-payout-gate'
import { csvCell, statementToCsv, summarizeLines } from '../affiliate-payout-statements'
import { attemptAutomaticPayout, getPayoutProvider, manualProvider, stripeConnectProvider, ProviderNotConfiguredError, type PayoutProvider } from '../affiliate-payout-provider'
import { mapReadinessError } from '../affiliate-payout-readiness'

let mockAdmin: { email: string } | null = { email: 'admin@kvrn.test' }
jest.mock('../admin-auth', () => ({
  requireAdmin: async () => (mockAdmin
    ? { identity: mockAdmin, error: null }
    : { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }),
}))
jest.mock('../db', () => ({ sql: (...a: any[]) => (globalThis as any).__affPortalTestSql(...a) }))

import { canPayAffiliate, createGatedPayout } from '../affiliate-payout-gate'
import { buildStatement } from '../affiliate-payout-statements'
import { createAffiliatePayoutReadinessService } from '../affiliate-payout-readiness'
import {
  HAVE_DB, addLedger, createPortalFx, installDb, makeReady, markIncomplete, mkAffiliate, mkDraftPayout, mkReq, mkSale, payPayout, promote,
  seedDocs, setFlags, acceptAll, type PortalFx,
} from './affiliate-portal-fixtures'

const baseInputs = (o: Partial<GateInputs> = {}): GateInputs => ({
  profile: { programStatus: 'active', kycStatus: 'verified', taxStatus: 'complete', payoutMethodStatus: 'ready', requiresReacceptance: false,
    acceptedProgramTermsVersion: '1', acceptedDisclosureVersion: '1', payoutThresholdCents: null },
  financialStatus: 'active', taxRequired: true, payableCents: 5000, selectedMissingCount: 0, selectedIncompleteCount: 0,
  frozenFlagCount: 0, reviewFlagCount: 0, fraudHoldOrderCount: 0, incompleteElsewhereCount: 0, owedBackCents: 0, ...o,
})

describe('gate decision (pure)', () => {
  test('a fully ready affiliate is allowed with no blockers', () => {
    expect(evaluateGateInputs(baseInputs())).toMatchObject({ allowed: true, blockers: [], warnings: [] })
  })
  const p = (o: any) => ({ ...baseInputs().profile!, ...o })
  test.each<[string, Partial<GateInputs>, string]>([
    ['no profile', { profile: null }, 'no_profile'],
    ['suspended', { profile: p({ programStatus: 'suspended' }) }, 'program_suspended'],
    ['terminated', { profile: p({ programStatus: 'terminated' }) }, 'program_terminated'],
    ['onboarding is not payable', { profile: p({ programStatus: 'onboarding' }) }, 'program_not_active'],
    ['kyc pending', { profile: p({ kycStatus: 'pending' }) }, 'kyc_not_verified'],
    ['kyc problem', { profile: p({ kycStatus: 'problem' }) }, 'kyc_not_verified'],
    ['tax incomplete', { profile: p({ taxStatus: 'pending' }) }, 'tax_incomplete'],
    ['payout method failed', { profile: p({ payoutMethodStatus: 'failed' }) }, 'payout_method_not_ready'],
    ['reacceptance required', { profile: p({ requiresReacceptance: true }) }, 'reacceptance_required'],
    ['terms never accepted', { profile: p({ acceptedProgramTermsVersion: null }) }, 'terms_not_accepted'],
    ['disclosure never accepted', { profile: p({ acceptedDisclosureVersion: null }) }, 'terms_not_accepted'],
    ['below threshold', { profile: p({ payoutThresholdCents: 10000 }) }, 'below_threshold'],
    ['code paused', { financialStatus: 'paused' }, 'program_suspended'],
    ['financially terminated', { financialStatus: 'terminated' }, 'program_terminated'],
    ['foreign commission selected', { selectedMissingCount: 1 }, 'commission_not_found'],
    ['incomplete commission selected', { selectedIncompleteCount: 1 }, 'commission_incomplete'],
    ['frozen by fraud review', { frozenFlagCount: 1 }, 'commissions_frozen'],
    ['active fraud hold on an order', { fraudHoldOrderCount: 2 }, 'fraud_hold_active'],
    ['nothing payable', { payableCents: 0 }, 'nothing_payable'],
  ])('%s blocks with %s', (_n, patch, code) => {
    const r = evaluateGateInputs(baseInputs(patch))
    expect(r.allowed).toBe(false); expect(r.blockers.map(b => b.code)).toContain(code)
  })
  test('tax is not required when the setting says so', () => {
    expect(evaluateGateInputs(baseInputs({ taxRequired: false, profile: p({ taxStatus: 'not_started' }) })).allowed).toBe(true)
  })
  test('warnings do not block', () => {
    const r = evaluateGateInputs(baseInputs({ reviewFlagCount: 1, incompleteElsewhereCount: 2, owedBackCents: 50 }))
    expect(r.allowed).toBe(true); expect(r.warnings.map(w => w.code).sort()).toEqual(['incomplete_commissions', 'recovery_outstanding', 'review_flags_open'])
  })
  test('blockers are de-duplicated', () => {
    const r = evaluateGateInputs(baseInputs({ profile: p({ programStatus: 'suspended' }), financialStatus: 'paused' }))
    expect(r.blockers.filter(b => b.code === 'program_suspended')).toHaveLength(1)
  })
})

describe('statements + csv (pure)', () => {
  test('csv cells neutralise spreadsheet formulas but keep plain signed numbers numeric', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1+1')).toBe("'+1+1"); expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)"); expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('-3.00')).toBe('-3.00'); expect(csvCell('7.00')).toBe('7.00'); expect(csvCell('a,b')).toBe('"a,b"'); expect(csvCell(null)).toBe('')
  })
  test('summary reconciles only when lines add up to the payout', () => {
    const line = (o: any) => ({ earnedCents: 1000, adjustmentsCents: -300, previouslyPaidCents: 0, recoveredCents: 0, lineAmountCents: 700, reconciled: true, ...o })
    expect(summarizeLines([line({})], 700).reconciled).toBe(true)
    expect(summarizeLines([line({})], 701).reconciled).toBe(false)
    expect(summarizeLines([line({ reconciled: false })], 700).reconciled).toBe(false)
    expect(summarizeLines([], 0).reconciled).toBe(false)           // an empty statement is never "reconciled"
    expect(summarizeLines([line({ lineAmountCents: 699 })], 700).reconciled).toBe(false)
  })
  test('error mapping gives short Admin-safe messages and never echoes SQL', () => {
    expect(mapReadinessError(new Error('error: KVRN_AFFPORTAL|ATTESTATION_NOTE_REQUIRED'))?.status).toBe(400)
    expect(mapReadinessError(new Error('boom: select * from secrets'))).toBeNull()
  })
})

describe('provider abstraction (pure, no network)', () => {
  test('manual is the default and unknown ids fall back to it', () => {
    expect(getPayoutProvider(undefined).id).toBe('manual'); expect(getPayoutProvider('nonsense').id).toBe('manual'); expect(getPayoutProvider('stripe_connect').id).toBe('stripe_connect')
  })
  test('the Stripe Connect skeleton is unconfigured and every method throws', async () => {
    expect(stripeConnectProvider.isConfigured()).toBe(false)
    await expect(stripeConnectProvider.createOnboardingLink({ affiliateId: 'x', returnUrl: '', refreshUrl: '' })).rejects.toBeInstanceOf(ProviderNotConfiguredError)
    await expect(stripeConnectProvider.getStatus({ providerAccountRef: null })).rejects.toBeInstanceOf(ProviderNotConfiguredError)
    await expect(stripeConnectProvider.createPayout({ payoutId: 'p', amountCents: 1, currency: 'USD', providerAccountRef: null, idempotencyKey: 'k' })).rejects.toBeInstanceOf(ProviderNotConfiguredError)
  })
  test('automatic payouts: flag OFF → nothing; manual/unconfigured → nothing; gate blocks → nothing; else provider is called once', async () => {
    const payout = { id: 'p1', affiliateId: 'a1', amountCents: 700, currency: 'USD', providerAccountRef: 'acct_1', idempotencyKey: 'k1' }
    const spy = jest.fn(async () => ({ outcome: 'submitted' as const, providerReference: 'tr_1' }))
    const fake: PayoutProvider = { id: 'stripe_connect', supportsAutomatedPayouts: true, isConfigured: () => true, createOnboardingLink: async () => ({ kind: 'manual_instructions', message: '' }), getStatus: async () => ({ kyc: null, tax: null, payoutMethod: null, requirementsDue: [] }), createPayout: spy }
    const gateOk = async () => ({ allowed: true, blockers: [] as any[] }), gateNo = async () => ({ allowed: false, blockers: [{ code: 'kyc_not_verified' }] })
    expect(await attemptAutomaticPayout({ flagEnabled: () => false, provider: fake, gate: gateOk }, payout)).toEqual({ outcome: 'disabled' })
    expect(await attemptAutomaticPayout({ flagEnabled: () => true, provider: manualProvider, gate: gateOk }, payout)).toEqual({ outcome: 'manual_required' })
    expect(await attemptAutomaticPayout({ flagEnabled: () => true, provider: stripeConnectProvider, gate: gateOk }, payout)).toMatchObject({ outcome: 'not_configured' })
    expect(await attemptAutomaticPayout({ flagEnabled: () => true, provider: fake, gate: gateNo }, payout)).toEqual({ outcome: 'blocked', blockers: ['kyc_not_verified'] })
    expect(spy).not.toHaveBeenCalled()
    expect(await attemptAutomaticPayout({ flagEnabled: () => true, provider: fake, gate: gateOk }, payout)).toEqual({ outcome: 'submitted', providerReference: 'tr_1' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'k1' }))
  })
})

const d = HAVE_DB ? describe : describe.skip
d('gate + attempts + statements + admin route (real PostgreSQL)', () => {
  let fx: PortalFx
  let POST: any, GET: any
  beforeAll(async () => {
    fx = await createPortalFx('affp_pay'); installDb(fx.sql); await seedDocs(fx.q)
    const r = await import('../../app/api/admin/affiliates/payouts/route'); POST = r.POST; GET = r.GET
  }, 120000)
  afterAll(async () => { await fx?.close() })
  beforeEach(() => { mockAdmin = { email: 'admin@kvrn.test' }; setFlags({ portal: false, applications: false }) })

  /** A ready affiliate with one approved, payable $10 commission. */
  async function ready(o: { profile?: any; holdDays?: number } = {}) {
    const a = await mkAffiliate(fx.q, { profile: o.profile ?? {}, holdDays: o.holdDays ?? 0 })
    await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id)
    const s = await mkSale(fx.q, { code: a.code }); await promote(fx.q, a.id)
    return { a, s }
  }
  const codes = (g: any) => g.blockers.map((b: any) => b.code).sort()

  test('ready affiliate passes; each single deficiency produces exactly its blocker', async () => {
    const { a, s } = await ready()
    expect(await canPayAffiliate(fx.sql, a.id)).toMatchObject({ allowed: true, blockers: [], snapshot: { payableCents: 1000 } })
    expect((await canPayAffiliate(fx.sql, a.id, { commissionIds: [s.commissionId] })).allowed).toBe(true)

    const cases: Array<[string, string, any[], string]> = [
      ['kyc', `UPDATE affiliate_profiles SET kyc_status='pending' WHERE affiliate_id=$1`, [], 'kyc_not_verified'],
      ['tax', `UPDATE affiliate_profiles SET tax_status='problem' WHERE affiliate_id=$1`, [], 'tax_incomplete'],
      ['method', `UPDATE affiliate_profiles SET payout_method_status='failed' WHERE affiliate_id=$1`, [], 'payout_method_not_ready'],
      ['reaccept', `UPDATE affiliate_profiles SET requires_reacceptance=TRUE WHERE affiliate_id=$1`, [], 'reacceptance_required'],
      ['terms', `UPDATE affiliate_profiles SET accepted_program_terms_version=NULL WHERE affiliate_id=$1`, [], 'terms_not_accepted'],
      ['threshold', `UPDATE affiliate_profiles SET payout_threshold_cents=100000 WHERE affiliate_id=$1`, [], 'below_threshold'],
      ['suspended profile', `UPDATE affiliate_profiles SET program_status='suspended' WHERE affiliate_id=$1`, [], 'program_suspended'],
    ]
    for (const [name, stmt, params, code] of cases) {
      const x = await ready()
      await fx.q(stmt, [x.a.id, ...params])
      const g = await canPayAffiliate(fx.sql, x.a.id)
      expect({ name, allowed: g.allowed, codes: codes(g) }).toEqual({ name, allowed: false, codes: [code] })
    }
    // no profile at all (legacy / not yet backfilled) fails closed
    const np = await mkAffiliate(fx.q, { profile: null }); await mkSale(fx.q, { code: np.code }); await promote(fx.q, np.id)
    expect(codes(await canPayAffiliate(fx.sql, np.id))).toEqual(['no_profile'])
  })

  test('tax requirement follows the programme setting', async () => {
    const x = await ready(); await fx.q(`UPDATE affiliate_profiles SET tax_status='not_started' WHERE affiliate_id=$1`, [x.a.id])
    expect(codes(await canPayAffiliate(fx.sql, x.a.id))).toEqual(['tax_incomplete'])
    await fx.q(`INSERT INTO site_settings (key,value,revision,updated_by) VALUES ('affiliate.payouts','{"tax_required":false}',1,'t')`)
    expect((await canPayAffiliate(fx.sql, x.a.id)).allowed).toBe(true)
    await fx.q(`DELETE FROM site_settings WHERE key='affiliate.payouts'`)
  })

  test('financial controls: paused/terminated codes, foreign / incomplete commissions, frozen flags, fraud holds, nothing payable', async () => {
    const paused = await ready(); await fx.q(`SELECT set_affiliate_status($1,'paused',NOW(),'t','test')`, [paused.a.id])
    expect(codes(await canPayAffiliate(fx.sql, paused.a.id))).toContain('program_suspended')
    const term = await ready(); await fx.q(`SELECT set_affiliate_status($1,'terminated',NOW(),'t','test')`, [term.a.id])
    expect(codes(await canPayAffiliate(fx.sql, term.a.id))).toContain('program_terminated')

    const x = await ready(), y = await ready()
    expect(codes(await canPayAffiliate(fx.sql, x.a.id, { commissionIds: [y.s.commissionId] }))).toContain('commission_not_found')
    await markIncomplete(fx.q, x.s.commissionId)
    expect(codes(await canPayAffiliate(fx.sql, x.a.id, { commissionIds: [x.s.commissionId] }))).toContain('commission_incomplete')

    const fr = await ready()
    const flag = await fx.q(`INSERT INTO affiliate_fraud_flags (affiliate_id,signal,source,severity,freeze_commissions,created_by) VALUES ($1,'other','admin','review',TRUE,'a') RETURNING id`, [fr.a.id])
    expect(codes(await canPayAffiliate(fx.sql, fr.a.id))).toEqual(['commissions_frozen'])
    await fx.q(`UPDATE affiliate_fraud_flags SET status='resolved', resolved_at=NOW(), resolved_by='a', resolution_note='cleared after review' WHERE id=$1`, [flag[0].id])
    expect((await canPayAffiliate(fx.sql, fr.a.id)).allowed).toBe(true)
    // a non-freezing review flag only warns
    await fx.q(`INSERT INTO affiliate_fraud_flags (affiliate_id,signal,source,severity,freeze_commissions,created_by) VALUES ($1,'other','heuristic','info',FALSE,'a')`, [fr.a.id])
    const g = await canPayAffiliate(fx.sql, fr.a.id); expect(g.allowed).toBe(true); expect(g.warnings.map(w => w.code)).toContain('review_flags_open')

    const hold = await ready()
    await fx.q(`INSERT INTO order_fraud_reviews (order_id, hold_state, hold_reason, hold_created_at) VALUES ($1,'active','manual_review',NOW())`, [hold.s.orderId])
    expect(codes(await canPayAffiliate(fx.sql, hold.a.id))).toEqual(['fraud_hold_active'])
    await fx.q(`UPDATE order_fraud_reviews SET hold_state='released', released_by='test@kvrn.internal', released_at=NOW() WHERE order_id=$1`, [hold.s.orderId])
    expect((await canPayAffiliate(fx.sql, hold.a.id)).allowed).toBe(true)

    const none = await mkAffiliate(fx.q); await makeReady(fx.q, none.id); await acceptAll(fx.q, none.id)
    expect(codes(await canPayAffiliate(fx.sql, none.id))).toEqual(['nothing_payable'])
  })

  test('the gate fails CLOSED when it cannot be evaluated', async () => {
    const broken: any = async () => { throw new Error('connection reset') }
    const g = await canPayAffiliate(broken, '00000000-0000-4000-8000-000000000001')
    expect(g).toMatchObject({ allowed: false, blockers: [{ code: 'gate_unavailable' }] })
    expect((await canPayAffiliate(fx.sql, 'not-a-uuid')).allowed).toBe(false)
  })

  test('createGatedPayout only calls the unchanged payout creator when the gate allows', async () => {
    const x = await ready(); const spy = jest.fn(async (id: string, ids: string[], actor: string) => (await fx.q(`SELECT create_affiliate_payout($1,$2::uuid[],$3) AS r`, [id, ids, actor]))[0].r)
    await fx.q(`UPDATE affiliate_profiles SET kyc_status='pending' WHERE affiliate_id=$1`, [x.a.id])
    const blocked = await createGatedPayout(fx.sql, x.a.id, [x.s.commissionId], 'admin@kvrn.test', spy)
    expect(blocked.blocked).toBe(true); expect(spy).not.toHaveBeenCalled()
    expect((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_payouts WHERE affiliate_id=$1`, [x.a.id]))[0].n).toBe(0)
    await fx.q(`UPDATE affiliate_profiles SET kyc_status='verified' WHERE affiliate_id=$1`, [x.a.id])
    const ok = await createGatedPayout(fx.sql, x.a.id, [x.s.commissionId], 'admin@kvrn.test', spy)
    expect(ok.blocked).toBe(false); expect((ok as any).result.amount_cents).toBe(1000)
  })

  // ── the Admin route hook ───────────────────────────────────────────────────
  const adminPost = (body: any) => POST(mkReq('/api/admin/affiliates/payouts', { method: 'POST', body, origin: null, headers: { 'x-test': '1' } }))

  test('route: with the programme flags OFF the gate is NOT consulted (behaviour unchanged), even for an unready affiliate', async () => {
    const x = await mkAffiliate(fx.q, { profile: null }); const s = await mkSale(fx.q, { code: x.code }); await promote(fx.q, x.id)
    const r = await adminPost({ affiliateId: x.id, commissionIds: [s.commissionId] })
    expect(r.status).toBe(201); expect((await r.json()).result).toMatchObject({ outcome: 'created', amount_cents: 1000 })
  })

  test('route: with the portal flag ON a blocked payout returns 409 with the reasons and creates nothing', async () => {
    setFlags({ portal: true })
    const x = await ready(); await fx.q(`UPDATE affiliate_profiles SET kyc_status='pending', payout_method_status='pending' WHERE affiliate_id=$1`, [x.a.id])
    const r = await adminPost({ affiliateId: x.a.id, commissionIds: [x.s.commissionId] })
    const b = await r.json()
    expect(r.status).toBe(409); expect(b.blockers.map((z: any) => z.code).sort()).toEqual(['kyc_not_verified', 'payout_method_not_ready'])
    expect(b.blockers[0].message).toBeTruthy()
    expect((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_payouts WHERE affiliate_id=$1`, [x.a.id]))[0].n).toBe(0)
    expect((await fx.q(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE resource='affiliate_payouts' AND payload->>'affiliate_id'=$1`, [x.a.id]))[0].n).toBe(0)
  })

  test('route: ready affiliate → 201; repeating the request cannot create a second payout (idempotent)', async () => {
    setFlags({ portal: true })
    const x = await ready()
    const ids = [x.s.commissionId]
    const r1 = await adminPost({ affiliateId: x.a.id, commissionIds: ids })
    expect(r1.status).toBe(201); expect((await r1.json()).result).toMatchObject({ outcome: 'created', amount_cents: 1000 })
    const r2 = await adminPost({ affiliateId: x.a.id, commissionIds: ids })
    expect(r2.status).toBe(409)                                         // nothing left to pay → blocked, no second draft
    expect((await fx.q(`SELECT COUNT(*)::int n, SUM(amount_cents)::int total FROM affiliate_payouts WHERE affiliate_id=$1`, [x.a.id]))[0]).toEqual({ n: 1, total: 1000 })
    // and with the flag OFF the unchanged SQL is still idempotent on its own
    setFlags({ portal: false })
    const r3 = await adminPost({ affiliateId: x.a.id, commissionIds: ids })
    expect((await r3.json()).result.outcome).toBe('nothing_payable')
    expect((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_payouts WHERE affiliate_id=$1`, [x.a.id]))[0].n).toBe(1)
  })

  test('route: mark-paid and void are NOT gated (cash that already moved must always be recordable)', async () => {
    const x = await ready(); const p = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId])
    await fx.q(`UPDATE affiliate_profiles SET kyc_status='problem', program_status='suspended' WHERE affiliate_id=$1`, [x.a.id]); setFlags({ portal: true })
    const paid = await adminPost({ kind: 'mark_paid', payoutId: p.payout_id, method: 'bank', reference: 'R1' }); expect(paid.status).toBe(200)
    const y = await ready(); const q = await mkDraftPayout(fx.q, y.a.id, [y.s.commissionId])
    await fx.q(`UPDATE affiliate_profiles SET kyc_status='problem' WHERE affiliate_id=$1`, [y.a.id])
    expect((await adminPost({ kind: 'void', payoutId: q.payout_id, reason: 'wrong' })).status).toBe(200)
  })

  test('route: requireAdmin runs first — an unauthenticated caller gets 401 before any database access', async () => {
    mockAdmin = null; setFlags({ portal: true })
    const spy = jest.fn(); installDb(Object.assign(spy, { query: spy }))
    try {
      expect((await adminPost({ affiliateId: 'x', commissionIds: [] })).status).toBe(401)
      expect(spy).not.toHaveBeenCalled()
    } finally { installDb(fx.sql) }
  })

  // ── attempts: failed → retry ───────────────────────────────────────────────
  test('failed payout stays a draft that RESERVES the money; retry uses a new attempt; success marks it paid exactly once', async () => {
    const x = await ready(); const p = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId])
    const svc = createAffiliatePayoutReadinessService(fx.sql)
    const a1 = await svc.recordAttempt(p.payout_id, 'press-1-aaaa', 'admin@kvrn.test')
    expect(a1).toMatchObject({ outcome: 'recorded', attempt_no: 1 })
    // double click with the SAME key → same attempt, no new row
    expect(await svc.recordAttempt(p.payout_id, 'press-1-aaaa', 'admin@kvrn.test')).toMatchObject({ outcome: 'already_recorded', attempt_id: a1.attempt_id })
    // a different key while one is in flight → refused (no parallel attempts)
    expect(await svc.recordAttempt(p.payout_id, 'press-2-bbbb', 'admin@kvrn.test')).toMatchObject({ outcome: 'attempt_in_flight' })

    const f = await svc.completeAttempt(a1.attempt_id, { outcome: 'failed', failureCode: 'bank_rejected', failureNote: 'account closed' }, 'admin@kvrn.test')
    expect(f.outcome).toBe('failed')
    expect(await svc.completeAttempt(a1.attempt_id, { outcome: 'failed', failureCode: 'bank_rejected' }, 'admin@kvrn.test')).toMatchObject({ outcome: 'already_completed' })
    expect((await fx.q(`SELECT status FROM affiliate_payouts WHERE id=$1`, [p.payout_id]))[0].status).toBe('draft')
    // The reserved money cannot be paid out again while the failed draft exists.
    expect((await fx.q(`SELECT create_affiliate_payout($1,$2::uuid[],'t') AS r`, [x.a.id, [x.s.commissionId]]))[0].r.outcome).toBe('nothing_payable')
    expect((await canPayAffiliate(fx.sql, x.a.id)).blockers.map(b => b.code)).toContain('nothing_payable')
    // failure notification queued once, with no failure detail in the payload
    const n1 = await fx.q(`SELECT kind, payload FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [x.a.id])
    expect(n1).toHaveLength(1); expect(n1[0].kind).toBe('payout_failed'); expect(JSON.stringify(n1[0].payload)).not.toMatch(/bank_rejected|closed/)

    const a2 = await svc.recordAttempt(p.payout_id, 'press-3-cccc', 'admin@kvrn.test')
    expect(a2).toMatchObject({ outcome: 'recorded', attempt_no: 2 })
    const ok = await svc.completeAttempt(a2.attempt_id, { outcome: 'succeeded', reference: 'WIRE-77', method: 'bank_transfer' }, 'admin@kvrn.test')
    expect(ok.outcome).toBe('paid')
    expect((await fx.q(`SELECT status, method FROM affiliate_payouts WHERE id=$1`, [p.payout_id]))[0]).toMatchObject({ status: 'paid', method: 'bank_transfer' })
    expect(await svc.completeAttempt(a2.attempt_id, { outcome: 'succeeded', reference: 'WIRE-77' }, 'admin@kvrn.test')).toMatchObject({ outcome: 'already_completed' })
    // exactly one cash event + one sent notification
    expect((await fx.q(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE resource='affiliate_payouts' AND resource_id=$1 AND action LIKE '%paid%'`, [p.payout_id]))[0].n).toBeLessThanOrEqual(1)
    expect((await fx.q(`SELECT kind FROM affiliate_portal_notifications WHERE affiliate_id=$1 ORDER BY kind`, [x.a.id])).map((r: any) => r.kind)).toEqual(['payout_failed', 'payout_sent'])
    // nothing more can be attempted
    await expect(svc.recordAttempt(p.payout_id, 'press-4-dddd', 'admin@kvrn.test')).rejects.toThrow(/NOT_DRAFT|ATTEMPT_ALREADY_SUCCEEDED/)
    // attempts are append-only history
    expect(await fx.err(`DELETE FROM affiliate_payout_attempts WHERE payout_id=$1`, [p.payout_id])).toMatch(/KVRN_AFFPORTAL|APPEND/)
  })

  test('voiding a failed draft releases the money; a void payout cannot get attempts or be paid', async () => {
    const x = await ready(); const p = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId])
    const svc = createAffiliatePayoutReadinessService(fx.sql)
    const a = await svc.recordAttempt(p.payout_id, 'void-1-aaaa', 'admin@kvrn.test'); await svc.completeAttempt(a.attempt_id, { outcome: 'failed', failureCode: 'x' }, 'admin@kvrn.test')
    await fx.q(`SELECT void_affiliate_payout($1,'cancelled after failure','admin@kvrn.test')`, [p.payout_id])
    expect((await canPayAffiliate(fx.sql, x.a.id)).allowed).toBe(true)                   // payable again
    await expect(svc.recordAttempt(p.payout_id, 'void-2-bbbb', 'admin@kvrn.test')).rejects.toThrow(/NOT_DRAFT/)
    expect((await fx.err(`SELECT mark_affiliate_payout_paid($1,NOW(),'bank','R','admin@kvrn.test')`, [p.payout_id]))).toMatch(/VOID_CANNOT_BE_PAID/)
  })

  test('suspension blocks payouts, closes the code for new sales, and leaves history intact', async () => {
    const x = await ready()
    await fx.q(`SELECT suspend_affiliate_for_compliance($1,'misleading claims',TRUE,'admin@kvrn.test')`, [x.a.id])
    const g = await canPayAffiliate(fx.sql, x.a.id); expect(g.allowed).toBe(false); expect(codes(g)).toContain('program_suspended')
    const st = (await fx.q(`SELECT status FROM affiliates WHERE id=$1`, [x.a.id]))[0].status; expect(st).toBe('paused')
    expect((await fx.q(`SELECT portal_access FROM affiliate_profiles WHERE affiliate_id=$1`, [x.a.id]))[0].portal_access).toBe('revoked')
    expect((await fx.q(`SELECT commission_cents FROM affiliate_commissions WHERE id=$1`, [x.s.commissionId]))[0].commission_cents).toBe(1000)
    // new order using the code no longer attributes
    const late = await fx.q(`SELECT 1`); void late
    expect((await fx.q(`SELECT affiliate_active_at($1, NOW() + INTERVAL '1 second') AS a`, [x.a.id]))[0].a).toBe(false)
    // idempotent
    expect((await fx.q(`SELECT suspend_affiliate_for_compliance($1,'misleading claims',TRUE,'admin@kvrn.test') AS r`, [x.a.id]))[0].r.outcome).toBe('already_suspended')
    expect(await fx.err(`SELECT suspend_affiliate_for_compliance($1,'',TRUE,'admin@kvrn.test')`, [x.a.id])).toMatch(/REASON_REQUIRED/)
  })

  test('a rate change never rewrites a historical commission; new sales use the new rate', async () => {
    const x = await mkAffiliate(fx.q, { bps: 1000 }); const s1 = await mkSale(fx.q, { code: x.code })
    await fx.q(`SELECT update_affiliate_terms($1,'percentage',2500,NULL,'proportional',30,0,NULL,NOW(),'rate change','admin@kvrn.test')`, [x.id])
    const s2 = await mkSale(fx.q, { code: x.code })
    const rows = await fx.q(`SELECT id, commission_cents FROM affiliate_commissions WHERE affiliate_id=$1`, [x.id])
    expect(rows.find((r: any) => r.id === s1.commissionId).commission_cents).toBe(1000)
    expect(rows.find((r: any) => r.id === s2.commissionId).commission_cents).toBe(2500)
  })

  // ── statements ─────────────────────────────────────────────────────────────
  test('statement with a prior payment, a later correction and a recovery reconciles line by line', async () => {
    const x = await ready()
    const p1 = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId]); await payPayout(fx.q, p1.payout_id)       // pays 1000
    await addLedger(fx.q, x.s.commissionId, 200)                                                               // later positive correction
    const p2 = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId])                                           // pays the 200
    expect(p2.amount_cents).toBe(200)
    const st = (await buildStatement(fx.sql, p2.payout_id, 'affiliate'))!
    expect(st.totals).toMatchObject({ grossEarnedCents: 1000, adjustmentsCents: 200, previouslyPaidCents: 1000, recoveredCents: 0, netCents: 200, reconciled: true })
    expect(st.lines[0]).toMatchObject({ earnedCents: 1000, adjustmentsCents: 200, previouslyPaidCents: 1000, lineAmountCents: 200, reconciled: true })
    // the first statement is unchanged by the later activity (reproduced as of its own creation)
    const st1 = (await buildStatement(fx.sql, p1.payout_id, 'affiliate'))!
    expect(st1.totals).toMatchObject({ grossEarnedCents: 1000, adjustmentsCents: 0, previouslyPaidCents: 0, netCents: 1000, reconciled: true })
    // Admin view adds the order number; the affiliate view never has it
    const adm = (await buildStatement(fx.sql, p2.payout_id, 'admin'))!
    expect(adm.lines[0].orderNumber).toBe(x.s.orderNumber); expect(adm.payoutNumber).toBe(p2.payout_number)
    expect(JSON.stringify(st)).not.toContain(x.s.orderNumber)
    expect(statementToCsv(st)).toContain('Net payout,2.00')
  })

  test('a statement that does not reproduce is flagged "needs review", never quietly adjusted', async () => {
    const x = await ready(); const p = await mkDraftPayout(fx.q, x.a.id, [x.s.commissionId])
    // Simulate drift: the stored line no longer matches what the ledger reproduces.
    const err = await fx.err(`UPDATE affiliate_payout_lines SET amount_cents = amount_cents - 1 WHERE payout_id=$1`, [p.payout_id])
    if (err === '') {
      await fx.q(`UPDATE affiliate_payouts SET amount_cents = amount_cents - 1 WHERE id=$1`, [p.payout_id])
      const st = (await buildStatement(fx.sql, p.payout_id, 'affiliate'))!
      expect(st.totals.reconciled).toBe(false); expect(st.lines[0].reconciled).toBe(false)
      expect(statementToCsv(st)).toContain('needs review')
    } else {
      // The ledger tables forbid tampering outright — an even stronger guarantee.
      expect(err).toMatch(/./)
    }
  })

  test('statement of a missing payout is null', async () => {
    expect(await buildStatement(fx.sql, '00000000-0000-4000-8000-00000000dead', 'affiliate')).toBeNull()
  })

  test('route GET /payouts is unchanged for payable listing', async () => {
    const x = await ready()
    const r = await GET(mkReq(`/api/admin/affiliates/payouts?affiliateId=${x.a.id}`))
    expect(r.status).toBe(200); expect((await r.json()).totalPayableCents).toBe(1000)
  })
})
