// lib/__tests__/affiliate-portal-fixtures.ts — TEST-ONLY helpers for the affiliate-portal workstream.
//
//   * Creates the affcore CONTRACT tables (affiliate_profiles / affiliate_documents / affiliate_acceptances) and a
//     minimal order_fraud_reviews when the database does not already have them (i.e. migration 033 / the orders
//     migration are absent from this worktree), INSIDE the test — never in a migration. When the integrator runs
//     with the real 033 the CREATE ... IF NOT EXISTS calls are no-ops and the same tests run against the real tables.
//   * Re-applies migration 034 afterwards to prove it is idempotent and independent of table-creation order.
//   * Seeds affiliates, sales and commissions through the REAL SQL (create_affiliate, resolve_order_affiliate_attribution).
//
// SAFETY: fi-pg refuses a non-local TEST_DATABASE_URL and creates/drops a throwaway database.
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { createFiDb, HAVE_DB, ROOT, type FiDb } from './helpers/fi-pg'
import { createAffiliateAuthService } from '../affiliate-auth'

export { HAVE_DB }

/** Real-looking customer data that must NEVER appear in any affiliate-facing payload. */
export const PII = {
  email: 'buyer.pii.marker@example.org',
  name: 'Pat Quincy Buyer',
  phone: '+15555550123',
  street: '17 Secret Lane',
  city: 'Hidden Falls',
  stripePi: 'pi_PIIMARKER_9f8e7d',
  stripeSession: 'cs_PIIMARKER_1a2b3c',
}

export interface PortalFx extends FiDb {
  /** true when the contract tables were created by this fixture (no 033 in the tree) */
  createdContractTables: boolean
}

const CONTRACT_SQL = `
CREATE TABLE IF NOT EXISTS affiliate_profiles (
  affiliate_id     UUID        PRIMARY KEY REFERENCES affiliates(id) ON DELETE RESTRICT,
  email_normalized TEXT        NOT NULL,
  display_name     TEXT,
  application_id   UUID,
  program_status   TEXT        NOT NULL DEFAULT 'onboarding' CHECK (program_status IN ('onboarding','active','suspended','terminated')),
  kyc_status       TEXT        NOT NULL DEFAULT 'not_started' CHECK (kyc_status IN ('not_started','pending','verified','problem')),
  tax_status       TEXT        NOT NULL DEFAULT 'not_started' CHECK (tax_status IN ('not_started','pending','complete','problem')),
  payout_method_status TEXT    NOT NULL DEFAULT 'not_started' CHECK (payout_method_status IN ('not_started','pending','ready','failed')),
  payout_provider     TEXT,
  payout_provider_ref TEXT,
  portal_access    TEXT        NOT NULL DEFAULT 'enabled' CHECK (portal_access IN ('enabled','read_only','revoked')),
  paid_ads_policy  TEXT        NOT NULL DEFAULT 'not_permitted' CHECK (paid_ads_policy IN ('not_permitted','written_approval','approved')),
  payout_threshold_cents INTEGER CHECK (payout_threshold_cents IS NULL OR payout_threshold_cents >= 0),
  payout_schedule  TEXT,
  country          TEXT,
  state_region     TEXT,
  social_links     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  website          TEXT,
  accepted_program_terms_version TEXT,
  accepted_disclosure_version    TEXT,
  requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at     TIMESTAMPTZ,
  suspended_at     TIMESTAMPTZ,
  terminated_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_profiles_email_uq UNIQUE (email_normalized)
);
CREATE TABLE IF NOT EXISTS affiliate_documents (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type     TEXT        NOT NULL CHECK (doc_type IN ('program_terms','disclosure_policy','privacy_notice','brand_rules','ugc_license')),
  version      TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  effective_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by   TEXT        NOT NULL DEFAULT 'test',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_documents_type_version_uq UNIQUE (doc_type, version)
);
CREATE TABLE IF NOT EXISTS affiliate_acceptances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id    UUID        REFERENCES affiliates(id) ON DELETE RESTRICT,
  application_id  UUID,
  doc_type        TEXT        NOT NULL,
  version         TEXT        NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash         TEXT,
  user_agent_hash TEXT,
  method          TEXT        NOT NULL CHECK (method IN ('application','portal','admin_recorded')),
  CONSTRAINT aff_acc_subject_chk CHECK (affiliate_id IS NOT NULL OR application_id IS NOT NULL),
  CONSTRAINT aff_acc_document_fk FOREIGN KEY (doc_type, version) REFERENCES affiliate_documents(doc_type, version) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_acc_affiliate ON affiliate_acceptances(affiliate_id, doc_type, version) WHERE affiliate_id IS NOT NULL;
`

const FRAUD_REVIEW_SQL = `
CREATE TABLE IF NOT EXISTS order_fraud_reviews (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  hold_state TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export async function createPortalFx(prefix: string): Promise<PortalFx> {
  const fi = await createFiDb(prefix)
  const had = await fi.q(`SELECT to_regclass('public.affiliate_profiles') IS NOT NULL AS p`)
  const createdContractTables = had[0].p !== true
  if (createdContractTables) await fi.db.query(CONTRACT_SQL)
  const fr = await fi.q(`SELECT to_regclass('public.order_fraud_reviews') IS NOT NULL AS p`)
  if (fr[0].p !== true) await fi.db.query(FRAUD_REVIEW_SQL)
  // 034 must be idempotent and must work whether the contract tables existed when it first ran or not.
  await fi.db.query(fs.readFileSync(path.join(ROOT, 'db/migrations/034_affiliate_portal_compliance_payouts.sql'), 'utf8'))
  return Object.assign(fi, { createdContractTables })
}

// ── documents ────────────────────────────────────────────────────────────────
export async function seedDocs(q: FiDb['q'], version = 'v1') {
  for (const [t, title] of [['program_terms', 'Program Terms'], ['disclosure_policy', 'Disclosure Policy'], ['brand_rules', 'Brand Rules']] as const) {
    await q(`INSERT INTO affiliate_documents (doc_type, version, title, body, published_at, effective_at)
             VALUES ($1,$2,$3,$4, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day') ON CONFLICT DO NOTHING`,
      [t, version, title, `# ${title}\n\nPlaceholder text with **bold** and a [link](https://kvrn.shop/terms).\n\n- one\n- two`])
  }
}

export async function publishDocVersion(q: FiDb['q'], docType: string, version: string) {
  await q(`INSERT INTO affiliate_documents (doc_type, version, title, body, published_at, effective_at)
           VALUES ($1,$2,$3,'Updated body', NOW(), NOW())`, [docType, version, docType])
}

// ── affiliates ───────────────────────────────────────────────────────────────
let seq = 0
export const nextN = () => ++seq

export interface MkAffiliate {
  code?: string
  email?: string | null
  name?: string
  bps?: number
  holdDays?: number
  profile?: Partial<{
    program_status: string; kyc_status: string; tax_status: string; payout_method_status: string
    portal_access: string; paid_ads_policy: string; requires_reacceptance: boolean; payout_threshold_cents: number | null
    display_name: string | null; website: string | null; social_links: unknown[]
    accepted_program_terms_version: string | null; accepted_disclosure_version: string | null
  }> | null
}

export async function mkAffiliate(q: FiDb['q'], o: MkAffiliate = {}) {
  const n = nextN()
  const code = (o.code ?? `AFP${n}X`).toUpperCase()
  const email = o.email === undefined ? `aff${n}@portal.test` : o.email
  const r = await q(`SELECT create_affiliate($1,$2,$3,'percentage',$4,NULL,'proportional',30,$5,NULL,NULL,'test') AS r`,
    [code, o.name ?? `Affiliate ${n}`, email, o.bps ?? 1000, o.holdDays ?? 0])
  const id: string = r[0].r.affiliate_id
  // Backdate so attribution lookups have room.
  await q(`UPDATE affiliates SET created_at = NOW() - INTERVAL '300 days' WHERE id=$1`, [id])
  await q(`UPDATE affiliate_terms_events SET effective_at = NOW() - INTERVAL '300 days' WHERE affiliate_id=$1`, [id])
  await q(`UPDATE affiliate_status_events SET effective_at = NOW() - INTERVAL '300 days' WHERE affiliate_id=$1`, [id])
  if (o.profile === null) {
    // "no profile" = a legacy affiliate. With the real 033 a trigger creates the profile on insert, so remove it.
    if ((await q(`SELECT to_regclass('public.affiliate_profiles') IS NOT NULL AS p`))[0].p === true) {
      await q(`DELETE FROM affiliate_profiles WHERE affiliate_id=$1`, [id])
    }
  }
  if (o.profile !== null) {
    const p = o.profile ?? {}
    await q(`INSERT INTO affiliate_profiles (affiliate_id, email_normalized, display_name, program_status)
             VALUES ($1,$2,$3,'active')
             ON CONFLICT (affiliate_id) DO UPDATE SET program_status='active'`,
      [id, (email ?? `placeholder-${id}@invalid.invalid`).toLowerCase(), p.display_name ?? null])
    const sets: string[] = []; const vals: unknown[] = [id]
    for (const [k, v] of Object.entries(p)) { vals.push(k === 'social_links' ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}${k === 'social_links' ? '::jsonb' : ''}`) }
    if (sets.length) await q(`UPDATE affiliate_profiles SET ${sets.join(', ')} WHERE affiliate_id=$1`, vals)
  }
  return { id, code, email: email ? email.toLowerCase() : null }
}

/** Everything the payout gate needs to say yes (docs must be seeded first). */
export async function makeReady(q: FiDb['q'], affiliateId: string) {
  await q(`UPDATE affiliate_profiles SET kyc_status='verified', tax_status='complete', payout_method_status='ready',
             accepted_program_terms_version='v1', accepted_disclosure_version='v1', requires_reacceptance=FALSE
           WHERE affiliate_id=$1`, [affiliateId])
}

export async function acceptAll(q: FiDb['q'], affiliateId: string, version = 'v1') {
  for (const t of ['program_terms', 'disclosure_policy', 'brand_rules']) {
    await q(`INSERT INTO affiliate_acceptances (affiliate_id, doc_type, version, method)
             VALUES ($1,$2,$3,'admin_recorded') ON CONFLICT DO NOTHING`, [affiliateId, t, version])
  }
}

// ── sales ────────────────────────────────────────────────────────────────────
export interface MkSale { code: string; subtotalCents?: number; daysAgo?: number; pii?: boolean; customerEmail?: string }

/** A paid order that uses the affiliate's code, attributed through the REAL attribution SQL. */
export async function mkSale(q: FiDb['q'], o: MkSale) {
  const n = nextN()
  const orderId = `f4000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const num = `AP-${String(n).padStart(5, '0')}`
  const subtotal = o.subtotalCents ?? 10000
  const days = o.daysAgo ?? 0
  await q(`INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,currency,
             subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code,
             customer_email,customer_name,customer_phone,shipping_address)
           VALUES ($1,$2,$3,$4,'paid','usd',$5,0,0,0,$5, NOW() - ($6 || ' days')::interval, $7, $8,$9,$10,$11)`,
    [orderId, num, o.pii === false ? `cs_${num}` : `${PII.stripeSession}_${n}`, o.pii === false ? `pi_${num}` : `${PII.stripePi}_${n}`,
     subtotal, String(days), o.code, o.customerEmail ?? PII.email, PII.name, PII.phone,
     JSON.stringify({ line1: PII.street, city: PII.city, postal_code: '99999' })])
  await q(`INSERT INTO order_items (order_id,sku,product_name,size,color,quantity,unit_price_cents,line_total_cents)
           VALUES ($1,$2,'Heavyweight Hoodie','M','Black',1,$3,$3)`, [orderId, `SKU-${n}`, subtotal])
  const res = await q(`SELECT resolve_order_affiliate_attribution($1,NULL,'test') AS r`, [orderId])
  if (res[0].r.outcome !== 'attributed') throw new Error(`fixture sale was not attributed: ${JSON.stringify(res[0].r)}`)
  const c = await q(`SELECT id FROM affiliate_commissions WHERE order_id=$1`, [orderId])
  return { orderId, orderNumber: num, commissionId: c[0]?.id as string, attributionId: res[0].r.attribution_id as string }
}

/** Promote anything past its hold window (the same existing function the lazy read path uses). */
export const promote = (q: FiDb['q'], affiliateId: string) =>
  q(`SELECT promote_eligible_commissions_for_affiliate($1) AS n`, [affiliateId])

/** Draft payout through the unchanged SQL (bypasses the Admin-route gate on purpose; tests the gate separately). */
export async function mkDraftPayout(q: FiDb['q'], affiliateId: string, commissionIds: string[], actor = 'seed') {
  await promote(q, affiliateId)
  const r = await q(`SELECT create_affiliate_payout($1,$2::uuid[],$3) AS r`, [affiliateId, commissionIds, actor])
  if (r[0].r.outcome !== 'created') throw new Error(`fixture payout: ${JSON.stringify(r[0].r)}`)
  return r[0].r as { payout_id: string; payout_number: string; amount_cents: number; line_count: number }
}

/** A signed ledger entry through the append-only ledger table (what a correction looks like to the portal). */
export async function addLedger(q: FiDb['q'], commissionId: string, cents: number, reason = 'manual_correction') {
  await q(`INSERT INTO affiliate_commission_adjustments (commission_id, order_id, affiliate_id, adjustment_cents, effective_at, reason)
           SELECT id, order_id, affiliate_id, $2, NOW(), $3 FROM affiliate_commissions WHERE id=$1`, [commissionId, cents, reason])
}
/** An unresolved refund / dispute: value not certain. */
export const markIncomplete = (q: FiDb['q'], commissionId: string) =>
  q(`UPDATE affiliate_commissions SET incomplete=TRUE, incomplete_reason='dispute open' WHERE id=$1`, [commissionId])

export async function payPayout(q: FiDb['q'], payoutId: string, method = 'bank_transfer', reference = 'REF-1') {
  await q(`SELECT mark_affiliate_payout_paid($1, CURRENT_DATE, $2, $3, 'admin@kvrn.test')`, [payoutId, method, reference])
}

// ── auth / HTTP helpers ──────────────────────────────────────────────────────
export const ORIGIN = 'https://kvrn.shop'

/** Real request → token → session through the production auth service. Returns the raw session + CSRF tokens. */
export async function loginAs(sql: any, email: string, ip = '203.0.113.9') {
  let link = ''
  // Fixture convenience: tests that log in repeatedly must not trip the login rate limit (it is tested on its own).
  await sql`DELETE FROM affiliate_auth_rate_events`
  const svc = createAffiliateAuthService(sql, {
    siteOrigin: () => ORIGIN,
    sendLoginEmail: async m => { link = m.link; return true },
  })
  const r = await svc.requestLogin({ email, ip, userAgent: 'jest' })
  if (r.status !== 'sent') throw new Error(`login request: ${r.status}`)
  const token = new URL(link).hash.replace(/^#t=/, '')
  const s = await svc.redeemLoginToken({ token, ip, userAgent: 'jest' })
  if (!s.ok) throw new Error('redeem failed')
  return { affiliateId: s.affiliateId, sessionToken: s.sessionToken, csrfToken: s.csrfToken, token }
}

export interface ReqOpts {
  method?: string
  session?: string | null
  csrf?: string | null
  csrfCookie?: string | null
  origin?: string | null
  secFetchSite?: string | null
  body?: unknown
  headers?: Record<string, string>
}
export function mkReq(pathAndQuery: string, o: ReqOpts = {}): NextRequest {
  const headers = new Headers(o.headers ?? {})
  const cookies: string[] = []
  if (o.session) cookies.push(`kvrn_aff=${o.session}`)
  if (o.csrfCookie ?? o.csrf) cookies.push(`kvrn_aff_csrf=${o.csrfCookie ?? o.csrf}`)
  if (cookies.length) headers.set('cookie', cookies.join('; '))
  if (o.csrf) headers.set('x-kvrn-csrf', o.csrf)
  const method = o.method ?? 'GET'
  if (method !== 'GET') {
    if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN)
    if (o.secFetchSite) headers.set('sec-fetch-site', o.secFetchSite)
    headers.set('content-type', 'application/json')
  }
  return new NextRequest(`${ORIGIN}${pathAndQuery}`, {
    method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
  })
}

export const sessionReq = (p: string, s: { sessionToken: string; csrfToken: string }, o: ReqOpts = {}) =>
  mkReq(p, { session: s.sessionToken, csrf: (o.method ?? 'GET') === 'GET' ? null : s.csrfToken, ...o })

export function setFlags(flags: { portal?: boolean; autoPayouts?: boolean; applications?: boolean }) {
  const set = (k: string, v: boolean | undefined) => { if (v === undefined) return; if (v) process.env[k] = 'on'; else delete process.env[k] }
  set('KVRN_FLAG_AFFILIATE_PORTAL', flags.portal)
  set('KVRN_FLAG_AFFILIATE_AUTO_PAYOUTS', flags.autoPayouts)
  set('KVRN_FLAG_AFFILIATE_APPLICATIONS', flags.applications)
}

/** jest.mock('../db') factory target: routes import @/lib/db, tests point it at the throwaway database. */
export function installDb(sql: any) { (globalThis as any).__affPortalTestSql = sql }
export const dbProxy = (...a: any[]) => (globalThis as any).__affPortalTestSql(...a)
