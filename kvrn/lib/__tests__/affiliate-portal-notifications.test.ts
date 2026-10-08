// Affiliate notifications (outbox) and the maintenance cron — real PostgreSQL, fake email + payout providers. No network.
import { NextRequest } from 'next/server'
import {
  renderNotification, escapeHtml, buildFromAddress, createMagicLinkSender, createAffiliateNotificationService, MAX_ATTEMPTS, REPLY_TO,
} from '../affiliate-portal-notifications'
import type { EmailMessage, EmailProvider } from '../resend-adapter'
import type { PayoutProvider } from '../affiliate-payout-provider'

jest.mock('../db', () => ({ sql: (...a: any[]) => (globalThis as any).__affPortalTestSql(...a) }))

import { runAffiliateMaintenance } from '../affiliate-maintenance'
import {
  HAVE_DB, createPortalFx, installDb, makeReady, acceptAll, mkAffiliate, mkDraftPayout, mkSale, promote, publishDocVersion, seedDocs, setFlags,
  type PortalFx,
} from './affiliate-portal-fixtures'

const ORIGIN = 'https://kvrn.shop'
const fakeMail = (impl?: (m: EmailMessage) => any) => {
  const sent: EmailMessage[] = []
  const provider: EmailProvider = { send: async m => { sent.push(m); return impl ? impl(m) : { ok: true, providerMessageId: `msg_${sent.length}` } } }
  return { sent, provider }
}

describe('notification rendering (pure)', () => {
  const kinds = ['setup_required', 'activated', 'payout_sent', 'payout_failed', 'compliance_warning', 'reacceptance_required'] as const
  test('every kind renders a subject + html with the portal link and no secrets', () => {
    for (const k of kinds) {
      const m = renderNotification(k, { amount_cents: 12345, payout_ref: 'P-ABC1234567', severity: 'warning', summary: 'Add #ad' }, ORIGIN)
      expect(m.subject.length).toBeGreaterThan(5)
      expect(m.html).toContain(`${ORIGIN}/affiliate/login`)
      expect(m.html).not.toMatch(/token|secret|password|#t=/i)
    }
  })
  test('payout mail shows the amount and the non-reversible reference only', () => {
    const m = renderNotification('payout_sent', { amount_cents: 12345, payout_ref: 'P-ABC1234567', order_number: 'KV-1', email: 'x@y.z' }, ORIGIN)
    expect(m.html).toContain('$123.45'); expect(m.html).toContain('P-ABC1234567')
    expect(m.html).not.toContain('KV-1'); expect(m.html).not.toContain('x@y.z')
  })
  test('affiliate-controlled text is HTML-escaped; the internal note is never rendered', () => {
    const m = renderNotification('compliance_warning', { severity: 'final', summary: '<script>alert(1)</script> & "x"', internal_note: 'SECRET INTERNAL' }, ORIGIN)
    expect(m.html).not.toContain('<script>'); expect(m.html).toContain('&lt;script&gt;')
    expect(m.html).not.toContain('SECRET INTERNAL')
    expect(m.subject).toMatch(/^Final notice/)
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
    // the queued message key (issueWarning) and the sweep key (summary) both render
    expect(renderNotification('compliance_warning', { message: 'via message key' }, ORIGIN).html).toContain('via message key')
  })
  test('sender uses the transactional From and the support Reply-To; env override honoured', () => {
    const env = { ...process.env }
    try {
      delete process.env.TRANSACTIONAL_EMAIL_FROM
      expect(buildFromAddress()).toMatch(/^KVRN <.+@.+>$/)
      process.env.TRANSACTIONAL_EMAIL_FROM = 'Acme <a@b.co>'
      expect(buildFromAddress()).toBe('Acme <a@b.co>')
      expect(REPLY_TO).toBe('support@kvrn.shop')
    } finally { process.env = env }
  })
  test('magic-link sender: sends once with the link as the button, reports failure, never throws', async () => {
    const ok = fakeMail()
    expect(await createMagicLinkSender(ok.provider)({ to: 'a@b.co', link: `${ORIGIN}/affiliate/login/verify#t=abc` })).toBe(true)
    expect(ok.sent).toHaveLength(1)
    expect(ok.sent[0].html).toContain('/affiliate/login/verify#t=abc')
    expect(ok.sent[0].replyTo).toBe(REPLY_TO)
    const bad = fakeMail(() => ({ ok: false, message: 'nope' }))
    expect(await createMagicLinkSender(bad.provider)({ to: 'a@b.co', link: 'https://x/y' })).toBe(false)
    const boom: EmailProvider = { send: async () => { throw new Error('network') } }
    expect(await createMagicLinkSender(boom)({ to: 'a@b.co', link: 'https://x/y' })).toBe(false)
  })
})

const d = HAVE_DB ? describe : describe.skip
d('outbox, sweeps, maintenance (real PostgreSQL)', () => {
  let fx: PortalFx
  let ROUTE: any
  const secret = 'cron-test-secret-value'
  const rows = (affId: string) => fx.q(`SELECT kind, status, attempts, last_error, payload, dedupe_key FROM affiliate_portal_notifications WHERE affiliate_id=$1 ORDER BY created_at, id`, [affId])
  const svcWith = (provider: EmailProvider) => createAffiliateNotificationService(fx.sql, { provider: () => provider, origin: () => ORIGIN })

  beforeAll(async () => {
    fx = await createPortalFx('affp_notif'); installDb(fx.sql); await seedDocs(fx.q)
    ROUTE = await import('../../app/api/internal/affiliate-maintenance/route')
  }, 120000)
  afterAll(async () => { await fx?.close() })
  beforeEach(async () => { await fx.q(`DELETE FROM affiliate_portal_notifications`); setFlags({ portal: false, autoPayouts: false }); installDb(fx.sql); process.env.CRON_SECRET = secret })
  afterEach(() => { delete process.env.CRON_SECRET })

  test('enqueue is at-most-once per dedupe key', async () => {
    const a = await mkAffiliate(fx.q); const svc = svcWith(fakeMail().provider)
    expect(await svc.enqueue(a.id, 'payout_sent', `payout_sent:${a.id}:1`, { amount_cents: 500, payout_ref: 'P-X' })).toBe(true)
    expect(await svc.enqueue(a.id, 'payout_sent', `payout_sent:${a.id}:1`, { amount_cents: 500, payout_ref: 'P-X' })).toBe(false)
    expect(await rows(a.id)).toHaveLength(1)
    await expect(svc.enqueue(a.id, 'bogus' as any, 'k-bogus-1')).rejects.toThrow()
  })

  test('drain: sends once with a stable idempotency key, marks sent, resolves the address from the affiliate, and never re-sends', async () => {
    const a = await mkAffiliate(fx.q, { email: 'creator@example.org' }); const m = fakeMail(); const svc = svcWith(m.provider)
    await svc.enqueue(a.id, 'payout_sent', `p:${a.id}`, { amount_cents: 2500, payout_ref: 'P-OK00000001' })
    const r = await svc.drain()
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0, skipped: 0, notConfigured: false })
    expect(m.sent).toHaveLength(1)
    expect(m.sent[0].to).toBe('creator@example.org')
    expect(m.sent[0].idempotencyKey).toMatch(/^affportal-[0-9a-f-]{36}$/)
    expect(m.sent[0].html).toContain('$25.00')
    const row = (await rows(a.id))[0]; expect(row.status).toBe('sent')
    expect((await svc.drain()).claimed).toBe(0)
    expect(m.sent).toHaveLength(1)
    // nothing about the recipient is stored in the outbox
    expect(JSON.stringify(await fx.q(`SELECT * FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [a.id]))).not.toContain('creator@example.org')
  })

  test('drain: failures back off exponentially, record a short error, and stop after the maximum attempts', async () => {
    const a = await mkAffiliate(fx.q); const m = fakeMail(() => ({ ok: false, message: 'provider said no' })); const svc = svcWith(m.provider)
    await svc.enqueue(a.id, 'activated', `act:${a.id}`)
    expect(await svc.drain()).toMatchObject({ claimed: 1, sent: 0, failed: 1 })
    let row = (await fx.q(`SELECT status, attempts, last_error, next_attempt_at > NOW() + INTERVAL '90 seconds' AS later FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [a.id]))[0]
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'provider said no', later: true })
    expect((await svc.drain()).claimed).toBe(0)                                      // not due yet
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await fx.q(`UPDATE affiliate_portal_notifications SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE affiliate_id=$1`, [a.id])
      expect((await svc.drain()).failed).toBe(1)
    }
    await fx.q(`UPDATE affiliate_portal_notifications SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE affiliate_id=$1`, [a.id])
    expect((await svc.drain()).claimed).toBe(0)                                      // gave up
    row = (await fx.q(`SELECT status, attempts FROM affiliate_portal_notifications WHERE affiliate_id=$1`, [a.id]))[0]
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(m.sent).toHaveLength(MAX_ATTEMPTS)
  })

  test('drain: a throwing provider counts as a failure; no address or unknown kind is skipped; a stale "sending" row is recovered', async () => {
    const boom: EmailProvider = { send: async () => { throw new Error('socket hang up with secret=abc') } }
    const a = await mkAffiliate(fx.q); await svcWith(boom).enqueue(a.id, 'activated', `act:${a.id}`)
    expect(await svcWith(boom).drain()).toMatchObject({ failed: 1 })
    expect((await rows(a.id))[0].last_error).toBe('send threw')                       // no raw error text stored

    const noAddr = await mkAffiliate(fx.q, { email: null }); const m = fakeMail(); const s2 = svcWith(m.provider)
    await s2.enqueue(noAddr.id, 'activated', `act:${noAddr.id}`)
    expect(await s2.drain()).toMatchObject({ skipped: 1, sent: 0 })
    expect((await rows(noAddr.id))[0].status).toBe('skipped')

    const b = await mkAffiliate(fx.q); await s2.enqueue(b.id, 'activated', `act:${b.id}`)
    await fx.q(`UPDATE affiliate_portal_notifications SET status='sending', attempts=1, updated_at = NOW() - INTERVAL '30 minutes' WHERE affiliate_id=$1`, [b.id])
    expect((await s2.drain()).sent).toBe(1)
    await fx.q(`UPDATE affiliate_portal_notifications SET status='sending', attempts=1, updated_at = NOW() WHERE affiliate_id=$1 AND FALSE`, [b.id])
  })

  test('drain: concurrent runs never double-send', async () => {
    const a = await mkAffiliate(fx.q); const m = fakeMail(); const svc = svcWith(m.provider)
    for (let i = 0; i < 6; i++) await svc.enqueue(a.id, 'payout_sent', `p:${a.id}:${i}`, { amount_cents: 100 * (i + 1), payout_ref: `P-${i}` })
    await Promise.all([svc.drain(), svc.drain(), svc.drain()])
    expect(m.sent).toHaveLength(6)
    expect(new Set(m.sent.map(x => x.idempotencyKey)).size).toBe(6)
  })

  test('drain: without a configured email provider nothing is claimed (rows stay queued)', async () => {
    const a = await mkAffiliate(fx.q)
    const svc = createAffiliateNotificationService(fx.sql, { provider: () => { throw new Error('RESEND_API_KEY missing') } })
    await svc.enqueue(a.id, 'activated', `act:${a.id}`)
    expect(await svc.drain()).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0, notConfigured: true })
    expect((await rows(a.id))[0]).toMatchObject({ status: 'queued', attempts: 0 })
  })

  test('sweeps: setup-required and activated are once per affiliate, recent only, and respect state', async () => {
    const needsSetup = await mkAffiliate(fx.q)
    const ready = await mkAffiliate(fx.q)
    const old = await mkAffiliate(fx.q)
    await fx.q(`UPDATE affiliate_profiles SET created_at = NOW() - INTERVAL '60 days' WHERE affiliate_id=$1`, [old.id])
    const noEmail = await mkAffiliate(fx.q, { email: null })
    const revoked = await mkAffiliate(fx.q, { profile: { portal_access: 'revoked' } })
    // ready: verified + method ready via the real function, which writes a readiness event
    await fx.q(`SELECT set_affiliate_readiness($1,'kyc','verified','admin','admin@kvrn.test','Checked in dashboard','manual')`, [ready.id])
    await fx.q(`SELECT set_affiliate_readiness($1,'payout_method','ready','admin','admin@kvrn.test','Bank confirmed','manual')`, [ready.id])

    const svc = svcWith(fakeMail().provider)
    const s1 = await svc.sweepSetupRequired(); const s2 = await svc.sweepActivated()
    expect(s1).toBeGreaterThanOrEqual(1); expect(s2).toBeGreaterThanOrEqual(1)
    expect((await rows(needsSetup.id)).map(r => r.kind)).toEqual(['setup_required'])
    expect((await rows(ready.id)).map(r => r.kind)).toEqual(['activated'])               // not "setup required": already verified
    for (const x of [old, noEmail, revoked]) expect(await rows(x.id)).toHaveLength(0)
    expect(await svc.sweepSetupRequired()).toBe(0); expect(await svc.sweepActivated()).toBe(0)   // idempotent
    expect((await rows(needsSetup.id))).toHaveLength(1)
  })

  test('sweeps: compliance warnings carry the summary only; re-acceptance mails once per set of document versions', async () => {
    const a = await mkAffiliate(fx.q)
    await fx.q(`INSERT INTO affiliate_compliance_warnings (affiliate_id, severity, category, summary, internal_note, notify_affiliate, issued_by)
                VALUES ($1,'warning','disclosure','Please add #ad','INTERNAL ONLY NOTE',TRUE,'admin@kvrn.test')`, [a.id])
    const quiet = await mkAffiliate(fx.q)
    await fx.q(`INSERT INTO affiliate_compliance_warnings (affiliate_id, severity, category, summary, notify_affiliate, issued_by)
                VALUES ($1,'notice','brand','Quiet one',FALSE,'admin@kvrn.test')`, [quiet.id])
    const svc = svcWith(fakeMail().provider)
    expect(await svc.sweepComplianceWarnings()).toBeGreaterThanOrEqual(1)
    const w = await rows(a.id)
    expect(w).toHaveLength(1)
    expect(JSON.stringify(w[0].payload)).toContain('Please add #ad'); expect(JSON.stringify(w[0].payload)).not.toContain('INTERNAL ONLY')
    expect(await rows(quiet.id)).toHaveLength(0)
    expect(await svc.sweepComplianceWarnings()).toBe(0)

    const re = await mkAffiliate(fx.q, { profile: { requires_reacceptance: true } })
    expect(await svc.sweepReacceptance()).toBeGreaterThanOrEqual(1)
    expect((await rows(re.id)).map(r => r.kind)).toEqual(['reacceptance_required'])
    expect(await svc.sweepReacceptance()).toBe(0)
    await publishDocVersion(fx.q, 'program_terms', 'v2')                                     // new version → one new mail, not weekly nagging
    expect(await svc.sweepReacceptance()).toBeGreaterThanOrEqual(1)
    expect((await rows(re.id))).toHaveLength(2)
    expect(await svc.sweepReacceptance()).toBe(0)
  })

  test('the warning raised from the Admin center and the sweep never produce two mails for one warning', async () => {
    const a = await mkAffiliate(fx.q)
    const { createAffiliateComplianceService } = await import('../affiliate-compliance')
    await createAffiliateComplianceService(fx.sql).issueWarning(a.id, { severity: 'warning', category: 'brand', summary: 'Logo misuse here', internalNote: null, notifyAffiliate: true, itemId: null }, 'admin@kvrn.test')
    const svc = svcWith(fakeMail().provider)
    await svc.sweepComplianceWarnings()
    expect(await rows(a.id)).toHaveLength(1)
  })

  // ── maintenance ────────────────────────────────────────────────────────────
  test('maintenance: flag OFF is a complete no-op (no database access at all)', async () => {
    const spy: any = jest.fn(() => { throw new Error('should not be called') }); spy.query = spy
    const r = await runAffiliateMaintenance(spy, { portalEnabled: () => false, autoPayoutsEnabled: () => true })
    expect(r).toEqual({ enabled: false, steps: {} })
    expect(spy).not.toHaveBeenCalled()
  })

  test('maintenance: flag ON runs every step, returns counts only (no ids, emails or amounts), and is idempotent', async () => {
    const a = await mkAffiliate(fx.q, { email: 'secret.person@example.org' }); await mkSale(fx.q, { code: a.code })
    const m = fakeMail()
    const notifications = svcWith(m.provider)
    const deps = { portalEnabled: () => true, autoPayoutsEnabled: () => false, notifications }
    const r1 = await runAffiliateMaintenance(fx.sql, deps)
    expect(r1.enabled).toBe(true)
    expect(Object.keys(r1.steps)).toEqual(expect.arrayContaining(['cleanup.tokens', 'sweep.setup.queued', 'notify.sent', 'selfReferral.created', 'promote.promoted']))
    for (const v of Object.values(r1.steps)) expect(typeof v).toBe('number')
    expect(Object.keys(r1.steps).some(k => k.endsWith('.error'))).toBe(false)
    const dump = JSON.stringify(r1)
    expect(dump).not.toContain('secret.person'); expect(dump).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(m.sent.some(x => x.to === 'secret.person@example.org')).toBe(true)              // the queued setup mail went out
    const before = m.sent.length
    const r2 = await runAffiliateMaintenance(fx.sql, deps)
    expect(r2.steps['sweep.setup.queued']).toBe(0); expect(m.sent.length).toBe(before)
  })

  test('maintenance: one failing step never blocks the others', async () => {
    const broken: any = { sweepSetupRequired: async () => { throw new Error('boom') }, sweepActivated: async () => 0, sweepComplianceWarnings: async () => 0, sweepReacceptance: async () => 0, drain: async () => ({ claimed: 0, sent: 0, failed: 0, skipped: 0, notConfigured: false }) }
    const r = await runAffiliateMaintenance(fx.sql, { portalEnabled: () => true, autoPayoutsEnabled: () => false, notifications: broken })
    expect(r.steps['sweep.setup.error']).toBe(1)
    expect(r.steps['sweep.activated.queued']).toBe(0)
    expect(r.steps['promote.promoted']).toBeDefined()
  })

  test('maintenance: promotes due commissions with the existing function (a cron run equals the lazy read path)', async () => {
    const a = await mkAffiliate(fx.q, { holdDays: 0 }); const s = await mkSale(fx.q, { code: a.code })
    expect((await fx.q(`SELECT status FROM affiliate_commissions WHERE id=$1`, [s.commissionId]))[0].status).toBe('pending')
    const r = await runAffiliateMaintenance(fx.sql, { portalEnabled: () => true, autoPayoutsEnabled: () => false, notifications: svcWith(fakeMail().provider) })
    expect(Number(r.steps['promote.promoted'])).toBeGreaterThanOrEqual(1)
    expect((await fx.q(`SELECT status FROM affiliate_commissions WHERE id=$1`, [s.commissionId]))[0].status).toBe('approved')
  })

  describe('automated payouts', () => {
    const fakeProvider = (impl: PayoutProvider['createPayout'], over: Partial<PayoutProvider> = {}) => {
      const calls: any[] = []
      const p: PayoutProvider = {
        id: 'stripe_connect', supportsAutomatedPayouts: true, isConfigured: () => true,
        createOnboardingLink: async () => { throw new Error('unused') }, getStatus: async () => { throw new Error('unused') },
        createPayout: async i => { calls.push(i); return impl(i) }, ...over,
      }
      return { p, calls }
    }
    async function draftFor(ready: boolean) {
      const a = await mkAffiliate(fx.q)
      if (ready) { await makeReady(fx.q, a.id); await acceptAll(fx.q, a.id) }
      const s = await mkSale(fx.q, { code: a.code }); await promote(fx.q, a.id)
      const p = await mkDraftPayout(fx.q, a.id, [s.commissionId])
      return { a, p }
    }
    const run = (provider: PayoutProvider, auto: boolean) =>
      runAffiliateMaintenance(fx.sql, { portalEnabled: () => true, autoPayoutsEnabled: () => auto, provider, notifications: svcWith(fakeMail().provider) })
    const status = async (id: string) => (await fx.q(`SELECT status FROM affiliate_payouts WHERE id=$1`, [id]))[0].status

    test('AUTO_PAYOUTS OFF: the provider is never called', async () => {
      const { p } = await draftFor(true); const f = fakeProvider(async () => ({ outcome: 'submitted', providerReference: 'tr_1' }))
      const r = await run(f.p, false)
      expect(f.calls).toHaveLength(0); expect(Object.keys(r.steps).some(k => k.startsWith('autoPayouts'))).toBe(false)
      expect(await status(p.payout_id)).toBe('draft')
    })

    test('manual provider or an unconfigured provider: nothing is submitted', async () => {
      const { p } = await draftFor(true)
      const manual = fakeProvider(async () => ({ outcome: 'submitted', providerReference: 'x' }), { id: 'manual', supportsAutomatedPayouts: false })
      expect((await run(manual.p, true)).steps['autoPayouts.manual']).toBe(1)
      const unconf = fakeProvider(async () => ({ outcome: 'submitted', providerReference: 'x' }), { isConfigured: () => false })
      expect((await run(unconf.p, true)).steps['autoPayouts.manual']).toBe(1)
      expect(manual.calls.length + unconf.calls.length).toBe(0)
      expect(await status(p.payout_id)).toBe('draft')
    })

    test('ready affiliate: submitted once with a stable idempotency key, attempt recorded, payout paid; a second run does nothing', async () => {
      const { p } = await draftFor(true); const f = fakeProvider(async () => ({ outcome: 'submitted', providerReference: 'tr_ok_1' }))
      const r = await run(f.p, true)
      expect(Number(r.steps['autoPayouts.submitted'])).toBeGreaterThanOrEqual(1)
      const mine = f.calls.filter(c => c.payoutId === p.payout_id); expect(mine).toHaveLength(1)
      expect(mine[0].idempotencyKey).toBe(`auto-${p.payout_id}`)
      expect(await status(p.payout_id)).toBe('paid')
      const att = await fx.q(`SELECT status, attempt_no FROM affiliate_payout_attempts WHERE payout_id=$1`, [p.payout_id])
      expect(att).toEqual([{ status: 'succeeded', attempt_no: 1 }])
      await run(f.p, true)
      expect(f.calls.filter(c => c.payoutId === p.payout_id)).toHaveLength(1)
    })

    test('the readiness gate is still enforced: an unready affiliate is blocked and the provider is not called for them', async () => {
      const { p } = await draftFor(false); const f = fakeProvider(async () => ({ outcome: 'submitted', providerReference: 'tr_no' }))
      const r = await run(f.p, true)
      expect(Number(r.steps['autoPayouts.blocked'])).toBeGreaterThanOrEqual(1)
      expect(f.calls.filter(c => c.payoutId === p.payout_id)).toHaveLength(0)
      expect(await status(p.payout_id)).toBe('draft')
    })

    test('gate for an EXISTING draft evaluates its reserved lines (not "nothing payable"), and still blocks / fails closed', async () => {
      const { canPayAffiliate } = await import('../affiliate-payout-gate')
      const { a, p } = await draftFor(true)
      expect((await canPayAffiliate(fx.sql, a.id)).blockers.map(b => b.code)).toContain('nothing_payable')   // money is reserved
      const g = await canPayAffiliate(fx.sql, a.id, { draftPayoutId: p.payout_id })
      expect(g).toMatchObject({ allowed: true, blockers: [], snapshot: { payableCents: 1000 } })
      await fx.q(`UPDATE affiliate_profiles SET kyc_status='problem' WHERE affiliate_id=$1`, [a.id])
      expect((await canPayAffiliate(fx.sql, a.id, { draftPayoutId: p.payout_id })).blockers.map(b => b.code)).toContain('kyc_not_verified')
      await fx.q(`UPDATE affiliate_profiles SET kyc_status='verified' WHERE affiliate_id=$1`, [a.id])
      const other = await draftFor(true)
      expect((await canPayAffiliate(fx.sql, a.id, { draftPayoutId: other.p.payout_id })).blockers[0].code).toBe('gate_unavailable') // not this affiliate's
      expect((await canPayAffiliate(fx.sql, a.id, { draftPayoutId: 'nope' })).allowed).toBe(false)
      await fx.q(`SELECT mark_affiliate_payout_paid($1, CURRENT_DATE, 'bank_transfer', 'R', 'admin@kvrn.test')`, [p.payout_id])
      expect((await canPayAffiliate(fx.sql, a.id, { draftPayoutId: p.payout_id })).allowed).toBe(false)         // no longer a draft
    })

    test('provider failure: the draft stays reserved with a failed attempt, and is not blindly retried by the cron', async () => {
      const { p } = await draftFor(true); const f = fakeProvider(async () => ({ outcome: 'failed', providerReference: null, failureCode: 'insufficient_funds' }))
      await run(f.p, true)
      expect(await status(p.payout_id)).toBe('draft')
      expect((await fx.q(`SELECT status, failure_code FROM affiliate_payout_attempts WHERE payout_id=$1`, [p.payout_id]))[0]).toMatchObject({ status: 'failed' })
      await run(f.p, true)
      expect(f.calls.filter(c => c.payoutId === p.payout_id)).toHaveLength(1)
    })
  })

  // ── cron route ─────────────────────────────────────────────────────────────
  const call = (auth?: string) => ROUTE.POST(new NextRequest(`${ORIGIN}/api/internal/affiliate-maintenance`, { method: 'POST', headers: auth ? { authorization: auth } : {} }))

  test('cron route: CRON_SECRET is required (fail closed), flag OFF returns enabled:false without touching data', async () => {
    delete process.env.CRON_SECRET
    expect((await call(`Bearer ${secret}`)).status).toBe(503)
    process.env.CRON_SECRET = secret
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(403)
    const spy: any = jest.fn(); spy.query = spy; installDb(spy)
    const off = await call(`Bearer ${secret}`)
    expect(off.status).toBe(200); expect(await off.json()).toEqual({ enabled: false, steps: {} })
    expect(spy).not.toHaveBeenCalled()
  })

  test('cron route: flag ON runs and returns counts; no-store', async () => {
    setFlags({ portal: true })
    const res = await call(`Bearer ${secret}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const j = await res.json(); expect(j.enabled).toBe(true)
    for (const v of Object.values(j.steps)) expect(typeof v).toBe('number')
  })
})
