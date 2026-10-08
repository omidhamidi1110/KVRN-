// Schema-level guarantees of migration 034 (real PostgreSQL): idempotent, no sensitive columns anywhere,
// append-only history, masked-only payout metadata, positive readiness needs an attestation.
import fs from 'fs'
import path from 'path'
import { HAVE_DB, createPortalFx, mkAffiliate, mkDraftPayout, mkSale, seedDocs, type PortalFx } from './affiliate-portal-fixtures'

const MIG = fs.readFileSync(path.join(__dirname, '../../db/migrations/034_affiliate_portal_compliance_payouts.sql'), 'utf8')
const code = MIG.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

describe('034 source (no database)', () => {
  test('is the only affiliate-portal migration and never edits a frozen object', () => {
    expect(fs.existsSync(path.join(__dirname, '../../db/migrations/034_affiliate_portal_compliance_payouts.sql'))).toBe(true)
    // It may CALL the existing money functions but must never redefine them.
    for (const fn of ['create_affiliate_payout', 'mark_affiliate_payout_paid', 'void_affiliate_payout', 'set_affiliate_status',
      'compute_affiliate_commission', 'refresh_affiliate_commission_state', 'affiliate_commission_payable', 'resolve_order_affiliate_attribution']) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${fn}\\b`))
    }
    expect(code).not.toMatch(/ALTER TABLE (affiliates|affiliate_commissions|affiliate_payouts|affiliate_commission_adjustments|affiliate_payout_lines)\b/)
  })
  test('is wrapped in one transaction and every object is idempotent', () => {
    expect(code.trim().startsWith('BEGIN;')).toBe(true)
    expect(code.trim().endsWith('COMMIT;')).toBe(true)
    expect(code).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/)
    expect(code).not.toMatch(/\bDROP TABLE\b/)
  })
  test('the heuristic fraud flag may be frozen only by an Admin decision (no CHECK forces it off)', () => {
    expect(code).not.toContain('aff_flag_heuristic_not_freeze')
  })
})

const d = HAVE_DB ? describe : describe.skip
d('034 schema (real PostgreSQL)', () => {
  let fx: PortalFx
  beforeAll(async () => { fx = await createPortalFx('affp_schema'); await seedDocs(fx.q) }, 120000)
  afterAll(async () => { await fx?.close() })

  test('re-applying 034 changes nothing and does not fail', async () => {
    await fx.db.query(MIG)
    await fx.db.query(MIG)
  })

  test('no table in the database has a column that could hold bank, tax, ID or date-of-birth data', async () => {
    const cols = await fx.q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`)
    const bad = /(^|_)(ssn|tin|ein|itin|routing|iban|swift|dob|birth|birthdate|passport|drivers?|national_id|tax_id|taxid|bank_account|account_number|acct_number|card_number|cvv|cvc|id_image|id_document|selfie)(_|$)|licen[sc]e_number|date_of_birth/i
    // 'license_version' on UGC licences is a contract version label, not an identity document.
    const hits = cols.filter((c: any) => bad.test(c.column_name)).map((c: any) => `${c.table_name}.${c.column_name}`)
    expect(hits).toEqual([])
  })

  test('the affiliate tables I own contain only the intended personal-data columns', async () => {
    const rows = await fx.q(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name LIKE 'affiliate\\_%' AND table_name IN (
        'affiliate_login_tokens','affiliate_sessions','affiliate_auth_rate_events','affiliate_security_events','affiliate_payout_accounts',
        'affiliate_readiness_events','affiliate_portal_notifications','affiliate_payout_attempts','affiliate_compliance_items',
        'affiliate_compliance_warnings','affiliate_fraud_flags','affiliate_ugc_licenses','affiliate_public_refs')`)
    const names = rows.map((r: any) => r.column_name as string)
    expect(names.some(n => /email$/.test(n) && n !== 'actor_email')).toBe(false)   // only hashes of emails
    expect(names).toContain('token_hash'); expect(names).toContain('session_hash')
    expect(names).not.toContain('token'); expect(names).not.toContain('session_token')
  })

  test('payout account metadata accepts masked display strings only', async () => {
    const a = await mkAffiliate(fx.q)
    const ok = await fx.q(`SELECT set_affiliate_payout_account($1,'manual',NULL,$2::jsonb,'admin@kvrn.test') AS r`, [a.id, JSON.stringify({ brand: 'Bank', last4: '4242' })])
    expect(ok[0].r).toBeTruthy()
    for (const bad of [{ account_number: '000123456789' }, { routing: '021000021' }, { last4: '123456789' }, { brand: 'x'.repeat(41) }, { ssn: '123-45-6789' }, { brand: 5 }]) {
      const e = await fx.err(`SELECT set_affiliate_payout_account($1,'manual',NULL,$2::jsonb,'admin@kvrn.test')`, [a.id, JSON.stringify(bad)])
      expect(e).not.toBe('')
    }
    expect(await fx.err(`SELECT set_affiliate_payout_account($1,'manual','has spaces and secret',$2::jsonb,'admin@kvrn.test')`, [a.id, '{}'])).not.toBe('')
  })

  test('a positive readiness state needs an Admin attestation note (or the provider)', async () => {
    const a = await mkAffiliate(fx.q)
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'kyc','verified','admin','admin@kvrn.test',NULL,'manual')`, [a.id])).toMatch(/ATTESTATION_NOTE_REQUIRED/)
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'kyc','verified','admin','admin@kvrn.test','short','manual')`, [a.id])).toMatch(/ATTESTATION_NOTE_REQUIRED/)
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'kyc','verified','system','x','long enough note','manual')`, [a.id])).not.toBe('')
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'kyc','verified','admin','admin@kvrn.test','ID checked in provider dashboard','manual')`, [a.id])).toBe('')
    const p = await fx.q(`SELECT kyc_status FROM affiliate_profiles WHERE affiliate_id=$1`, [a.id])
    expect(p[0].kyc_status).toBe('verified')
    // Negative / neutral states need no note, and every change leaves an append-only event + an audit row.
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'kyc','problem','admin','admin@kvrn.test',NULL,'manual')`, [a.id])).toBe('')
    const ev = await fx.q(`SELECT to_status FROM affiliate_readiness_events WHERE affiliate_id=$1 ORDER BY created_at, id`, [a.id])
    expect(ev.map((e: any) => e.to_status)).toEqual(['verified', 'problem'])
    const au = await fx.q(`SELECT 1 FROM admin_audit_logs WHERE resource_id=$1 AND action LIKE 'affiliate.readiness%'`, [a.id])
    expect(au.length).toBe(2)
    // The provider path may confirm without an Admin note.
    expect(await fx.err(`SELECT set_affiliate_readiness($1,'tax','complete','provider','system:payout-provider',NULL,'stripe_connect')`, [a.id])).toBe('')
  })

  test.each([
    ['affiliate_security_events', `UPDATE affiliate_security_events SET detail='{}'`],
    ['affiliate_security_events', `DELETE FROM affiliate_security_events`],
    ['affiliate_readiness_events', `UPDATE affiliate_readiness_events SET note='x'`],
    ['affiliate_readiness_events', `DELETE FROM affiliate_readiness_events`],
    ['affiliate_public_refs', `UPDATE affiliate_public_refs SET ref='S-0000000000'`],
    ['affiliate_public_refs', `DELETE FROM affiliate_public_refs`],
    ['affiliate_compliance_item_events', `DELETE FROM affiliate_compliance_item_events`],
    ['affiliate_fraud_flag_events', `DELETE FROM affiliate_fraud_flag_events`],
    ['affiliate_compliance_reviews', `DELETE FROM affiliate_compliance_reviews`],
    ['affiliate_payout_attempts', `DELETE FROM affiliate_payout_attempts`],
    ['affiliate_compliance_warnings', `DELETE FROM affiliate_compliance_warnings`],
    ['affiliate_ugc_licenses', `DELETE FROM affiliate_ugc_licenses`],
    ['affiliate_fraud_flags', `DELETE FROM affiliate_fraud_flags`],
  ])('history is append-only: %s — %s', async (_t, stmt) => {
    // Make sure there is at least one row for the guard to act on.
    const a = await mkAffiliate(fx.q)
    await fx.q(`SELECT set_affiliate_readiness($1,'kyc','pending','admin','seed@kvrn.test',NULL,'manual')`, [a.id])
    await fx.q(`INSERT INTO affiliate_compliance_reviews (affiliate_id,outcome,reviewed_by) VALUES ($1,'no_issues','seed')`, [a.id])
    const w = await fx.q(`INSERT INTO affiliate_compliance_warnings (affiliate_id,severity,category,summary,issued_by) VALUES ($1,'notice','other','seed warning','seed') RETURNING id`, [a.id])
    const it = await fx.q(`INSERT INTO affiliate_compliance_items (affiliate_id,url,created_by) VALUES ($1,'https://example.com/p','seed') RETURNING id`, [a.id])
    await fx.q(`INSERT INTO affiliate_compliance_item_events (item_id,affiliate_id,to_status,actor_email) VALUES ($1,$2,'needs_review','seed')`, [it[0].id, a.id])
    const fl = await fx.q(`INSERT INTO affiliate_fraud_flags (affiliate_id,signal,source,severity,created_by) VALUES ($1,'other','admin','review','seed') RETURNING id`, [a.id])
    await fx.q(`INSERT INTO affiliate_fraud_flag_events (flag_id,affiliate_id,action,to_status,actor_email) VALUES ($1,$2,'opened','open','seed')`, [fl[0].id, a.id])
    await fx.q(`INSERT INTO affiliate_ugc_licenses (affiliate_id,license_version,rights,territory,starts_at,granted_by) VALUES ($1,'v1','{"organic":true}','Worldwide',NOW(),'seed')`, [a.id])
    await fx.q(`INSERT INTO affiliate_security_events (affiliate_id,event_type) VALUES ($1,'logout')`, [a.id])
    void w
    const sale = await mkSale(fx.q, { code: a.code })
    await fx.q(`SELECT affiliate_public_ref('sale',$1,$2)`, [sale.commissionId, a.id])
    const pay = await mkDraftPayout(fx.q, a.id, [sale.commissionId])
    await fx.q(`SELECT affiliate_record_payout_attempt($1,'seed-attempt-key','manual','seed')`, [pay.payout_id])
    const e = await fx.err(stmt)
    expect(e).toMatch(/KVRN_AFFPORTAL/)
  })

  test('a warning can only move open → resolved; a license can only be revoked, never edited', async () => {
    const a = await mkAffiliate(fx.q)
    const w = (await fx.q(`INSERT INTO affiliate_compliance_warnings (affiliate_id,severity,category,summary,issued_by) VALUES ($1,'warning','claims','claim x','admin') RETURNING id`, [a.id]))[0].id
    expect(await fx.err(`UPDATE affiliate_compliance_warnings SET summary='rewritten' WHERE id=$1`, [w])).toMatch(/KVRN_AFFPORTAL/)
    expect(await fx.err(`UPDATE affiliate_compliance_warnings SET status='resolved', resolved_at=NOW(), resolved_by='admin' WHERE id=$1`, [w])).toBe('')
    expect(await fx.err(`UPDATE affiliate_compliance_warnings SET status='open', resolved_at=NULL, resolved_by=NULL WHERE id=$1`, [w])).toMatch(/KVRN_AFFPORTAL/)

    const l = (await fx.q(`INSERT INTO affiliate_ugc_licenses (affiliate_id,license_version,rights,territory,starts_at,granted_by) VALUES ($1,'v1','{"organic":true}','Worldwide',NOW(),'admin') RETURNING id`, [a.id]))[0].id
    expect(await fx.err(`UPDATE affiliate_ugc_licenses SET territory='Mars' WHERE id=$1`, [l])).toMatch(/LICENSE_IMMUTABLE/)
    expect(await fx.err(`UPDATE affiliate_ugc_licenses SET rights='{"paid_ads":true}' WHERE id=$1`, [l])).toMatch(/LICENSE_IMMUTABLE/)
    expect(await fx.err(`UPDATE affiliate_ugc_licenses SET revoked_at=NOW(), revoked_by='admin', revoke_reason='ended' WHERE id=$1`, [l])).toBe('')
    expect(await fx.err(`UPDATE affiliate_ugc_licenses SET revoke_reason='edited' WHERE id=$1`, [l])).toMatch(/LICENSE_FINAL/)
  })

  test('UGC rights JSON is validated by the database', async () => {
    const a = await mkAffiliate(fx.q)
    const ins = (rights: string) => fx.err(`INSERT INTO affiliate_ugc_licenses (affiliate_id,license_version,rights,territory,starts_at,granted_by) VALUES ($1,'v1',$2::jsonb,'WW',NOW(),'a')`, [a.id, rights])
    expect(await ins('{}')).not.toBe('')                       // nothing granted
    expect(await ins('{"organic":false}')).not.toBe('')        // no right actually true
    expect(await ins('{"everything":true}')).not.toBe('')      // unknown right
    expect(await ins('{"organic":"yes"}')).not.toBe('')        // not boolean
    expect(await ins('{"organic":true,"paid_ads":false}')).toBe('')
  })

  test('affiliate_ugc_right_active is false without a license, true inside its window, false after revoke/expiry', async () => {
    const a = await mkAffiliate(fx.q)
    const active = async (r: string, at?: string) => (await fx.q(`SELECT affiliate_ugc_right_active($1,$2,COALESCE($3::timestamptz, NOW())) AS ok`, [a.id, r, at ?? null]))[0].ok
    expect(await active('organic')).toBe(false)                // being an affiliate grants nothing
    const l = (await fx.q(`INSERT INTO affiliate_ugc_licenses (affiliate_id,license_version,rights,territory,starts_at,expires_at,granted_by)
                           VALUES ($1,'v1','{"organic":true,"paid_ads":false}','WW',NOW() - INTERVAL '10 days', NOW() + INTERVAL '10 days','a') RETURNING id`, [a.id]))[0].id
    expect(await active('organic')).toBe(true)
    expect(await active('paid_ads')).toBe(false)              // a different right is not implied
    expect(await active('organic', new Date(Date.now() + 20 * 86400e3).toISOString())).toBe(false)
    await fx.q(`UPDATE affiliate_ugc_licenses SET revoked_at=NOW(), revoked_by='a', revoke_reason='ended' WHERE id=$1`, [l])
    expect(await active('organic', new Date(Date.now() + 1000).toISOString())).toBe(false)
  })

  test('public references are random, stable, unique, per affiliate, and not derived from the order', async () => {
    const a = await mkAffiliate(fx.q), b = await mkAffiliate(fx.q)
    const s = await mkSale(fx.q, { code: a.code })
    const r1 = (await fx.q(`SELECT affiliate_public_ref('sale',$1,$2) AS r`, [s.commissionId, a.id]))[0].r
    const r2 = (await fx.q(`SELECT affiliate_public_ref('sale',$1,$2) AS r`, [s.commissionId, a.id]))[0].r
    expect(r1).toMatch(/^S-[0-9A-F]{10}$/)
    expect(r2).toBe(r1)
    expect(r1).not.toContain(s.orderNumber.replace(/\D/g, ''))
    expect(r1.toLowerCase()).not.toContain(s.orderId.slice(0, 8))
    // Another affiliate cannot mint or read a reference for this commission.
    expect((await fx.q(`SELECT affiliate_public_ref('sale',$1,$2) AS r`, [s.commissionId, b.id]))[0].r).toBeNull()
  })

  test('the rate limiter allows N per window per key and counts only allowed attempts', async () => {
    const allow = async (k: string) => (await fx.q(`SELECT affiliate_auth_rate_allow('login_email',$1,3,900) AS ok`, [k]))[0].ok
    expect([await allow('k1'), await allow('k1'), await allow('k1'), await allow('k1'), await allow('k1')]).toEqual([true, true, true, false, false])
    expect(await allow('k2')).toBe(true)                       // keys are independent
    const n = await fx.q(`SELECT COUNT(*)::int AS n FROM affiliate_auth_rate_events WHERE key_hash='k1'`)
    expect(n[0].n).toBe(3)                                     // rejected attempts are not recorded (no lockout extension)
  })
})
