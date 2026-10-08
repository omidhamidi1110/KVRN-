// Portal read-model + HTTP handlers against real PostgreSQL: own-data-only (IDOR), privacy payload scans with real
// seeded PII, unknown-is-never-zero, statements that reconcile, limited self-service writes.
import { collectKeys, FORBIDDEN_PORTAL_KEY_PATTERNS, assertPortalPayloadSafe, PortalPrivacyError } from '../affiliate-portal-privacy'
import { formatCents } from '../affiliate-portal-ui'

jest.mock('../db', () => ({ sql: (...a: any[]) => (globalThis as any).__affPortalTestSql(...a) }))

import {
  HAVE_DB, ORIGIN, PII, addLedger, createPortalFx, installDb, loginAs, markIncomplete, mkAffiliate, mkDraftPayout, mkReq, mkSale,
  payPayout, promote, seedDocs, sessionReq, setFlags, type PortalFx,
} from './affiliate-portal-fixtures'

describe('privacy scanner (pure)', () => {
  test('rejects forbidden keys at any depth, and every pattern is exercised', () => {
    const bad = ['customerEmail', 'phone', 'shipping_address', 'billing', 'paymentMethod', 'stripeId', 'fraudScore', 'riskLevel', 'radar', 'supportNotes',
      'internalNote', 'note', 'cogs', 'profit', 'margin', 'orderId', 'order_number', 'orderRef', 'ipHash', 'token', 'secret', 'password', 'otherAffiliate', 'affiliateId', 'companyRevenue', 'email']
    for (const k of bad) {
      expect(() => assertPortalPayloadSafe({ ok: 1, nested: [{ deep: { [k]: 1 } }] })).toThrow(PortalPrivacyError)
    }
    expect(() => assertPortalPayloadSafe({ ref: 'S-ABCDEF0123', date: 'x', netSaleCents: 1, commissionCents: 2, status: 'paid' })).not.toThrow()
    expect(FORBIDDEN_PORTAL_KEY_PATTERNS.length).toBeGreaterThan(20)
  })
  test('unknown money is a dash, never $0.00', () => {
    expect(formatCents(null)).toBe('—'); expect(formatCents(undefined)).toBe('—'); expect(formatCents(NaN)).toBe('—')
    expect(formatCents(0)).toBe('$0.00'); expect(formatCents(123456)).toBe('$1,234.56'); expect(formatCents(-250)).toBe('-$2.50')
  })
})

const d = HAVE_DB ? describe : describe.skip
d('portal API (real PostgreSQL, real handlers)', () => {
  let fx: PortalFx
  const h: Record<string, any> = {}
  let A: any, B: any, sA: any, sB: any, saleA1: any, saleA2: any, saleB1: any, payoutA: any, payoutB: any

  beforeAll(async () => {
    fx = await createPortalFx('affp_api'); installDb(fx.sql); await seedDocs(fx.q)
    const imp = async (p: string) => import(`../../app/api/affiliate/${p}/route`)
    h.me = (await imp('me')).GET; h.overview = (await imp('overview')).GET; h.commissions = (await imp('commissions')).GET
    h.payouts = (await imp('payouts')).GET; h.statement = (await imp('payouts/[ref]/statement')).GET
    h.onboarding = (await imp('onboarding')).GET; h.accept = (await imp('onboarding/accept')).POST
    const prof = await imp('profile'); h.profileGET = prof.GET; h.profilePATCH = prof.PATCH
    h.doc = (await imp('documents/[docType]')).GET
    const ps = await imp('payout-setup'); h.setupGET = ps.GET; h.setupPOST = ps.POST

    A = await mkAffiliate(fx.q, { code: 'ALPHA1', email: 'alpha@portal.test', name: 'Alpha Affiliate', profile: { display_name: 'Alpha' } })
    B = await mkAffiliate(fx.q, { code: 'BRAVO2', email: 'bravo@portal.test', name: 'Bravo Secret Co' })
    saleA1 = await mkSale(fx.q, { code: A.code, subtotalCents: 10000 })
    saleA2 = await mkSale(fx.q, { code: A.code, subtotalCents: 5000, daysAgo: 3 })
    saleB1 = await mkSale(fx.q, { code: B.code, subtotalCents: 20000 })
    await promote(fx.q, A.id); await promote(fx.q, B.id)
    await addLedger(fx.q, saleA1.commissionId, -300)
    payoutA = await mkDraftPayout(fx.q, A.id, [saleA1.commissionId])           // 1000 - 300 = 700
    await payPayout(fx.q, payoutA.payout_id)
    payoutB = await mkDraftPayout(fx.q, B.id, [saleB1.commissionId])
    sA = await loginAs(fx.sql, A.email, '10.30.0.1'); sB = await loginAs(fx.sql, B.email, '10.30.0.2')
  }, 120000)
  afterAll(async () => { await fx?.close() })
  beforeEach(() => { setFlags({ portal: true }); process.env.SITE_URL = ORIGIN })
  afterEach(() => setFlags({ portal: false }))

  const get = async (name: string, s: any, path: string, ctx?: any) => {
    const r = await h[name](sessionReq(path, s), ctx)
    const text = await r.text()
    let body: any = null; try { body = JSON.parse(text) } catch { /* csv */ }
    return { status: r.status, body, text, headers: r.headers }
  }
  const refOf = async (commissionId: string) => (await fx.q(`SELECT ref FROM affiliate_public_refs WHERE kind='sale' AND source_id=$1`, [commissionId]))[0]?.ref as string
  const payoutRef = async (id: string) => (await fx.q(`SELECT affiliate_public_ref('payout',p.id,p.affiliate_id) AS r FROM affiliate_payouts p WHERE p.id=$1`, [id]))[0].r as string

  test('every endpoint rejects a missing session and is no-store', async () => {
    for (const [n, p] of [['me', '/api/affiliate/me'], ['overview', '/api/affiliate/overview'], ['commissions', '/api/affiliate/commissions'], ['payouts', '/api/affiliate/payouts'],
      ['onboarding', '/api/affiliate/onboarding'], ['profileGET', '/api/affiliate/profile'], ['setupGET', '/api/affiliate/payout-setup']] as const) {
      const r = await h[n](mkReq(p)); expect(r.status).toBe(401)
    }
    expect((await h.doc(mkReq('/api/affiliate/documents/program_terms'), { params: Promise.resolve({ docType: 'program_terms' }) })).status).toBe(401)
    expect((await h.statement(mkReq('/api/affiliate/payouts/P-AAAAAAAAAA/statement'), { params: Promise.resolve({ ref: 'P-AAAAAAAAAA' }) })).status).toBe(401)
    const ok = await get('overview', sA, '/api/affiliate/overview'); expect(ok.headers.get('cache-control')).toBe('no-store')
  })

  test('with the portal flag OFF every endpoint is 404 even for a valid session', async () => {
    setFlags({ portal: false })
    for (const [n, p] of [['me', '/api/affiliate/me'], ['overview', '/api/affiliate/overview'], ['commissions', '/api/affiliate/commissions'], ['payouts', '/api/affiliate/payouts'], ['onboarding', '/api/affiliate/onboarding'], ['profileGET', '/api/affiliate/profile']] as const) {
      expect((await get(n, sA, p)).status).toBe(404)
    }
  })

  test('overview shows the affiliate\'s own numbers from the ledger (no new money math)', async () => {
    const r = await get('overview', sA, '/api/affiliate/overview?range=all')
    expect(r.status).toBe(200)
    const { summary, balances, performance } = r.body
    expect(summary).toMatchObject({ code: 'ALPHA1', name: 'Alpha', commissionRule: { type: 'percentage', rateBps: 1000 }, holdDays: 0, codeLive: true })
    // earned 1000+500, a -300 correction, 700 paid, 500 available.
    expect(balances).toMatchObject({ earnedCents: 1500, paidCents: 700, availableCents: 500, inPayoutCents: 0, unresolvedCount: 0 })
    expect(performance).toMatchObject({ attributedOrders: 2, grossReferredSalesCents: 15000, netIsPartial: false })
    // A different affiliate gets different numbers
    const rb = await get('overview', sB, '/api/affiliate/overview?range=all')
    expect(rb.body.summary.code).toBe('BRAVO2'); expect(rb.body.balances.inPayoutCents).toBe(2000); expect(rb.body.balances.paidCents).toBe(0)
  })

  test('commissions: own sales only, minimal fields, non-reversible refs, and a ledger correction is visible', async () => {
    const r = await get('commissions', sA, '/api/affiliate/commissions')
    expect(r.body.sales).toHaveLength(2)
    const keys = new Set(r.body.sales.flatMap((s: any) => Object.keys(s)))
    expect([...keys].sort()).toEqual(['attributableSaleCents', 'commissionCents', 'date', 'items', 'netCommissionCents', 'netSaleCents', 'ref', 'reversalStatus', 'status'])
    const s1 = r.body.sales.find((s: any) => s.commissionCents === 1000)
    expect(s1).toMatchObject({ netCommissionCents: 700, status: 'paid', reversalStatus: 'partial', attributableSaleCents: 10000 })
    expect(s1.ref).toBe(await refOf(saleA1.commissionId))
    expect(s1.ref).toMatch(/^S-[0-9A-F]{10}$/)
    expect(s1.items).toBe('Heavyweight Hoodie · Black · M')
    const s2 = r.body.sales.find((s: any) => s.commissionCents === 500)
    expect(s2).toMatchObject({ status: 'available', reversalStatus: 'none' })
    expect(r.body.sales.map((s: any) => s.ref)).not.toContain(await refOf(saleB1.commissionId))
  })

  test('pagination is bounded and cannot be used to read past your own rows', async () => {
    const r = await get('commissions', sA, '/api/affiliate/commissions?limit=1')
    expect(r.body.sales).toHaveLength(1); expect(r.body.hasMore).toBe(true)
    const huge = await get('commissions', sA, '/api/affiliate/commissions?limit=100000&offset=-5')
    expect(huge.body.sales.length).toBe(2)
    const past = await get('commissions', sA, '/api/affiliate/commissions?offset=50')
    expect(past.body.sales).toEqual([])
  })

  test('PRIVACY: no endpoint payload contains a forbidden key or any seeded customer / other-affiliate value', async () => {
    const stRef = await payoutRef(payoutA.payout_id)
    const docs = ['program_terms', 'disclosure_policy', 'brand_rules']
    const payloads: Array<[string, string]> = []
    for (const [n, p] of [['me', '/api/affiliate/me'], ['overview', '/api/affiliate/overview?range=all'], ['commissions', '/api/affiliate/commissions'], ['payouts', '/api/affiliate/payouts'],
      ['onboarding', '/api/affiliate/onboarding'], ['profileGET', '/api/affiliate/profile'], ['setupGET', '/api/affiliate/payout-setup']] as const) {
      const r = await get(n, sA, p); expect(r.status).toBe(200)
      expect(() => assertPortalPayloadSafe(r.body)).not.toThrow()
      payloads.push([n, r.text])
    }
    for (const t of docs) { const r = await get('doc', sA, `/api/affiliate/documents/${t}`, { params: Promise.resolve({ docType: t }) }); expect(r.status).toBe(200); payloads.push([t, r.text]) }
    const st = await get('statement', sA, `/api/affiliate/payouts/${stRef}/statement`, { params: Promise.resolve({ ref: stRef }) })
    expect(st.status).toBe(200); expect(() => assertPortalPayloadSafe(st.body)).not.toThrow(); payloads.push(['statement', st.text])
    const csv = await get('statement', sA, `/api/affiliate/payouts/${stRef}/statement?format=csv`, { params: Promise.resolve({ ref: stRef }) })
    expect(csv.status).toBe(200); payloads.push(['csv', csv.text])

    const secrets = [PII.email, PII.name, PII.phone, PII.street, PII.city, PII.stripePi, PII.stripeSession, 'pi_PIIMARKER', 'cs_PIIMARKER',
      saleA1.orderNumber, saleA2.orderNumber, saleB1.orderNumber, saleA1.orderId, saleA2.orderId, saleB1.orderId, saleA1.commissionId, saleA2.commissionId, payoutA.payout_id, payoutA.payout_number,
      B.id, B.code, B.email, 'Bravo Secret', saleB1.commissionId, payoutB.payout_id, payoutB.payout_number, A.id, saleA1.attributionId]
    for (const [name, text] of payloads) {
      for (const s of secrets) expect({ name, leaked: text.includes(s) ? s : null }).toEqual({ name, leaked: null })
      const keys = collectKeys(JSON.parse(text.startsWith('{') ? text : '{}'))
      for (const k of keys) for (const re of FORBIDDEN_PORTAL_KEY_PATTERNS) expect({ name, k, bad: re.test(k) }).toEqual({ name, k, bad: false })
    }
  })

  test('IDOR: ids and affiliate selectors in the URL, query or body are never honoured', async () => {
    // Query-string affiliate selectors are ignored.
    for (const q of [`affiliateId=${B.id}`, `affiliate_id=${B.id}`, `code=BRAVO2`, `id=${B.id}`]) {
      const o = await get('overview', sA, `/api/affiliate/overview?${q}`); expect(o.body.summary.code).toBe('ALPHA1')
      const c = await get('commissions', sA, `/api/affiliate/commissions?${q}`); expect(c.body.sales.every((s: any) => s.ref !== null)).toBe(true); expect(c.body.sales).toHaveLength(2)
      const p = await get('payouts', sA, `/api/affiliate/payouts?${q}`); expect(p.body.payouts).toHaveLength(1)
    }
    // Statement: another affiliate's reference, their raw payout id, a malformed ref and a made-up ref are indistinguishable.
    const bRef = await payoutRef(payoutB.payout_id)
    const codes = []
    for (const ref of [bRef, payoutB.payout_id, 'P-0000000000', 'P-ZZZZZZZZZZ', '../../etc/passwd', "P-1' OR '1'='1", payoutA.payout_id]) {
      const r = await get('statement', sA, `/api/affiliate/payouts/${encodeURIComponent(ref)}/statement`, { params: Promise.resolve({ ref }) })
      codes.push([r.status, r.text])
    }
    for (const c of codes) expect(c).toEqual([404, JSON.stringify({ error: 'Statement not found.' })])
    // …and B can still read B's own.
    const own = await get('statement', sB, `/api/affiliate/payouts/${bRef}/statement`, { params: Promise.resolve({ ref: bRef }) })
    expect(own.status).toBe(200); expect(own.body.statement.amountCents).toBe(2000)
    // A reference minted for one affiliate cannot be used for a sale/payout of another in the DB either.
    expect((await fx.q(`SELECT affiliate_public_ref('payout',$1,$2) AS r`, [payoutB.payout_id, A.id]))[0].r).toBeNull()
  })

  test('profile: only display name / website / social links, validated; no status, rate, id or readiness fields', async () => {
    const patch = (body: any, s = sA) => h.profilePATCH(mkReq('/api/affiliate/profile', { method: 'PATCH', session: s.sessionToken, csrf: s.csrfToken, body }))
    for (const body of [{ programStatus: 'active' }, { affiliateId: B.id }, { kyc_status: 'verified' }, { commission_rate: 9000 }, { portal_access: 'enabled' }, { displayName: 'ok', code: 'HACK' }, {}, { displayName: '' }, { displayName: 'x'.repeat(200) }, { website: 'javascript:alert(1)' }, { website: 'http://insecure.test' }, { website: 'https://user:pw@evil.test' }, { socialLinks: [{ platform: 'instagram', url: 'ftp://x' }] }, { socialLinks: 'nope' }, { socialLinks: Array(30).fill({ platform: 'instagram', url: 'https://instagram.com/x' }) }]) {
      const r = await patch(body); expect({ body, status: r.status }).toEqual({ body, status: 400 })
    }
    const before = (await fx.q(`SELECT kyc_status, program_status, portal_access FROM affiliate_profiles WHERE affiliate_id=$1`, [A.id]))[0]
    const ok = await patch({ displayName: 'Alpha Creator', website: 'https://alpha.example.com/me', socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/alpha' }] })
    expect(ok.status).toBe(200)
    const row = (await fx.q(`SELECT display_name, website, social_links, kyc_status, program_status, portal_access FROM affiliate_profiles WHERE affiliate_id=$1`, [A.id]))[0]
    expect(row).toMatchObject({ display_name: 'Alpha Creator', website: 'https://alpha.example.com/me' })
    expect(row.social_links).toEqual([{ platform: 'instagram', url: 'https://instagram.com/alpha' }])
    expect({ kyc_status: row.kyc_status, program_status: row.program_status, portal_access: row.portal_access }).toEqual(before)
    // B's profile is untouched.
    expect((await fx.q(`SELECT display_name FROM affiliate_profiles WHERE affiliate_id=$1`, [B.id]))[0].display_name).not.toBe('Alpha Creator')
    const ev = await fx.q(`SELECT detail FROM affiliate_security_events WHERE affiliate_id=$1 AND event_type='profile_updated'`, [A.id])
    expect(ev.length).toBeGreaterThan(0)
  })

  test('terms: accept records the CURRENT version append-only, idempotently, and flips the reacceptance prompt', async () => {
    const { publishDocVersion } = await import('./affiliate-portal-fixtures')
    const C = await mkAffiliate(fx.q, { profile: {} }); const sC = await loginAs(fx.sql, C.email!, '10.31.0.1')
    let o = await get('onboarding', sC, '/api/affiliate/onboarding')
    expect(o.body.terms.documents.every((x: any) => x.needsAcceptance)).toBe(true)
    expect(o.body.terms.requiresReacceptance).toBe(true)
    const acc = (docTypes: any) => h.accept(mkReq('/api/affiliate/onboarding/accept', { method: 'POST', session: sC.sessionToken, csrf: sC.csrfToken, body: { docTypes } }))
    expect((await acc(['nope'])).status).toBe(400); expect((await acc([])).status).toBe(400); expect((await acc('program_terms')).status).toBe(400)
    const r1 = await acc(['program_terms', 'disclosure_policy', 'brand_rules']); expect(r1.status).toBe(200)
    const r2 = await acc(['program_terms', 'disclosure_policy', 'brand_rules']); expect(r2.status).toBe(200)
    const rows = await fx.q(`SELECT doc_type, version, method, ip_hash FROM affiliate_acceptances WHERE affiliate_id=$1 ORDER BY doc_type`, [C.id])
    expect(rows).toHaveLength(3)                                         // idempotent: no duplicates
    expect(rows.every((x: any) => x.method === 'portal' && /^[0-9a-f]{64}$/.test(x.ip_hash))).toBe(true)   // hashed, never a raw ip
    o = await get('onboarding', sC, '/api/affiliate/onboarding')
    expect(o.body.terms.requiresReacceptance).toBe(false)
    expect(o.body.terms.acceptedProgramTermsVersion).toBe('v1')
    // A material change makes the prompt come back and keeps the old acceptance.
    await publishDocVersion(fx.q, 'program_terms', 'v2')
    o = await get('onboarding', sC, '/api/affiliate/onboarding')
    expect(o.body.terms.requiresReacceptance).toBe(true)
    await acc(['program_terms'])
    expect((await fx.q(`SELECT version FROM affiliate_acceptances WHERE affiliate_id=$1 AND doc_type='program_terms' ORDER BY version`, [C.id])).map((x: any) => x.version)).toEqual(['v1', 'v2'])
    expect((await fx.q(`SELECT accepted_program_terms_version v FROM affiliate_profiles WHERE affiliate_id=$1`, [C.id]))[0].v).toBe('v2')
    // Acceptance rows are append-only evidence.
    expect(await fx.err(`DELETE FROM affiliate_acceptances WHERE affiliate_id=$1`, [C.id])).toBeDefined()
  })

  test('documents: only portal-visible types; the body is plain text (rendered safely by the client)', async () => {
    for (const t of ['ugc_license', 'internal', '../x', 'PROGRAM_TERMS']) {
      expect((await get('doc', sA, `/api/affiliate/documents/${encodeURIComponent(t)}`, { params: Promise.resolve({ docType: t }) })).status).toBe(404)
    }
    const r = await get('doc', sA, '/api/affiliate/documents/disclosure_policy', { params: Promise.resolve({ docType: 'disclosure_policy' }) })
    expect(r.body.document).toMatchObject({ docType: 'disclosure_policy', title: expect.stringContaining('Disclosure Policy') })
  })

  test('UNKNOWN IS NEVER ZERO: an unresolved dispute shows null amounts, "under review", and a visible unresolved count', async () => {
    const E = await mkAffiliate(fx.q, { code: 'ECHO5', email: 'echo@portal.test' })
    const s = await mkSale(fx.q, { code: E.code }); await promote(fx.q, E.id)
    await markIncomplete(fx.q, s.commissionId)
    const sE = await loginAs(fx.sql, E.email!, '10.32.0.1')
    const c = await get('commissions', sE, '/api/affiliate/commissions')
    expect(c.body.sales[0]).toMatchObject({ netSaleCents: null, netCommissionCents: null, status: 'under_review', reversalStatus: 'under_review' })
    const o = await get('overview', sE, '/api/affiliate/overview?range=all')
    expect(o.body.balances.unresolvedCount).toBe(1)
    expect(o.body.performance.netIsPartial).toBe(true); expect(o.body.performance.ordersUnderReview).toBe(1)
    // The money that is not yet certain is not folded into 'available'.
    expect(o.body.balances.availableCents).toBe(0)
    expect(formatCents(c.body.sales[0].netCommissionCents)).toBe('—')
    // a payout can never include it
    expect((await fx.err(`SELECT create_affiliate_payout($1,$2::uuid[],'t')`, [E.id, [s.commissionId]]))).toBe('')
    expect((await fx.q(`SELECT COUNT(*)::int n FROM affiliate_payouts WHERE affiliate_id=$1`, [E.id]))[0].n).toBe(0)
  })

  test('payouts list: statuses derive from the payout + latest attempt (processing / paid / failed / cancelled)', async () => {
    const F = await mkAffiliate(fx.q, { email: 'foxtrot@portal.test' })
    const s1 = await mkSale(fx.q, { code: F.code }); const s2 = await mkSale(fx.q, { code: F.code }); const s3 = await mkSale(fx.q, { code: F.code })
    const p1 = await mkDraftPayout(fx.q, F.id, [s1.commissionId]); const p2 = await mkDraftPayout(fx.q, F.id, [s2.commissionId]); const p3 = await mkDraftPayout(fx.q, F.id, [s3.commissionId])
    await payPayout(fx.q, p1.payout_id)
    const att = (await fx.q(`SELECT affiliate_record_payout_attempt($1,'k-failed-1','manual','admin@kvrn.test') AS r`, [p2.payout_id]))[0].r
    await fx.q(`SELECT affiliate_complete_payout_attempt($1,'failed',NULL,'bank_rejected','account closed',NULL,NULL,'admin@kvrn.test')`, [att.attempt_id])
    await fx.q(`SELECT void_affiliate_payout($1,'mistake','admin@kvrn.test')`, [p3.payout_id])
    const sF = await loginAs(fx.sql, F.email!, '10.33.0.1')
    const r = await get('payouts', sF, '/api/affiliate/payouts')
    const by = Object.fromEntries(r.body.payouts.map((p: any) => [p.amountCents + p.status, p.status]))
    expect(r.body.payouts.map((p: any) => p.status).sort()).toEqual(['cancelled', 'failed', 'paid'])
    expect(JSON.stringify(r.body)).not.toMatch(/bank_rejected|account closed/)       // failure detail is Admin-only
    void by
  })

  test('statements reconcile: net = earned + adjustments − already paid + recovered, and CSV matches', async () => {
    const stRef = await payoutRef(payoutA.payout_id)
    const r = await get('statement', sA, `/api/affiliate/payouts/${stRef}/statement`, { params: Promise.resolve({ ref: stRef }) })
    const st = r.body.statement
    expect(st).toMatchObject({ status: 'paid', amountCents: 700, currency: 'USD' })
    expect(st.totals).toMatchObject({ grossEarnedCents: 1000, adjustmentsCents: -300, previouslyPaidCents: 0, recoveredCents: 0, netCents: 700, reconciled: true })
    expect(st.totals.grossEarnedCents + st.totals.adjustmentsCents - st.totals.previouslyPaidCents + st.totals.recoveredCents).toBe(st.totals.netCents)
    expect(st.lines).toHaveLength(1); expect(st.lines[0]).toMatchObject({ lineAmountCents: 700, reconciled: true })
    expect(st.lines[0]).not.toHaveProperty('orderNumber')
    const csv = await get('statement', sA, `/api/affiliate/payouts/${stRef}/statement?format=csv`, { params: Promise.resolve({ ref: stRef }) })
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/); expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="kvrn-payout-P-[0-9A-F]{10}\.csv"/)
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff')
    expect(csv.text).toContain('Net payout,7.00'); expect(csv.text).toContain('Statement reconciles,yes'); expect(csv.text).toContain('Adjustments (reversals and corrections),-3.00')
    // A download is recorded for the affiliate's own security log.
    expect((await fx.q(`SELECT 1 FROM affiliate_security_events WHERE affiliate_id=$1 AND event_type='statement_downloaded'`, [A.id])).length).toBeGreaterThan(0)
  })

  test('payout-setup: manual provider returns instructions; no sensitive data is requested or accepted', async () => {
    const g = await get('setupGET', sA, '/api/affiliate/payout-setup'); expect(g.body).toEqual({ provider: 'manual', hosted: false })
    const r = await h.setupPOST(mkReq('/api/affiliate/payout-setup', { method: 'POST', session: sA.sessionToken, csrf: sA.csrfToken, body: { bankAccount: '000123456789', ssn: '123-45-6789' } }))
    const b = await r.json(); expect(r.status).toBe(200); expect(b.kind).toBe('manual_instructions')
    expect(JSON.stringify(b)).not.toMatch(/000123456789|123-45-6789/)
    // body is never read: nothing was stored
    const all = JSON.stringify(await fx.q(`SELECT * FROM affiliate_security_events`))
    expect(all).not.toMatch(/000123456789|123-45-6789/)
  })

  test('suspended affiliate: history and statements remain readable, writes are refused', async () => {
    const G = await mkAffiliate(fx.q, { email: 'golf@portal.test' }); const s = await mkSale(fx.q, { code: G.code }); const p = await mkDraftPayout(fx.q, G.id, [s.commissionId]); await payPayout(fx.q, p.payout_id)
    await fx.q(`SELECT suspend_affiliate_for_compliance($1,'policy breach test',FALSE,'admin@kvrn.test')`, [G.id])
    const sG = await loginAs(fx.sql, G.email!, '10.34.0.1')
    expect((await get('overview', sG, '/api/affiliate/overview')).body.summary.codeLive).toBe(false)     // code disabled
    expect((await get('commissions', sG, '/api/affiliate/commissions')).body.sales).toHaveLength(1)
    const ref = await payoutRef(p.payout_id)
    expect((await get('statement', sG, `/api/affiliate/payouts/${ref}/statement`, { params: Promise.resolve({ ref }) })).status).toBe(200)
    const w = await h.profilePATCH(mkReq('/api/affiliate/profile', { method: 'PATCH', session: sG.sessionToken, csrf: sG.csrfToken, body: { displayName: 'New' } }))
    expect(w.status).toBe(403)
    const a = await h.accept(mkReq('/api/affiliate/onboarding/accept', { method: 'POST', session: sG.sessionToken, csrf: sG.csrfToken, body: { docTypes: ['program_terms'] } }))
    expect(a.status).toBe(403)
    expect((await get('me', sG, '/api/affiliate/me')).body).toMatchObject({ readOnly: true, programStatus: 'suspended' })
  })
})
