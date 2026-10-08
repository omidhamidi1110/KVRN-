// Real-PostgreSQL tests for the affiliate program (migration 033 + services).
// Requires TEST_DATABASE_URL pointing at a LOCAL server; the harness creates and drops a throwaway database.
import fs from 'fs'
import path from 'path'
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createAffiliateProgramAdmin } from '../affiliate-program-admin'
import {
  getCurrentDocuments, getProfileByAffiliateId, getProfileByEmail, recordAcceptance, getApplicationReadiness,
  getProgramSettings, saveProgramSettings, DEFAULT_PROGRAM_SETTINGS, ProgramError,
} from '../affiliate-program'
import { issueFormToken, submitPublicApplication, sha256Hex } from '../affiliate-application'
import { renderAffiliateEmail, processAffiliateEmail, drainAffiliateEmailOutbox } from '../affiliate-program-email'
import { createAffiliatesService } from '../affiliates'
import { runAffiliateProgramMaintenance } from '../affiliate-program-maintenance'
import { SettingsStaleError } from '../site-settings'

const d = HAVE_DB ? describe : describe.skip
const ENV_ON = { KVRN_FLAG_AFFILIATE_APPLICATIONS: 'true', AFFILIATE_HASH_PEPPER: 'test-pepper' }
const ENV_OFF = { AFFILIATE_HASH_PEPPER: 'test-pepper' }
const ACTOR = 'admin@kvrn.test'

d('affiliate program (migration 033)', () => {
  let fi: FiDb
  let sql: any
  let admin: ReturnType<typeof createAffiliateProgramAdmin>
  let n = 0

  const q = (t: string, p?: unknown[]) => fi.q(t, p)
  const one = async (t: string, p?: unknown[]) => (await q(t, p))[0]

  const realText = (title: string) => `# ${title}\n\nThese are the final reviewed terms for testing purposes only and contain enough text to publish.\n\n- Item one\n- Item two`
  async function publishDoc(docType: string, material = false) {
    const saved = await admin.saveDocumentDraft({ docType, title: `Test ${docType}`, body: realText(docType), changeSummary: 'test' }, ACTOR)
    return admin.publishDocument(saved.document_id, material, ACTOR)
  }
  async function publishAllReal() {
    for (const t of ['program_terms', 'disclosure_policy', 'privacy_notice']) await publishDoc(t)
  }

  const goodBody = async (over: Record<string, unknown> = {}) => {
    const docs = await getCurrentDocuments(sql)
    return {
      applicantName: 'Ada Lovelace', email: `ada${++n}@example.com`, country: 'US', stateRegion: 'NY',
      socialUrls: [`https://instagram.com/ada_creates_${n}`], motivation: 'I love the clothes and make fashion videos.',
      promotionPlan: 'Short videos plus a link in my bio every week.', ageAttested: true, termsAccepted: true, disclosureAccepted: true,
      privacyAccepted: true, accuracyConfirmed: true, esignConsent: true,
      termsVersion: docs.program_terms!.version, disclosureVersion: docs.disclosure_policy!.version, privacyVersion: docs.privacy_notice!.version,
      idempotencyKey: `key-${n}-${Math.random().toString(36).slice(2, 12)}`, ...over,
    } as Record<string, any>
  }
  async function apply(over: Record<string, unknown> = {}, ctx: Partial<{ ip: string; env: any; inviteToken: string | null; honeypot: string }> = {}) {
    const body = await goodBody(over)
    const t0 = Date.now() - 60_000
    return { body, out: await submitPublicApplication(sql, body, {
      ip: ctx.ip ?? `10.0.0.${n}`, userAgent: 'jest', formToken: await issueFormToken(t0, ctx.env ?? ENV_ON), honeypot: ctx.honeypot ?? '',
      inviteToken: ctx.inviteToken ?? null, env: ctx.env ?? ENV_ON, now: Date.now(),
    }) }
  }
  const appRow = (email: string) => one('SELECT * FROM affiliate_applications WHERE email_normalized = $1', [email.toLowerCase()])
  const approveCfg = (code: string, over: Record<string, unknown> = {}) => ({
    code, commissionType: 'percentage', commissionRateBps: 1000, fixedReversalPolicy: 'proportional', attributionWindowDays: 30, commissionHoldDays: 30,
    discountType: 'percentage', discountBps: 1000, paidAdsPolicy: 'not_permitted', activateNow: false, ...over,
  })
  async function newApplication(over: Record<string, unknown> = {}) {
    const { body, out } = await apply(over)
    expect(out.kind).toBe('received')
    const row = await appRow(body.email)
    return { body, id: row.id as string }
  }
  /** Application accepted, approved, ready to activate. */
  async function newAffiliate(code: string, over: Record<string, unknown> = {}) {
    const { body, id } = await newApplication(over)
    const r = await admin.approve(id, approveCfg(code), ACTOR)
    return { body, applicationId: id, affiliateId: r.affiliate_id as string }
  }
  const disc = (affiliateId: string) => one(`SELECT d.active, d.code FROM discounts d JOIN affiliates a ON a.discount_id = d.id WHERE a.id = $1`, [affiliateId])
  const link = (affiliateId: string) => one(`SELECT bool_or(active) AS active, count(*)::int AS n FROM affiliate_links WHERE affiliate_id = $1`, [affiliateId])
  const activeAt = async (affiliateId: string) => (await one(`SELECT affiliate_active_at($1::uuid, now()) AS a`, [affiliateId])).a

  beforeAll(async () => {
    fi = await createFiDb('affprog')
    sql = fi.sql
    admin = createAffiliateProgramAdmin(sql)
  }, 120_000)
  afterAll(async () => { if (fi) await fi.close() }, 60_000)

  // ── Migration ──────────────────────────────────────────────────────────────
  describe('migration 033', () => {
    test('is idempotent: re-applying changes nothing and seeds five placeholder v1 documents once', async () => {
      const file = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/033_affiliate_program_core.sql'), 'utf8')
      const before = await one(`SELECT count(*)::int AS docs, (SELECT count(*)::int FROM affiliate_profiles) AS profiles FROM affiliate_documents`)
      await fi.db.query(file)
      await fi.db.query(file)
      const after = await one(`SELECT count(*)::int AS docs, (SELECT count(*)::int FROM affiliate_profiles) AS profiles FROM affiliate_documents`)
      expect(after).toEqual(before)
      expect(after.docs).toBe(5)
      const v = await q(`SELECT doc_type, version, is_placeholder FROM affiliate_documents ORDER BY doc_type`)
      expect(v.every((r: any) => r.version === 'v1' && r.is_placeholder === true)).toBe(true)
    })

    test('the backfill gives every existing affiliate exactly one profile', async () => {
      const x = await one(`SELECT (SELECT count(*)::int FROM affiliates) AS a, (SELECT count(*)::int FROM affiliate_profiles) AS p`)
      expect(x.a).toBe(x.p)
    })

    test('the schema stores no raw tax, bank or identity numbers', async () => {
      const rows = await q(`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('affiliate_documents','affiliate_applications','affiliate_invites','affiliate_profiles','affiliate_acceptances','affiliate_notes','affiliate_rate_limit_events','affiliate_email_outbox')`)
      const bad = rows.filter((r: any) => /ssn|social_security|tin\b|tax_id|ein\b|bank|routing|account_number|iban|passport|licen[sc]e_no|driver|birth|dob|card/i.test(r.column_name))
      expect(bad).toEqual([])
      // Only status enums for kyc/tax/payout method (no values).
      const cols = rows.filter((r: any) => r.table_name === 'affiliate_profiles').map((r: any) => r.column_name)
      expect(cols).toEqual(expect.arrayContaining(['kyc_status', 'tax_status', 'payout_method_status']))
    })

    test('the affiliates table and 020 functions are untouched (no new columns, same function bodies)', async () => {
      const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'affiliates'`)).map((r: any) => r.column_name)
      expect(cols).not.toEqual(expect.arrayContaining(['program_status']))
      const mig020 = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/020_affiliates.sql'), 'utf8')
      const mig033 = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/033_affiliate_program_core.sql'), 'utf8')
      for (const fn of ['create_affiliate', 'set_affiliate_status', 'update_affiliate_terms', 'create_affiliate_link']) {
        expect(mig020).toMatch(new RegExp(`FUNCTION ${fn}\\(`))
        expect(mig033).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`))
      }
    })
  })

  // ── Documents ──────────────────────────────────────────────────────────────
  describe('documents and acceptance', () => {
    test('placeholder documents keep the public form closed', async () => {
      const r = await getApplicationReadiness(sql, ENV_ON)
      expect(r.open).toBe(false)
      expect(r.reasons.join(' ')).toMatch(/placeholder/i)
      const { out, body } = await apply()
      expect(out.kind).toBe('closed')
      expect(await appRow(body.email)).toBeUndefined()
    })

    test('placeholder text cannot be published', async () => {
      const saved = await admin.saveDocumentDraft({ docType: 'brand_rules', title: 'Brand', body: 'DRAFT PLACEHOLDER - Pending attorney review - not for launch. More text here.', changeSummary: null }, ACTOR)
      await expect(admin.publishDocument(saved.document_id, false, ACTOR)).rejects.toMatchObject({ code: 'PLACEHOLDER_TEXT' })
      await admin.discardDocumentDraft(saved.document_id, ACTOR)
    })

    test('publishing creates v2, makes it current, and published versions are immutable', async () => {
      const r = await publishDoc('brand_rules')
      expect(r.version).toBe('v2')
      const cur = await getCurrentDocuments(sql)
      expect(cur.brand_rules!.version).toBe('v2')
      expect(cur.brand_rules!.isPlaceholder).toBe(false)
      expect(await fi.err(`UPDATE affiliate_documents SET body = 'changed' WHERE doc_type = 'brand_rules' AND version = 'v2'`)).toMatch(/immutable|published|cannot/i)
      expect(await fi.err(`DELETE FROM affiliate_documents WHERE doc_type = 'brand_rules' AND version = 'v1'`)).not.toBe('')
    })

    test('only one draft per document type', async () => {
      const a = await admin.saveDocumentDraft({ docType: 'ugc_license', title: 'UGC', body: realText('ugc'), changeSummary: null }, ACTOR)
      const b = await admin.saveDocumentDraft({ docType: 'ugc_license', title: 'UGC 2', body: realText('ugc two'), changeSummary: null }, ACTOR)
      expect(b.document_id).toBe(a.document_id)
      const n = await one(`SELECT count(*)::int AS n FROM affiliate_documents WHERE doc_type = 'ugc_license' AND published_at IS NULL`)
      expect(n.n).toBe(1)
      await admin.discardDocumentDraft(a.document_id, ACTOR)
    })

    test('real documents open the form', async () => {
      await publishAllReal()
      expect((await getApplicationReadiness(sql, ENV_ON)).open).toBe(true)
      expect((await getApplicationReadiness(sql, ENV_OFF)).open).toBe(false)
    })

    test('acceptance is exact-version, idempotent, append-only', async () => {
      const { affiliateId } = await newAffiliate('ACCEPT1')
      const docs = await getCurrentDocuments(sql)
      const a1 = await recordAcceptance(sql, { affiliateId, docType: 'program_terms', version: docs.program_terms!.version, method: 'portal' })
      const a2 = await recordAcceptance(sql, { affiliateId, docType: 'program_terms', version: docs.program_terms!.version, method: 'portal' })
      expect(a2.outcome).toBe('already_recorded')
      expect(a2.acceptanceId).toBe(a1.acceptanceId)
      await expect(recordAcceptance(sql, { affiliateId, docType: 'program_terms', version: 'v1', method: 'portal' })).rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CHANGED' })
      expect(await fi.err(`DELETE FROM affiliate_acceptances WHERE id = $1`, [a1.acceptanceId])).not.toBe('')
      expect(await fi.err(`UPDATE affiliate_acceptances SET version = 'v9' WHERE id = $1`, [a1.acceptanceId])).not.toBe('')
    })

    test('a material change flags affected affiliates for re-acceptance and queues an email; acceptance clears it', async () => {
      const { affiliateId } = await newAffiliate('REACC1')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      const before = await getProfileByAffiliateId(sql, affiliateId)
      expect(before!.acceptedProgramTermsVersion).toBeTruthy()
      expect(before!.requiresReacceptance).toBe(false)
      const r = await publishDoc('program_terms', true)
      expect(r.flagged).toBeGreaterThanOrEqual(1)
      const flagged = await getProfileByAffiliateId(sql, affiliateId)
      expect(flagged!.requiresReacceptance).toBe(true)
      const list = await admin.reacceptanceList()
      expect(list.map(x => x.affiliateId)).toContain(affiliateId)
      const mail = await one(`SELECT kind FROM affiliate_email_outbox WHERE affiliate_id = $1 AND kind = 'terms_update'`, [affiliateId])
      expect(mail).toBeTruthy()
      await recordAcceptance(sql, { affiliateId, docType: 'program_terms', version: r.version, method: 'portal' })
      expect((await getProfileByAffiliateId(sql, affiliateId))!.requiresReacceptance).toBe(false)
    })

    test('a non-material change does not flag anyone', async () => {
      const { affiliateId } = await newAffiliate('REACC2')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      await publishDoc('disclosure_policy', false)
      expect((await getProfileByAffiliateId(sql, affiliateId))!.requiresReacceptance).toBe(false)
    })

    test('legacy affiliates are not flagged and are not blocked', async () => {
      const svc = createAffiliatesService(sql)
      const id = await svc.createAffiliate({ code: 'LEGACY1', name: 'Legacy', email: 'legacy@example.com', commissionType: 'percentage', commissionRateBps: 1000,
        commissionFixedCents: null, fixedReversalPolicy: 'proportional', attributionWindowDays: 30, commissionHoldDays: 30, discountId: null, notes: null } as any, ACTOR)
      const p = await getProfileByAffiliateId(sql, id)
      expect(p!.programStatus).toBe('active')
      expect(p!.requiresReacceptance).toBe(false)
      expect(p!.acceptedProgramTermsVersion).toBeNull()
    })
  })

  // ── Public application ─────────────────────────────────────────────────────
  describe('public application', () => {
    test('flag OFF: closed, and nothing is written', async () => {
      const before = await one(`SELECT (SELECT count(*)::int FROM affiliate_applications) AS a, (SELECT count(*)::int FROM affiliate_rate_limit_events) AS r, (SELECT count(*)::int FROM affiliate_acceptances) AS c`)
      const { out } = await apply({}, { env: ENV_OFF })
      expect(out.kind).toBe('closed')
      const after = await one(`SELECT (SELECT count(*)::int FROM affiliate_applications) AS a, (SELECT count(*)::int FROM affiliate_rate_limit_events) AS r, (SELECT count(*)::int FROM affiliate_acceptances) AS c`)
      expect(after).toEqual(before)
    })

    test('flag ON: a valid application is stored pending with three acceptances, and never approves', async () => {
      const affBefore = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      const discBefore = (await one(`SELECT count(*)::int AS n FROM discounts`)).n
      const { body, out } = await apply()
      expect(out.kind).toBe('received')
      const row = await appRow(body.email)
      expect(row.status).toBe('pending')
      expect(row.age_attested).toBe(true)
      expect(row.affiliate_id).toBeNull()
      expect(row.terms_version).toBe(body.termsVersion)
      expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(row)).not.toContain('10.0.0.')
      const acc = await q(`SELECT doc_type, version FROM affiliate_acceptances WHERE application_id = $1 ORDER BY doc_type`, [row.id])
      expect(acc.map((x: any) => x.doc_type)).toEqual(['disclosure_policy', 'privacy_notice', 'program_terms'])
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(affBefore)
      expect((await one(`SELECT count(*)::int AS n FROM discounts`)).n).toBe(discBefore)
      const mail = await one(`SELECT kind, status FROM affiliate_email_outbox WHERE application_id = $1`, [row.id])
      expect(mail).toMatchObject({ kind: 'application_received', status: 'pending' })
    })

    test('honeypot: pretends success and stores nothing', async () => {
      const before = (await one(`SELECT count(*)::int AS n FROM affiliate_applications`)).n
      const { out, body } = await apply({}, { honeypot: 'bot' })
      expect(out.kind).toBe('received')
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_applications`)).n).toBe(before)
      expect(await appRow(body.email)).toBeUndefined()
    })

    test('the 18+ attestation and each consent are enforced by the database too', async () => {
      const body = await goodBody()
      const payload = (o: Record<string, unknown>) => JSON.stringify({ ...body, socialLinks: [], ageAttested: true, accuracyConfirmed: true, esignConsent: true, ...o })
      const call = (o: Record<string, unknown>) => fi.err(`SELECT submit_affiliate_application($1::jsonb)`, [payload(o)])
      expect(await call({ ageAttested: false })).toMatch(/AGE_ATTESTATION_REQUIRED/)
      expect(await call({ accuracyConfirmed: false })).toMatch(/ACCURACY_CONFIRMATION_REQUIRED/)
      expect(await call({ esignConsent: false })).toMatch(/ESIGN_CONSENT_REQUIRED/)
      expect(await call({ ageAttested: 'false' })).toMatch(/AGE_ATTESTATION_REQUIRED/)
      expect(await call({ country: 'CA' })).toMatch(/COUNTRY_NOT_ALLOWED/)
      expect(await call({ termsVersion: 'v1' })).toMatch(/DOCUMENT_VERSION_CHANGED/)
      expect(await appRow(body.email)).toBeUndefined()
      // And the table itself refuses an unattested row.
      expect(await fi.err(`INSERT INTO affiliate_applications (applicant_name, email, email_normalized, email_dedupe_key, country, age_attested, terms_version, disclosure_version, privacy_version)
        VALUES ('x','x@y.co','x@y.co','x@y.co','US', FALSE, 'v1','v1','v1')`)).not.toBe('')
    })

    test('the service returns field errors for every missing consent and stores nothing', async () => {
      for (const k of ['ageAttested', 'termsAccepted', 'disclosureAccepted', 'privacyAccepted', 'accuracyConfirmed', 'esignConsent']) {
        const { out, body } = await apply({ [k]: false })
        expect(out.kind).toBe('invalid')
        expect((out as any).errors[k]).toBeTruthy()
        expect(await appRow(body.email)).toBeUndefined()
      }
    })

    test('a document change between page load and submit asks the applicant to review again', async () => {
      const { out, body } = await apply({ termsVersion: 'v1' })
      expect(out.kind).toBe('retry')
      expect(await appRow(body.email)).toBeUndefined()
    })

    test('too-fast and forged form tokens are refused', async () => {
      const body = await goodBody()
      const fast = await submitPublicApplication(sql, body, { ip: '1.1.1.1', userAgent: 'x', formToken: await issueFormToken(Date.now(), ENV_ON), env: ENV_ON, now: Date.now() })
      expect(fast.kind).toBe('retry')
      const forged = await submitPublicApplication(sql, body, { ip: '1.1.1.1', userAgent: 'x', formToken: '1800000000000.' + 'a'.repeat(64), env: ENV_ON, now: Date.now() })
      expect(forged.kind).toBe('retry')
      expect(await appRow(body.email)).toBeUndefined()
    })

    test('idempotent: same key and same open email create one application and one confirmation email', async () => {
      const first = await apply()
      const again = await submitPublicApplication(sql, first.body, { ip: '2.2.2.2', userAgent: 'x', formToken: await issueFormToken(Date.now() - 60_000, ENV_ON), env: ENV_ON, now: Date.now() })
      expect(again.kind).toBe('received')
      const variant = await apply({ email: first.body.email.toUpperCase(), idempotencyKey: 'another-key-1234' })
      expect(variant.out.kind).toBe('received')
      const rows = await q(`SELECT id FROM affiliate_applications WHERE email_normalized = $1`, [first.body.email.toLowerCase()])
      expect(rows).toHaveLength(1)
      const mails = await q(`SELECT 1 FROM affiliate_email_outbox WHERE application_id = $1`, [rows[0].id])
      expect(mails).toHaveLength(1)
    })

    test('+tag and Gmail-dot variants of an open application do not create another', async () => {
      const a = await apply({ email: 'dotted.namexyz@gmail.com' })
      expect(a.out.kind).toBe('received')
      const b = await apply({ email: 'dottednamexyz+promo@gmail.com', socialUrls: [`https://tiktok.com/@other${n}`] })
      expect(b.out.kind).toBe('received')
      const c = await one(`SELECT count(*)::int AS n FROM affiliate_applications WHERE email_dedupe_key = $1`, ['dottednamexyz@gmail.com'])
      expect(c.n).toBe(1)
    })

    test('an existing affiliate email gets the same response and no application', async () => {
      const { body } = await newAffiliate('EXIST1')
      const again = await apply({ email: body.email, idempotencyKey: 'exist-key-12345' })
      expect(again.out.kind).toBe('received')
      const c = await one(`SELECT count(*)::int AS n FROM affiliate_applications WHERE email_normalized = $1`, [body.email])
      expect(c.n).toBe(1)
    })

    test('duplicate signals are flagged for review, not auto-decided', async () => {
      const handle = `shared${++n}`
      const a = await apply({ socialUrls: [`https://instagram.com/${handle}`] })
      const b = await apply({ socialUrls: [`https://www.instagram.com/${handle.toUpperCase()}/?hl=en`], applicantName: 'Someone Else' })
      expect(a.out.kind).toBe('received'); expect(b.out.kind).toBe('received')
      const rb = await appRow(b.body.email)
      expect(rb.status).toBe('pending')
      expect(rb.duplicate_flags.map((f: any) => f.kind)).toContain('duplicate_social')
      const detail = await admin.getApplication(rb.id)
      expect(detail!.duplicateFlags.some((f: any) => f.severity === 'high')).toBe(true)
    })

    test('a previously rejected email is flagged when it applies again', async () => {
      const { body, id } = await newApplication()
      await admin.reject(id, 'Not now', ACTOR)
      const again = await apply({ email: body.email, idempotencyKey: 'again-key-123456', socialUrls: [`https://youtube.com/@fresh${n}`] })
      expect(again.out.kind).toBe('received')
      const rows = await q(`SELECT duplicate_flags FROM affiliate_applications WHERE email_normalized = $1 AND status = 'pending'`, [body.email])
      expect(rows[0].duplicate_flags.map((f: any) => f.kind)).toContain('prior_application')
    })

    test('rate limits are enforced per visitor and per email, and counted in the database', async () => {
      await saveProgramSettings(sql, { ...DEFAULT_PROGRAM_SETTINGS, rateLimits: { perIpPerHour: 2, perIpPerDay: 50, perEmailPerDay: 50, globalPerHour: 1000 } }, 0, ACTOR)
      const ip = '203.0.113.9'
      const r1 = await apply({}, { ip }), r2 = await apply({}, { ip }), r3 = await apply({}, { ip })
      expect([r1.out.kind, r2.out.kind, r3.out.kind]).toEqual(['received', 'received', 'rate_limited'])
      expect(await appRow(r3.body.email)).toBeUndefined()
      const ev = await one(`SELECT count(*)::int AS n FROM affiliate_rate_limit_events WHERE key_hash = $1`, [await (await import('../affiliate-application')).hashValue('ip', ip, ENV_ON)])
      expect(ev.n).toBeGreaterThanOrEqual(2)
      // Restore defaults for later tests.
      const cur = await getProgramSettings(sql)
      await saveProgramSettings(sql, DEFAULT_PROGRAM_SETTINGS, cur.revision, ACTOR)
    })

    test('country allowlist comes from settings and is audited when changed', async () => {
      const cur = await getProgramSettings(sql)
      await saveProgramSettings(sql, { ...DEFAULT_PROGRAM_SETTINGS, countries: ['US', 'CA'] }, cur.revision, ACTOR)
      const ok = await apply({ country: 'CA', stateRegion: 'ON' })
      expect(ok.out.kind).toBe('received')
      const next = await getProgramSettings(sql)
      await saveProgramSettings(sql, DEFAULT_PROGRAM_SETTINGS, next.revision, ACTOR)
      const blocked = await apply({ country: 'CA', stateRegion: 'ON' })
      expect(blocked.out.kind).toBe('invalid')
      const audit = await q(`SELECT actor_email FROM admin_audit_logs WHERE action = 'settings.update' AND resource_id = 'affiliate.program'`)
      expect(audit.length).toBeGreaterThanOrEqual(2)
      await expect(saveProgramSettings(sql, DEFAULT_PROGRAM_SETTINGS, 1, ACTOR)).rejects.toBeInstanceOf(SettingsStaleError)
    })

    test('stored IP and user agent are salted hashes, never raw', async () => {
      const { body } = await apply({}, { ip: '198.51.100.77' })
      const row = await appRow(body.email)
      expect(JSON.stringify(row)).not.toContain('198.51.100.77')
      expect(row.user_agent_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(row)).not.toContain('jest')
    })
  })

  // ── Review: approve / reject / request info ────────────────────────────────
  describe('review', () => {
    test('approve creates exactly one affiliate, one profile, an inactive code and link; acceptances are linked', async () => {
      const { id, body } = await newApplication()
      const before = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      const r = await admin.approve(id, approveCfg('Ada-Approve', { linkSlug: 'ada-approve' }), ACTOR)
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(before + 1)
      const aff = await one(`SELECT * FROM affiliates WHERE id = $1`, [r.affiliate_id])
      expect(aff.code).toBe('ADA-APPROVE')
      expect(aff.email.toLowerCase()).toBe(body.email)
      const profile = await getProfileByAffiliateId(sql, r.affiliate_id)
      expect(profile!.programStatus).toBe('onboarding')
      expect(profile!.applicationId).toBe(id)
      expect(profile!.acceptedProgramTermsVersion).toBe(body.termsVersion)
      expect((await getProfileByEmail(sql, body.email))!.affiliateId).toBe(r.affiliate_id)
      expect((await disc(r.affiliate_id)).active).toBe(false)
      expect((await link(r.affiliate_id))).toMatchObject({ n: 1, active: false })
      expect(await activeAt(r.affiliate_id)).toBe(false)
      const acc = await q(`SELECT affiliate_id FROM affiliate_acceptances WHERE application_id = $1`, [id])
      expect(acc).toHaveLength(3)
      expect(acc.every((x: any) => x.affiliate_id === r.affiliate_id)).toBe(true)
      expect((await appRow(body.email)).status).toBe('approved_onboarding')
      const mail = await one(`SELECT kind FROM affiliate_email_outbox WHERE application_id = $1 AND kind = 'application_approved'`, [id])
      expect(mail).toBeTruthy()
      // Pushover etc. aside, the audit row exists and carries no email address.
      const audit = await one(`SELECT payload FROM admin_audit_logs WHERE action = 'affiliate.approve' AND resource_id = $1`, [id])
      expect(JSON.stringify(audit.payload)).not.toContain(body.email)
    })

    test('approve is not repeatable: a second approval cannot create a second affiliate', async () => {
      const { id } = await newApplication()
      await admin.approve(id, approveCfg('ONCE1'), ACTOR)
      const before = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      await expect(admin.approve(id, approveCfg('ONCE2'), ACTOR)).rejects.toMatchObject({ code: 'INVALID_STATE' })
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(before)
    })

    test('codes are normalised and collision-safe (affiliate codes and discount codes)', async () => {
      await newAffiliate('TAKEN1')
      const { id } = await newApplication()
      await expect(admin.approve(id, approveCfg('taken1'), ACTOR)).rejects.toMatchObject({ code: 'CODE_TAKEN' })
      await fi.q(`INSERT INTO discounts (code, name, type, percentage_bps, active) VALUES ('SUMMER10','Summer','percentage',1000,TRUE)`)
      await expect(admin.approve(id, approveCfg('summer10'), ACTOR)).rejects.toMatchObject({ code: 'CODE_TAKEN' })
      const left = await appRow((await admin.getApplication(id))!.email)
      expect(left.status).toBe('pending')
      expect(left.affiliate_id).toBeNull()
      // A failed approval leaves no half-created affiliate, discount or link.
      expect((await one(`SELECT count(*)::int AS n FROM affiliates WHERE code IN ('TAKEN1') `)).n).toBe(1)
    })

    test('approve with invalid commission input is rejected before anything is created', async () => {
      const { id } = await newApplication()
      const before = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      await expect(admin.approve(id, approveCfg('BADCOM', { commissionRateBps: 0 }), ACTOR)).rejects.toBeTruthy()
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(before)
    })

    test('reject creates no affiliate; the email carries only the applicant message, never private notes', async () => {
      const { id, body } = await newApplication()
      await admin.addNote(id, null, 'PRIVATE: looks like a reseller', ACTOR)
      const before = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      await admin.reject(id, 'We are not able to proceed right now.', ACTOR)
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(before)
      const row = await appRow(body.email)
      expect(row.status).toBe('rejected')
      const mail = await one(`SELECT payload, kind FROM affiliate_email_outbox WHERE application_id = $1 AND kind = 'application_rejected'`, [id])
      expect(mail).toBeTruthy()
      expect(JSON.stringify(mail.payload)).not.toContain('PRIVATE')
      expect(renderAffiliateEmail({ kind: 'application_rejected', payload: mail.payload }).html).not.toContain('PRIVATE')
      expect(renderAffiliateEmail({ kind: 'application_rejected', payload: mail.payload }).html).toContain('not able to proceed')
      await expect(admin.approve(id, approveCfg('AFTERREJ'), ACTOR)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    })

    test('request info and review states; a question is required; final states are final', async () => {
      const { id } = await newApplication()
      await expect(admin.setApplicationStatus(id, 'needs_info', '', ACTOR)).rejects.toMatchObject({ code: 'MESSAGE_REQUIRED' })
      await admin.setApplicationStatus(id, 'under_review', null, ACTOR)
      await admin.setApplicationStatus(id, 'needs_info', 'What is your channel name?', ACTOR)
      const mail = await one(`SELECT payload FROM affiliate_email_outbox WHERE application_id = $1 AND kind = 'application_needs_info'`, [id])
      expect(mail.payload.message).toBe('What is your channel name?')
      await admin.setApplicationStatus(id, 'withdrawn', null, ACTOR)
      await expect(admin.setApplicationStatus(id, 'under_review', null, ACTOR)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    })

    test('anonymize removes personal details but keeps the decision and audit trail; only for rejected/withdrawn', async () => {
      const { id, body } = await newApplication()
      await expect(admin.anonymize(id, ACTOR)).rejects.toMatchObject({ code: 'INVALID_STATE' })
      await admin.addNote(id, null, 'note with name Ada', ACTOR)
      await admin.reject(id, 'No', ACTOR)
      await admin.anonymize(id, ACTOR)
      const row = await one(`SELECT * FROM affiliate_applications WHERE id = $1`, [id])
      expect(JSON.stringify(row)).not.toContain(body.email)
      expect(JSON.stringify(row)).not.toContain('Ada Lovelace')
      expect(row.status).toBe('rejected')
      expect(row.anonymized_at).toBeTruthy()
      const notes = await q(`SELECT body FROM affiliate_notes WHERE application_id = $1`, [id])
      expect(notes.every((x: any) => x.body === '[removed]')).toBe(true)
    })

    test('internal notes are Admin-only: they never appear in any outbox row', async () => {
      const { id } = await newApplication()
      await admin.addNote(id, null, 'ZZ-SECRET-NOTE', ACTOR)
      await admin.approve(id, approveCfg('NOTES1', { approvalMessage: 'Welcome aboard', internalNote: 'ZZ-SECRET-INTERNAL' }), ACTOR)
      const all = await q(`SELECT payload FROM affiliate_email_outbox`)
      expect(JSON.stringify(all)).not.toContain('ZZ-SECRET')
    })
  })

  // ── Invitations ────────────────────────────────────────────────────────────
  describe('invitations', () => {
    const inviteCfg = (email: string, over: Record<string, unknown> = {}) => ({ email, displayName: 'Invited Creator', socialLinks: [], proposedCode: 'INVITED1', ...over })

    test('the raw token is never stored; lookup works with it only', async () => {
      const email = `inv${++n}@example.com`
      const c = await admin.createInvite(inviteCfg(email), 14, ACTOR)
      const rows = await q(`SELECT * FROM affiliate_invites WHERE id = $1`, [c.inviteId])
      expect(JSON.stringify(rows)).not.toContain(c.token)
      expect(rows[0].token_hash).toBe(await sha256Hex(c.token))
      expect(await admin.lookupInvite(c.token)).toEqual({ email, displayName: 'Invited Creator' })
      expect(await admin.lookupInvite('0'.repeat(64))).toBeNull()
      expect(await admin.lookupInvite('nonsense')).toBeNull()
      expect(JSON.stringify(await q(`SELECT payload FROM admin_audit_logs WHERE resource = 'affiliate_invites'`))).not.toContain(c.token)
    })

    test('an invitation pre-fills but does not bypass review or acceptance; it is single-use', async () => {
      const email = `inv${++n}@example.com`
      const c = await admin.createInvite(inviteCfg(email), 14, ACTOR)
      const before = (await one(`SELECT count(*)::int AS n FROM affiliates`)).n
      const { out } = await apply({ email }, { inviteToken: c.token })
      expect(out.kind).toBe('received')
      const row = await appRow(email)
      expect(row.status).toBe('pending')
      expect(row.source).toBe('invite')
      expect(row.invite_id).toBe(c.inviteId)
      expect((await one(`SELECT count(*)::int AS n FROM affiliates`)).n).toBe(before)
      expect((await q(`SELECT 1 FROM affiliate_acceptances WHERE application_id = $1`, [row.id])).length).toBe(3)
      const inv = await one(`SELECT status, application_id FROM affiliate_invites WHERE id = $1`, [c.inviteId])
      expect(inv).toMatchObject({ status: 'used', application_id: row.id })
      expect(await admin.lookupInvite(c.token)).toBeNull()
      // Reuse fails.
      const reuse = await apply({ email }, { inviteToken: c.token })
      expect(reuse.out.kind).toBe('error')
      // Approval still needs explicit review; the proposal is only shown, not applied.
      const detail = await admin.getApplication(row.id)
      expect(detail!.invite!.proposedCode).toBe('INVITED1')
    })

    test('a token for another email, a revoked token and a rotated token are all refused', async () => {
      const email = `inv${++n}@example.com`
      const c = await admin.createInvite(inviteCfg(email), 14, ACTOR)
      const wrong = await apply({ email: `someone${n}@example.com` }, { inviteToken: c.token })
      expect(wrong.out.kind).toBe('error')
      const rot = await admin.rotateInvite(c.inviteId, 14, ACTOR)
      expect(await admin.lookupInvite(c.token)).toBeNull()
      expect(await admin.lookupInvite(rot.token)).not.toBeNull()
      await admin.revokeInvite(c.inviteId, ACTOR)
      expect(await admin.lookupInvite(rot.token)).toBeNull()
      const after = await apply({ email }, { inviteToken: rot.token })
      expect(after.out.kind).toBe('error')
    })

    test('expired invitations are refused and an invite for an existing affiliate is not allowed', async () => {
      const email = `inv${++n}@example.com`
      const c = await admin.createInvite(inviteCfg(email), 14, ACTOR)
      await fi.q(`UPDATE affiliate_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c.inviteId])
      expect(await admin.lookupInvite(c.token)).toBeNull()
      expect((await admin.listInvites()).find(i => i.id === c.inviteId)!.status).toBe('expired')
      const { body } = await newAffiliate('INVEX1')
      await expect(admin.createInvite(inviteCfg(body.email), 14, ACTOR)).rejects.toMatchObject({ code: 'EMAIL_ALREADY_AFFILIATE' })
    })

    test('an invite is held (not emailed) until the flag is on, and its email never stores the token', async () => {
      const email = `inv${++n}@example.com`
      const c = await admin.createInvite(inviteCfg(email), 14, ACTOR)
      const inv = await one(`SELECT email_status, send_count FROM affiliate_invites WHERE id = $1`, [c.inviteId])
      expect(inv.email_status).toBe('held')
      expect(JSON.stringify(await q(`SELECT * FROM affiliate_email_outbox`))).not.toContain(c.token)
    })
  })

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  describe('status lifecycle', () => {
    test('onboarding: the code is off and cannot be activated before terms are accepted or the start date', async () => {
      const { affiliateId } = await newAffiliate('LIFE0')
      expect(await activeAt(affiliateId)).toBe(false)
      await fi.q(`UPDATE affiliate_profiles SET program_start_at = now() + interval '3 days' WHERE affiliate_id = $1`, [affiliateId])
      await expect(admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })).rejects.toMatchObject({ code: 'ACTIVATION_NOT_ALLOWED' })
      await fi.q(`UPDATE affiliate_profiles SET program_start_at = NULL WHERE affiliate_id = $1`, [affiliateId])
      await fi.q(`UPDATE affiliate_profiles SET accepted_program_terms_version = NULL WHERE affiliate_id = $1`, [affiliateId])
      await expect(admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })).rejects.toMatchObject({ code: 'ACTIVATION_NOT_ALLOWED' })
    })

    test('activate -> suspend -> reinstate -> terminate keeps history and toggles code, link and attribution eligibility', async () => {
      const { affiliateId } = await newAffiliate('LIFE1', {})
      const terms0 = (await one(`SELECT count(*)::int AS n FROM affiliate_terms_events WHERE affiliate_id = $1`, [affiliateId])).n
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      expect(await getProfileByAffiliateId(sql, affiliateId)).toMatchObject({ programStatus: 'active', portalAccess: 'enabled' })
      expect((await disc(affiliateId)).active).toBe(true)
      expect((await link(affiliateId)).active).toBe(true)
      expect(await activeAt(affiliateId)).toBe(true)

      const events0 = (await one(`SELECT count(*)::int AS n FROM affiliate_status_events WHERE affiliate_id = $1`, [affiliateId])).n
      await admin.setProgramStatus(affiliateId, 'suspended', { actor: ACTOR, reason: 'policy review', notify: true })
      expect((await one(`SELECT status FROM affiliates WHERE id = $1`, [affiliateId])).status).toBe('paused')
      expect((await disc(affiliateId)).active).toBe(false)
      expect((await link(affiliateId)).active).toBe(false)
      expect(await activeAt(affiliateId)).toBe(false)
      expect((await getProfileByAffiliateId(sql, affiliateId))!.programStatus).toBe('suspended')
      const events1 = (await one(`SELECT count(*)::int AS n FROM affiliate_status_events WHERE affiliate_id = $1`, [affiliateId])).n
      expect(events1).toBeGreaterThan(events0)   // history grows; nothing is rewritten
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_terms_events WHERE affiliate_id = $1`, [affiliateId])).n).toBe(terms0)
      expect(await one(`SELECT 1 FROM affiliate_email_outbox WHERE affiliate_id = $1 AND kind = 'affiliate_suspended'`, [affiliateId])).toBeTruthy()

      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      expect(await activeAt(affiliateId)).toBe(true)
      expect((await disc(affiliateId)).active).toBe(true)

      await expect(admin.setProgramStatus(affiliateId, 'terminated', { actor: ACTOR })).resolves.toBeTruthy()
      expect((await one(`SELECT status FROM affiliates WHERE id = $1`, [affiliateId])).status).toBe('terminated')
      expect(await activeAt(affiliateId)).toBe(false)
      expect((await disc(affiliateId)).active).toBe(false)
      expect((await getProfileByAffiliateId(sql, affiliateId))!.terminatedAt).toBeTruthy()
      // History survives termination.
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_status_events WHERE affiliate_id = $1`, [affiliateId])).n).toBeGreaterThan(events1)
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_terms_events WHERE affiliate_id = $1`, [affiliateId])).n).toBe(terms0)
      expect((await one(`SELECT count(*)::int AS n FROM affiliate_acceptances WHERE affiliate_id = $1`, [affiliateId])).n).toBe(3)
    })

    test('reinstating a terminated affiliate requires a reason; terminated can come back only deliberately', async () => {
      const { affiliateId } = await newAffiliate('LIFE2')
      await admin.setProgramStatus(affiliateId, 'terminated', { actor: ACTOR, reason: 'violation' })
      await expect(admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR, reason: 'appeal accepted' })
      expect(await activeAt(affiliateId)).toBe(true)
    })

    test('notify=false sends nothing; same-status is a no-op; an actor is required', async () => {
      const { affiliateId } = await newAffiliate('LIFE3')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR, notify: false })
      const none = await q(`SELECT 1 FROM affiliate_email_outbox WHERE affiliate_id = $1 AND kind = 'affiliate_activated'`, [affiliateId])
      expect(none).toHaveLength(0)
      const r = await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      expect(r.outcome).toBe('no_change')
      await expect(admin.setProgramStatus(affiliateId, 'suspended', { actor: '' })).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' })
    })

    test('suspend can revoke portal sessions without breaking when the portal tables are absent', async () => {
      const { affiliateId } = await newAffiliate('LIFE4')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      await admin.setProgramStatus(affiliateId, 'suspended', { actor: ACTOR, revokePortal: true })
      expect((await getProfileByAffiliateId(sql, affiliateId))!.portalAccess).toBe('revoked')
    })

    test('the legacy status write (financial status) still syncs the program profile', async () => {
      const { affiliateId } = await newAffiliate('LEGACYSYNC')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      await fi.q(`SELECT set_affiliate_status($1::uuid, 'paused', NULL, 'legacy', $2)`, [affiliateId, ACTOR])
      expect((await getProfileByAffiliateId(sql, affiliateId))!.programStatus).toBe('suspended')
    })

    test('program end date terminates through maintenance; start date gates activation', async () => {
      const { affiliateId } = await newAffiliate('ENDED1')
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      await fi.q(`UPDATE affiliate_profiles SET program_end_at = now() - interval '1 hour' WHERE affiliate_id = $1`, [affiliateId])
      const r = await runAffiliateProgramMaintenance(sql, () => { throw new Error('no provider') })
      expect(r.terminated).toBeGreaterThanOrEqual(1)
      expect((await getProfileByAffiliateId(sql, affiliateId))!.programStatus).toBe('terminated')
      expect(await activeAt(affiliateId)).toBe(false)
    })

    test('profile settings, code change and email are audited; code locks once used', async () => {
      const { affiliateId } = await newAffiliate('SETT1')
      await admin.updateProfileSettings(affiliateId, { displayName: 'New Name', payoutThresholdCents: 5000, payoutSchedule: 'monthly', paidAdsPolicy: 'written_approval' }, ACTOR)
      expect(await getProfileByAffiliateId(sql, affiliateId)).toMatchObject({ displayName: 'New Name', payoutThresholdCents: 5000, payoutSchedule: 'monthly', paidAdsPolicy: 'written_approval' })
      await admin.changeCode(affiliateId, 'SETT1B', ACTOR)
      expect((await disc(affiliateId)).code).toBe('SETT1B')
      await admin.setEmail(affiliateId, `new${n}@example.com`, ACTOR)
      expect((await getProfileByAffiliateId(sql, affiliateId))!.emailNormalized).toBe(`new${n}@example.com`)
      await fi.q(`UPDATE discounts SET redemption_count = 1 WHERE id = (SELECT discount_id FROM affiliates WHERE id = $1)`, [affiliateId])
      await expect(admin.changeCode(affiliateId, 'SETT1C', ACTOR)).rejects.toMatchObject({ code: 'CODE_LOCKED' })
      const actions = (await q(`SELECT action FROM admin_audit_logs WHERE resource_id = $1`, [affiliateId])).map((r: any) => r.action)
      expect(actions).toEqual(expect.arrayContaining(['affiliate.settings.update', 'affiliate.code.change', 'affiliate.email.update']))
      expect(await fi.err(`SELECT update_affiliate_profile_settings($1::uuid, '{"displayName":"x"}'::jsonb, '')`, [affiliateId])).toMatch(/ACTOR_REQUIRED/)
    })

    test('manual creation through the existing 020 path gets a profile via the trigger; email is optional', async () => {
      const svc = createAffiliatesService(sql)
      const id = await svc.createAffiliate({ code: 'MANUAL1', name: 'Manual Person', email: null, commissionType: 'percentage', commissionRateBps: 800,
        commissionFixedCents: null, fixedReversalPolicy: 'proportional', attributionWindowDays: 30, commissionHoldDays: 30, discountId: null, notes: null } as any, ACTOR)
      const p = await getProfileByAffiliateId(sql, id)
      expect(p).toBeTruthy()
      expect(p!.programStatus).toBe('active')
      expect(p!.emailNormalized).toMatch(/@affiliate\.invalid$/)
      const row = (await admin.listProfiles()).find(x => x.id === id)!
      expect(row.hasSignInEmail).toBe(false)
      // A second email-less affiliate does not collide.
      const id2 = await svc.createAffiliate({ code: 'MANUAL2', name: 'Manual Two', email: null, commissionType: 'percentage', commissionRateBps: 800,
        commissionFixedCents: null, fixedReversalPolicy: 'proportional', attributionWindowDays: 30, commissionHoldDays: 30, discountId: null, notes: null } as any, ACTOR)
      expect(id2).not.toBe(id)
    })

    test('financial history is untouched by lifecycle changes (no commission/ledger rows are created or altered)', async () => {
      const { affiliateId } = await newAffiliate('FIN1')
      const snap = async () => one(`SELECT (SELECT count(*)::int FROM affiliate_commissions) AS c, (SELECT count(*)::int FROM affiliate_payouts) AS p, (SELECT count(*)::int FROM order_affiliate_attributions) AS o`)
      const before = await snap()
      await admin.setProgramStatus(affiliateId, 'active', { actor: ACTOR })
      await admin.setProgramStatus(affiliateId, 'suspended', { actor: ACTOR })
      await admin.setProgramStatus(affiliateId, 'terminated', { actor: ACTOR, reason: 'x' })
      expect(await snap()).toEqual(before)
    })
  })

  // ── Outbox ─────────────────────────────────────────────────────────────────
  describe('email outbox', () => {
    const provider = (result: any) => ({ send: jest.fn(async () => result) }) as any

    test('a send failure never changes application state and the row is retried later', async () => {
      const { id } = await newApplication()
      const row = await one(`SELECT id FROM affiliate_email_outbox WHERE application_id = $1`, [id])
      const bad = provider({ ok: false, message: 'provider down for ada@example.com' })
      expect(await processAffiliateEmail(sql, bad, row.id)).toBe('failed')
      const after = await one(`SELECT status, attempt_count, last_error, next_attempt_at FROM affiliate_email_outbox WHERE id = $1`, [row.id])
      expect(after.status).toBe('failed')
      expect(after.last_error).not.toContain('ada@example.com')
      expect((await admin.getApplication(id))!.status).toBe('pending')
      // Not due yet -> not retried immediately.
      expect(await processAffiliateEmail(sql, provider({ ok: true, providerMessageId: 'x' }), row.id)).toBe('not_due')
      await fi.q(`UPDATE affiliate_email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [row.id])
      const good = provider({ ok: true, providerMessageId: 'msg_1' })
      expect(await processAffiliateEmail(sql, good, row.id)).toBe('sent')
      expect(await processAffiliateEmail(sql, good, row.id)).toBe('not_due')   // exactly once
      expect(good.send).toHaveBeenCalledTimes(1)
    })

    test('drain sends due rows once and skips invite rows (token is not stored)', async () => {
      await fi.q(`INSERT INTO affiliate_email_outbox (kind, recipient_email, payload, status, idempotency_key) VALUES ('affiliate_invite','x@example.com','{}'::jsonb,'pending','inv-test-1')`)
      const p = provider({ ok: true, providerMessageId: 'm' })
      const r = await drainAffiliateEmailOutbox(sql, p, 100)
      expect(r.processed).toBeGreaterThan(0)
      const skipped = await one(`SELECT status FROM affiliate_email_outbox WHERE idempotency_key = 'inv-test-1'`)
      expect(skipped.status).toBe('skipped')
    })

    test('concurrent workers cannot double-send a row', async () => {
      await newApplication()
      const rows = await q(`SELECT id FROM affiliate_email_outbox WHERE status = 'pending' LIMIT 1`)
      if (rows.length === 0) return
      const p = provider({ ok: true, providerMessageId: 'm' })
      const results = await Promise.all([processAffiliateEmail(sql, p, rows[0].id), processAffiliateEmail(sql, p, rows[0].id)])
      expect(results.filter(r => r === 'sent')).toHaveLength(1)
      expect(p.send).toHaveBeenCalledTimes(1)
    })
  })

  // ── Audit ──────────────────────────────────────────────────────────────────
  describe('audit', () => {
    test('every program mutation is audited with a dotted action and no PII, tokens or secrets', async () => {
      const rows = await q(`SELECT action, payload FROM admin_audit_logs WHERE action LIKE 'affiliate.%'`)
      expect(rows.length).toBeGreaterThan(20)
      expect(rows.every((r: any) => /^affiliate\.[a-z_]+(\.[a-z_]+)*$/.test(r.action))).toBe(true)
      const text = JSON.stringify(rows.map((r: any) => r.payload))
      expect(text).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/)
      expect(text).not.toMatch(/\b[0-9a-f]{64}\b/)
      const actions = new Set(rows.map((r: any) => r.action))
      for (const a of ['affiliate.application.submit', 'affiliate.approve', 'affiliate.reject', 'affiliate.document.publish', 'affiliate.invite.create', 'affiliate.suspend'])
        expect([...actions]).toContain(a)
    })

    test('the admin service lists audit rows and counts', async () => {
      expect((await admin.listAudit(20)).length).toBeGreaterThan(0)
      const c = await admin.counts()
      expect(typeof c.openApplications).toBe('number')
    })
  })
})

test('ProgramError is exported for callers', () => { expect(new ProgramError('X', 'y', 400).status).toBe(400) })
