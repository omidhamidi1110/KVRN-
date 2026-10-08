// Audit C — adversarial tests for the affiliate money & lifecycle changes of this batch (migrations 033/034).
// Real PostgreSQL (throwaway database, local only). Each test pins one defect found during the audit.
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createAffiliateProgramAdmin } from '../affiliate-program-admin'
import { issueFormToken, submitPublicApplication } from '../affiliate-application'
import { getApplicationReadiness, getProfileByAffiliateId, recordAcceptance, getCurrentDocuments } from '../affiliate-program'
import { mkAffiliate, mkSale, makeReady, mkDraftPayout, promote } from './affiliate-portal-fixtures'
import { canPayAffiliate } from '../affiliate-payout-gate'

const d = HAVE_DB ? describe : describe.skip
const ACTOR = 'admin@kvrn.test'
const ENV_PEPPER_MISSING = { KVRN_FLAG_AFFILIATE_APPLICATIONS: 'true', NODE_ENV: 'production' }

d('audit C: affiliate lifecycle and money', () => {
  let fi: FiDb
  let sql: any
  let admin: ReturnType<typeof createAffiliateProgramAdmin>
  const q = (t: string, p?: unknown[]) => fi.q(t, p)
  const one = async (t: string, p?: unknown[]) => (await q(t, p))[0]

  const realText = (title: string) => `# ${title}\n\nThese are the final reviewed terms for testing purposes only and contain enough text to publish.\n\n- Item one\n- Item two`
  async function publishDoc(docType: string, material = false) {
    const saved = await admin.saveDocumentDraft({ docType, title: `Test ${docType}`, body: realText(docType), changeSummary: 'test' }, ACTOR)
    return admin.publishDocument(saved.document_id, material, ACTOR)
  }

  let n = 0
  /** An affiliate with a customer discount and a referral link, created the legacy way (create_affiliate), program-active. */
  async function liveAffiliate(code: string) {
    n++
    const disc = await one(`INSERT INTO discounts (code, name, description, type, percentage_bps, active, system_managed, priority, created_by)
                            VALUES ($1, $1, 'x', 'percentage', 1000, TRUE, TRUE, 10, 'test') RETURNING id`, [code])
    const r = await one(`SELECT create_affiliate($1,$2,$3,'percentage',1000,NULL,'proportional',30,0,$4::uuid,NULL,'test') AS r`,
      [code, `Aff ${code}`, `aud${n}@example.com`, disc.id])
    const id: string = r.r.affiliate_id
    await q(`SELECT create_affiliate_link($1::uuid, $2, '/', 'test')`, [id, `slug-${code.toLowerCase()}`])
    return id
  }
  const discActive = async (id: string) => (await one(`SELECT d.active FROM discounts d JOIN affiliates a ON a.discount_id = d.id WHERE a.id = $1`, [id])).active
  const linkActive = async (id: string) => (await one(`SELECT bool_or(active) AS a FROM affiliate_links WHERE affiliate_id = $1`, [id])).a

  beforeAll(async () => {
    fi = await createFiDb('auditc')
    sql = fi.sql
    admin = createAffiliateProgramAdmin(sql)
    for (const t of ['program_terms', 'disclosure_policy', 'privacy_notice']) await publishDoc(t)
  }, 120_000)
  afterAll(async () => { if (fi) await fi.close() }, 60_000)

  // ── C-1: the compliance suspension path must switch the code and link off like every other suspension ──
  test('C-1 compliance suspension disables the customer discount and the referral link (and reinstating restores them)', async () => {
    const id = await liveAffiliate('CMPL1')
    expect(await discActive(id)).toBe(true)
    expect(await linkActive(id)).toBe(true)
    await q(`SELECT suspend_affiliate_for_compliance($1::uuid, 'misleading claims', FALSE, $2)`, [id, ACTOR])
    expect((await getProfileByAffiliateId(sql, id))!.programStatus).toBe('suspended')
    expect(await discActive(id)).toBe(false)
    expect(await linkActive(id)).toBe(false)
    await admin.setProgramStatus(id, 'active', { actor: ACTOR, reason: 'resolved' })
    expect(await discActive(id)).toBe(true)
    expect(await linkActive(id)).toBe(true)
  })

  // ── C-2: set_affiliate_program_status(revokePortal) calls a 2-arg revoke_affiliate_sessions that does not exist ──
  test('C-2 suspending with revokePortal ends the affiliate\'s live sessions', async () => {
    const id = await liveAffiliate('REVK1')
    const h = (c: string) => c.repeat(64)
    await q(`INSERT INTO affiliate_sessions (session_hash, csrf_hash, affiliate_id, expires_at, absolute_expires_at)
             VALUES ($1,$2,$3, now() + interval '1 hour', now() + interval '1 day')`, [h('a'), h('b'), id])
    await admin.setProgramStatus(id, 'suspended', { actor: ACTOR, revokePortal: true })
    const s = await one(`SELECT revoked_at FROM affiliate_sessions WHERE affiliate_id = $1`, [id])
    expect(s.revoked_at).not.toBeNull()
  })

  // ── C-3: rotating an expired invite while a newer one is open must not surface a raw unique violation ──
  test('C-3 resending an expired invite when a newer open invite exists is a clean conflict', async () => {
    const cfg = { email: 'rotate.conflict@example.com', displayName: 'Rota Conflict', socialLinks: [] }
    const a = await admin.createInvite(cfg, 14, ACTOR)
    await q(`UPDATE affiliate_invites SET expires_at = now() - interval '1 hour' WHERE id = $1`, [a.inviteId])
    const b = await admin.createInvite(cfg, 14, ACTOR)
    expect(b.inviteId).not.toBe(a.inviteId)
    await expect(admin.rotateInvite(a.inviteId, 14, ACTOR)).rejects.toMatchObject({ code: 'INVITE_EXISTS' })
    // The newer invite is untouched and still the only open one.
    const open = await q(`SELECT id FROM affiliate_invites WHERE email_normalized = 'rotate.conflict@example.com' AND status = 'open'`)
    expect(open.map((r: any) => r.id)).toEqual([b.inviteId])
  })

  // ── C-4: the anti-bot token is forgeable and IP hashes are unsalted when the pepper is missing ──
  test('C-4 the public application stays closed when AFFILIATE_HASH_PEPPER is not configured', async () => {
    const r = await getApplicationReadiness(sql, { ...ENV_PEPPER_MISSING })
    expect(r.open).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/pepper|secret/i)
    const ok = await getApplicationReadiness(sql, { ...ENV_PEPPER_MISSING, AFFILIATE_HASH_PEPPER: 'x'.repeat(32) })
    expect(ok.open).toBe(true)
  })

  // ── C-5: an onboarding affiliate must not reach Active by suspending and reinstating (skips the terms gate) ──
  test('C-5 suspend -> reinstate cannot bypass the activation terms gate; terminated cannot be suspended around the reason rule', async () => {
    // A genuinely approved applicant (onboarding) whose accepted documents then become outdated.
    const ENV = { KVRN_FLAG_AFFILIATE_APPLICATIONS: 'true', AFFILIATE_HASH_PEPPER: 'test-pepper' }
    n++
    const docs = await getCurrentDocuments(sql)
    const body = {
      applicantName: 'Grace Hopper', email: `gate${n}@example.com`, country: 'US', stateRegion: 'NY',
      socialUrls: [`https://instagram.com/grace_gate_${n}`], motivation: 'I love the clothes and make fashion videos.',
      promotionPlan: 'Short videos plus a link in my bio every week.', ageAttested: true, termsAccepted: true, disclosureAccepted: true,
      privacyAccepted: true, accuracyConfirmed: true, esignConsent: true,
      termsVersion: docs.program_terms!.version, disclosureVersion: docs.disclosure_policy!.version, privacyVersion: docs.privacy_notice!.version,
      idempotencyKey: `gate-key-${n}-${Math.random().toString(36).slice(2, 12)}`,
    }
    const out = await submitPublicApplication(sql, body, {
      ip: `10.9.0.${n}`, userAgent: 'jest', formToken: await issueFormToken(Date.now() - 60_000, ENV), honeypot: '', env: ENV, now: Date.now(),
    })
    expect(out.kind).toBe('received')
    const app = await one(`SELECT id FROM affiliate_applications WHERE email_normalized = $1`, [body.email])
    const approved = await admin.approve(app.id, {
      code: `GATE${n}`, commissionType: 'percentage', commissionRateBps: 1000, fixedReversalPolicy: 'proportional',
      attributionWindowDays: 30, commissionHoldDays: 30, paidAdsPolicy: 'not_permitted', activateNow: false,
    }, ACTOR)
    const id: string = approved.affiliate_id
    await publishDoc('program_terms', false)   // the applicant's accepted terms are now outdated
    await expect(admin.setProgramStatus(id, 'active', { actor: ACTOR })).rejects.toMatchObject({ code: 'ACTIVATION_NOT_ALLOWED' })
    // The detours: suspend then reinstate, or terminate then reinstate with a reason. Both must still be refused.
    await admin.setProgramStatus(id, 'suspended', { actor: ACTOR })
    await expect(admin.setProgramStatus(id, 'active', { actor: ACTOR })).rejects.toMatchObject({ code: 'ACTIVATION_NOT_ALLOWED' })
    await admin.setProgramStatus(id, 'terminated', { actor: ACTOR, reason: 'x' })
    await expect(admin.setProgramStatus(id, 'active', { actor: ACTOR, reason: 'appeal' })).rejects.toMatchObject({ code: 'ACTIVATION_NOT_ALLOWED' })
    expect((await getProfileByAffiliateId(sql, id))!.programStatus).not.toBe('active')
    expect(await discActive(id).catch(() => false)).toBeFalsy()

    // Terminated -> suspended -> active would sidestep "a reason is required to reinstate a terminated affiliate".
    const t = await liveAffiliate('TERM9')
    await admin.setProgramStatus(t, 'terminated', { actor: ACTOR, reason: 'violation' })
    await expect(admin.setProgramStatus(t, 'suspended', { actor: ACTOR })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    // A legacy affiliate (no application) is NOT subject to the first-activation gate: suspend and reinstate still work.
    const l = await liveAffiliate('LEGACY9')
    await admin.setProgramStatus(l, 'suspended', { actor: ACTOR })
    await admin.setProgramStatus(l, 'active', { actor: ACTOR })
    expect((await getProfileByAffiliateId(sql, l))!.programStatus).toBe('active')
  })

  // ── C-6: acceptance recording must be idempotent under concurrent identical requests ──
  test('C-6 parallel identical acceptances never fail (one row, every caller succeeds)', async () => {
    const id = await liveAffiliate('RACE1')
    const docs = await getCurrentDocuments(sql)
    const version = docs.program_terms!.version
    // Use independent connections so the calls truly overlap.
    const { Client } = await import('pg')
    const { pgConfig } = await import('./helpers/fi-pg')
    const cfg = pgConfig(`auditc_${process.pid}`)
    const { isLocal: _l, ...conn } = cfg
    const clients = await Promise.all(Array.from({ length: 8 }, async () => { const c = new Client(conn); await c.connect(); return c }))
    try {
      const results = await Promise.allSettled(clients.map(c =>
        c.query(`SELECT record_affiliate_acceptance($1::uuid, NULL, 'program_terms', $2, NULL, NULL, 'portal', FALSE) AS r`, [id, version])))
      const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
      expect(failed.map(f => String(f.reason?.message))).toEqual([])
      const rows = await q(`SELECT count(*)::int AS n FROM affiliate_acceptances WHERE affiliate_id = $1 AND doc_type = 'program_terms' AND version = $2`, [id, version])
      expect(rows[0].n).toBe(1)
    } finally {
      await Promise.all(clients.map(c => c.end().catch(() => undefined)))
    }
  })

  // ── Confirmations (expected to pass): lifecycle never mutates financial history; the gate reads real fraud holds ──
  test('suspending a code with pending commissions leaves every financial row untouched', async () => {
    const a = await mkAffiliate(q, { holdDays: 30 })
    const sale = await mkSale(q, { code: a.code })
    const snap = async () => ({
      commissions: await q(`SELECT * FROM affiliate_commissions WHERE affiliate_id = $1 ORDER BY id`, [a.id]),
      attributions: await q(`SELECT * FROM order_affiliate_attributions WHERE affiliate_id = $1 ORDER BY id`, [a.id]),
      adjustments: await q(`SELECT * FROM affiliate_commission_adjustments WHERE affiliate_id = $1 ORDER BY id`, [a.id]),
      terms: await q(`SELECT * FROM affiliate_terms_events WHERE affiliate_id = $1 ORDER BY id`, [a.id]),
      payouts: await q(`SELECT * FROM affiliate_payouts WHERE affiliate_id = $1`, [a.id]),
    })
    const before = await snap()
    expect(before.commissions).toHaveLength(1)
    await admin.setProgramStatus(a.id, 'suspended', { actor: ACTOR, reason: 'review' })
    await admin.setProgramStatus(a.id, 'terminated', { actor: ACTOR, reason: 'review' })
    await admin.setProgramStatus(a.id, 'active', { actor: ACTOR, reason: 'appeal' })
    expect(await snap()).toEqual(before)
    expect(sale.commissionId).toBe(before.commissions[0].id)
  })

  test('a legacy affiliate (no readiness data) is blocked by the gate only for the features that are ON; money math is unchanged', async () => {
    const a = await mkAffiliate(q, { holdDays: 0 })
    const sale = await mkSale(q, { code: a.code, subtotalCents: 20000 })
    await promote(q, a.id)
    const g = await canPayAffiliate(sql, a.id, { commissionIds: [sale.commissionId] })
    expect(g.allowed).toBe(false)
    expect(g.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['kyc_not_verified', 'payout_method_not_ready']))
    // The unchanged SQL still pays the exact amount (flag-OFF route skips the gate entirely).
    const p = await mkDraftPayout(q, a.id, [sale.commissionId])
    expect(p.amount_cents).toBe(2000)
  })

  test('an active fraud hold on the underlying order blocks payout creation; releasing it unblocks', async () => {
    const a = await mkAffiliate(q, { holdDays: 0 })
    await makeReady(q, a.id)
    const sale = await mkSale(q, { code: a.code })
    await promote(q, a.id)
    expect((await canPayAffiliate(sql, a.id, { commissionIds: [sale.commissionId] })).allowed).toBe(true)
    await q(`INSERT INTO order_fraud_reviews (order_id, hold_state, hold_reason, hold_created_at) VALUES ($1,'active','radar_review', now())`, [sale.orderId])
    const blocked = await canPayAffiliate(sql, a.id, { commissionIds: [sale.commissionId] })
    expect(blocked.allowed).toBe(false)
    expect(blocked.blockers.map(b => b.code)).toContain('fraud_hold_active')
    await q(`UPDATE order_fraud_reviews SET hold_state='released', released_by='o', released_at=now() WHERE order_id=$1`, [sale.orderId])
    expect((await canPayAffiliate(sql, a.id, { commissionIds: [sale.commissionId] })).allowed).toBe(true)
  })

  test('recordAcceptance of the current version is idempotent', async () => {
    const id = await liveAffiliate('IDEM1')
    const docs = await getCurrentDocuments(sql)
    const x = await recordAcceptance(sql, { affiliateId: id, docType: 'program_terms', version: docs.program_terms!.version, method: 'portal' })
    const y = await recordAcceptance(sql, { affiliateId: id, docType: 'program_terms', version: docs.program_terms!.version, method: 'portal' })
    expect(y.acceptanceId).toBe(x.acceptanceId)
  })
})

// ── C-7: one over-limit client must not be able to exhaust the shared application budget ──
import { checkApplyRateLimits } from '../affiliate-application'
d('audit C: application rate limits', () => {
  let fi: FiDb
  beforeAll(async () => { fi = await createFiDb('auditcrl') }, 120_000)
  afterAll(async () => { if (fi) await fi.close() }, 60_000)

  test('C-7 requests denied by a per-IP limit do not consume the global hourly budget', async () => {
    const limits = { perIpPerHour: 2, perIpPerDay: 100, perEmailPerDay: 100, globalPerHour: 5 }
    const results: boolean[] = []
    for (let i = 0; i < 10; i++) results.push(await checkApplyRateLimits(fi.sql, 'ip-hash-attacker', `email-hash-${i}`, limits))
    expect(results.filter(Boolean)).toHaveLength(2)
    // The attacker used 2 of the 5 shared slots; honest clients elsewhere still get through.
    const honest: boolean[] = []
    for (let i = 0; i < 3; i++) honest.push(await checkApplyRateLimits(fi.sql, `ip-hash-honest-${i}`, `email-hash-honest-${i}`, limits))
    expect(honest).toEqual([true, true, true])
    // ...and the global cap still holds.
    expect(await checkApplyRateLimits(fi.sql, 'ip-hash-honest-9', 'email-hash-honest-9', limits)).toBe(false)
  })
})
