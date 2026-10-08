// lib/affiliate-program-admin.ts — Admin service for the affiliate program (injectable `sql`).
// Every mutation is one atomic, audited SQL function. Reads return plain DTOs; internal notes are
// returned to Admin only and are never put in any email payload (the SQL builds payloads itself).

import { toProgramError, ProgramError, isUuid, type ProgramStatus } from './affiliate-program'
import { sha256Hex } from './affiliate-application'

type Sql = any
const iso = (v: any) => (v ? new Date(v).toISOString() : null)
const num = (v: any) => (v === null || v === undefined ? null : Number(v))

async function call<T = any>(p: Promise<any[]>): Promise<T> {
  try { return ((await p)[0] as any).r as T } catch (err) { throw toProgramError(err) ?? err }
}

function randomToken(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

export function createAffiliateProgramAdmin(sql: Sql) {
  return {
    // ── Applications ─────────────────────────────────────────────────────────
    async listApplications(opts: { status?: string | null; limit?: number } = {}) {
      const rows = await sql`
        SELECT a.id, a.status, a.source, a.applicant_name, a.display_name, a.email, a.country, a.social_links,
               a.audience_size, a.content_category, a.duplicate_flags, a.created_at, a.reviewed_at, a.anonymized_at,
               a.affiliate_id, a.terms_version, a.invite_id
          FROM affiliate_applications a
         WHERE (${opts.status ?? null}::text IS NULL OR a.status = ${opts.status ?? null}::text)
         ORDER BY CASE WHEN a.status IN ('pending','under_review','needs_info') THEN 0 ELSE 1 END, a.created_at DESC
         LIMIT ${Math.min(Math.max(opts.limit ?? 100, 1), 300)}` as any[]
      return rows.map(r => ({
        id: r.id, status: r.status, source: r.source, applicantName: r.applicant_name, displayName: r.display_name,
        email: r.email, country: r.country, socialLinks: r.social_links ?? [], audienceSize: num(r.audience_size),
        contentCategory: r.content_category, flagCount: Array.isArray(r.duplicate_flags) ? r.duplicate_flags.length : 0,
        highFlags: Array.isArray(r.duplicate_flags) ? r.duplicate_flags.filter((f: any) => f.severity === 'high').length : 0,
        createdAt: iso(r.created_at), reviewedAt: iso(r.reviewed_at), anonymized: !!r.anonymized_at,
        affiliateId: r.affiliate_id, termsVersion: r.terms_version, invited: r.source === 'invite',
      }))
    },

    async getApplication(id: string) {
      if (!isUuid(id)) return null
      const [a] = await sql`SELECT * FROM affiliate_applications WHERE id = ${id}::uuid` as any[]
      if (!a) return null
      const [acceptances, notes, history, invite, settingsRow] = await Promise.all([
        sql`SELECT doc_type, version, accepted_at, method FROM affiliate_acceptances WHERE application_id = ${id}::uuid ORDER BY doc_type` as Promise<any[]>,
        sql`SELECT id, author, body, created_at FROM affiliate_notes WHERE application_id = ${id}::uuid ORDER BY created_at DESC` as Promise<any[]>,
        sql`SELECT actor_email, action, payload, created_at FROM admin_audit_logs
             WHERE resource = 'affiliate_applications' AND resource_id = ${id} ORDER BY created_at DESC LIMIT 50` as Promise<any[]>,
        a.invite_id ? sql`SELECT proposed_code, proposed_commission_type, proposed_commission_rate_bps, proposed_commission_fixed_cents,
                                 proposed_discount_type, proposed_discount_bps, proposed_discount_cents, proposed_start_at, proposed_end_at
                            FROM affiliate_invites WHERE id = ${a.invite_id}::uuid` as Promise<any[]> : Promise.resolve([]),
        sql`SELECT 1` as Promise<any[]>,
      ])
      void settingsRow
      const inv = invite[0]
      return {
        id: a.id, status: a.status, source: a.source, applicantName: a.applicant_name, displayName: a.display_name,
        email: a.email, country: a.country, stateRegion: a.state_region, socialLinks: a.social_links ?? [], website: a.website,
        audienceSize: num(a.audience_size), contentCategory: a.content_category, motivation: a.motivation,
        promotionPlan: a.promotion_plan, preferredCode: a.preferred_code, heardAbout: a.heard_about, applicantNotes: a.applicant_notes,
        ageAttested: !!a.age_attested, ageAttestedAt: iso(a.age_attested_at), accuracyConfirmedAt: iso(a.accuracy_confirmed_at),
        esignConsentedAt: iso(a.esign_consented_at), termsVersion: a.terms_version, disclosureVersion: a.disclosure_version,
        privacyVersion: a.privacy_version, duplicateFlags: a.duplicate_flags ?? [], affiliateId: a.affiliate_id,
        reviewedBy: a.reviewed_by, reviewedAt: iso(a.reviewed_at), decisionMessage: a.decision_message,
        anonymizedAt: iso(a.anonymized_at), createdAt: iso(a.created_at),
        acceptances: acceptances.map(x => ({ docType: x.doc_type, version: x.version, acceptedAt: iso(x.accepted_at), method: x.method })),
        notes: notes.map(n => ({ id: n.id, author: n.author, body: n.body, createdAt: iso(n.created_at) })),
        history: history.map(h => ({ actor: h.actor_email, action: h.action, payload: h.payload, at: iso(h.created_at) })),
        invite: inv ? {
          proposedCode: inv.proposed_code, commissionType: inv.proposed_commission_type, commissionRateBps: num(inv.proposed_commission_rate_bps),
          commissionFixedCents: num(inv.proposed_commission_fixed_cents), discountType: inv.proposed_discount_type,
          discountBps: num(inv.proposed_discount_bps), discountCents: num(inv.proposed_discount_cents),
          startAt: iso(inv.proposed_start_at), endAt: iso(inv.proposed_end_at),
        } : null,
      }
    },

    addNote: (applicationId: string | null, affiliateId: string | null, body: string, actor: string) =>
      call(sql`SELECT add_affiliate_note(${applicationId}::uuid, ${affiliateId}::uuid, ${body}, ${actor}) AS r`),

    setApplicationStatus: (id: string, to: 'under_review' | 'needs_info' | 'withdrawn', message: string | null, actor: string) =>
      call(sql`SELECT set_affiliate_application_status(${id}::uuid, ${to}, ${message}, ${actor}) AS r`),

    approve: (id: string, config: Record<string, unknown>, actor: string) =>
      call(sql`SELECT approve_affiliate_application(${id}::uuid, ${JSON.stringify(config)}::jsonb, ${actor}) AS r`),

    reject: (id: string, message: string | null, actor: string) =>
      call(sql`SELECT reject_affiliate_application(${id}::uuid, ${message}, ${actor}) AS r`),

    anonymize: (id: string, actor: string) =>
      call(sql`SELECT anonymize_affiliate_application(${id}::uuid, ${actor}) AS r`),

    // ── Invites ──────────────────────────────────────────────────────────────
    async listInvites() {
      const rows = await sql`
        SELECT id, email, display_name, proposed_code, status, expires_at, email_status, email_sent_at, send_count,
               application_id, created_by, created_at, used_at
          FROM affiliate_invites ORDER BY created_at DESC LIMIT 100` as any[]
      return rows.map(r => ({
        id: r.id, email: r.email, displayName: r.display_name, proposedCode: r.proposed_code,
        status: r.status === 'open' && new Date(r.expires_at) <= new Date() ? 'expired' : r.status,
        expiresAt: iso(r.expires_at), emailStatus: r.email_status, emailSentAt: iso(r.email_sent_at), sendCount: Number(r.send_count),
        applicationId: r.application_id, createdBy: r.created_by, createdAt: iso(r.created_at), usedAt: iso(r.used_at),
      }))
    },

    /** Create an invite. Returns the raw token ONCE (for the email); only its hash is stored. */
    async createInvite(config: Record<string, unknown>, expiryDays: number, actor: string) {
      const token = randomToken()
      const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString()
      const r = await call<{ invite_id: string }>(
        sql`SELECT create_affiliate_invite(${JSON.stringify(config)}::jsonb, ${await sha256Hex(token)}, ${expiresAt}::timestamptz, ${actor}) AS r`)
      return { inviteId: r.invite_id, token, sendCount: 0 }
    },

    async rotateInvite(inviteId: string, expiryDays: number, actor: string) {
      const token = randomToken()
      const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString()
      const r = await call<{ send_count: number }>(
        sql`SELECT rotate_affiliate_invite_token(${inviteId}::uuid, ${await sha256Hex(token)}, ${expiresAt}::timestamptz, ${actor}) AS r`)
      const [inv] = await sql`SELECT email, display_name FROM affiliate_invites WHERE id = ${inviteId}::uuid` as any[]
      return { inviteId, token, sendCount: Number(r.send_count), email: inv.email as string, displayName: inv.display_name as string }
    },

    revokeInvite: (inviteId: string, actor: string) =>
      call(sql`SELECT revoke_affiliate_invite(${inviteId}::uuid, ${actor}) AS r`),

    /** Public prefill lookup by raw token. Reveals only what the token holder already knows. */
    async lookupInvite(token: string) {
      if (!/^[0-9a-f]{64}$/.test(token)) return null
      const [r] = await sql`SELECT email, display_name, status, expires_at FROM affiliate_invites WHERE token_hash = ${await sha256Hex(token)}` as any[]
      if (!r || r.status !== 'open' || new Date(r.expires_at) <= new Date()) return null
      return { email: r.email as string, displayName: r.display_name as string }
    },

    // ── Affiliates (program identity) ────────────────────────────────────────
    async listProfiles() {
      const rows = await sql`
        SELECT a.id, a.code, a.name, a.email, a.status AS financial_status, a.default_commission_type, a.default_commission_rate_bps,
               a.default_commission_fixed_cents, a.default_fixed_reversal_policy, a.attribution_window_days, a.commission_hold_days, d.code AS discount_code, d.active AS discount_active,
               p.program_status, p.kyc_status, p.tax_status, p.payout_method_status, p.portal_access, p.paid_ads_policy,
               p.payout_threshold_cents, p.payout_schedule, p.accepted_program_terms_version, p.accepted_disclosure_version,
               p.requires_reacceptance, p.country, p.display_name, p.activated_at, p.suspended_at, p.terminated_at,
               p.program_start_at, p.program_end_at, p.application_id, p.email_normalized,
               (SELECT count(*) FROM affiliate_commissions c WHERE c.affiliate_id = a.id)::int AS order_count,
               (SELECT bool_or(l.active) FROM affiliate_links l WHERE l.affiliate_id = a.id) AS link_active,
               (SELECT string_agg(l.slug, ',') FROM affiliate_links l WHERE l.affiliate_id = a.id) AS link_slugs
          FROM affiliates a JOIN affiliate_profiles p ON p.affiliate_id = a.id
          LEFT JOIN discounts d ON d.id = a.discount_id
         ORDER BY a.created_at DESC` as any[]
      return rows.map(r => ({
        id: r.id, code: r.code, name: r.name, displayName: r.display_name, email: r.email,
        hasSignInEmail: !String(r.email_normalized).endsWith('@affiliate.invalid'),
        financialStatus: r.financial_status, programStatus: r.program_status as ProgramStatus,
        commissionType: r.default_commission_type, commissionRateBps: num(r.default_commission_rate_bps),
        commissionFixedCents: num(r.default_commission_fixed_cents), fixedReversalPolicy: r.default_fixed_reversal_policy as string, attributionWindowDays: Number(r.attribution_window_days),
        commissionHoldDays: Number(r.commission_hold_days), discountCode: r.discount_code, discountActive: r.discount_active,
        kycStatus: r.kyc_status, taxStatus: r.tax_status, payoutMethodStatus: r.payout_method_status,
        portalAccess: r.portal_access, paidAdsPolicy: r.paid_ads_policy, payoutThresholdCents: num(r.payout_threshold_cents),
        payoutSchedule: r.payout_schedule, acceptedProgramTermsVersion: r.accepted_program_terms_version,
        acceptedDisclosureVersion: r.accepted_disclosure_version, requiresReacceptance: !!r.requires_reacceptance,
        country: r.country, activatedAt: iso(r.activated_at), suspendedAt: iso(r.suspended_at), terminatedAt: iso(r.terminated_at),
        programStartAt: iso(r.program_start_at), programEndAt: iso(r.program_end_at), applicationId: r.application_id,
        orderCount: Number(r.order_count), linkActive: !!r.link_active, linkSlugs: r.link_slugs ? String(r.link_slugs).split(',') : [],
      }))
    },

    setProgramStatus: (affiliateId: string, target: 'active' | 'suspended' | 'terminated', o: {
      actor: string; reason?: string | null; message?: string | null; notify?: boolean; revokePortal?: boolean; effectiveAt?: string | null }) =>
      call(sql`SELECT set_affiliate_program_status(${affiliateId}::uuid, ${target}, ${o.actor}, ${o.reason ?? null}, ${o.message ?? null},
                 ${o.notify !== false}, ${o.revokePortal === true}, ${o.effectiveAt ?? null}::timestamptz) AS r`),

    updateProfileSettings: (affiliateId: string, settings: Record<string, unknown>, actor: string) =>
      call(sql`SELECT update_affiliate_profile_settings(${affiliateId}::uuid, ${JSON.stringify(settings)}::jsonb, ${actor}) AS r`),

    changeCode: (affiliateId: string, newCode: string, actor: string) =>
      call(sql`SELECT change_affiliate_code(${affiliateId}::uuid, ${newCode}, ${actor}) AS r`),

    setEmail: (affiliateId: string, email: string, actor: string) =>
      call(sql`SELECT set_affiliate_email(${affiliateId}::uuid, ${email}, ${actor}) AS r`),

    // ── Documents ────────────────────────────────────────────────────────────
    async listDocuments() {
      const rows = await sql`
        SELECT id, doc_type, version, version_no, title, body, effective_at, published_at, is_placeholder, material_change, change_summary, created_by, created_at
          FROM affiliate_documents ORDER BY doc_type, version_no DESC` as any[]
      const current = new Map<string, string>()
      for (const r of rows) if (r.published_at && new Date(r.effective_at) <= new Date() && !current.has(r.doc_type)) current.set(r.doc_type, r.id)
      return rows.map(r => ({
        id: r.id, docType: r.doc_type, version: r.version, versionNo: Number(r.version_no), title: r.title, body: r.body,
        effectiveAt: iso(r.effective_at), publishedAt: iso(r.published_at), isPlaceholder: !!r.is_placeholder,
        materialChange: !!r.material_change, changeSummary: r.change_summary, createdBy: r.created_by,
        isCurrent: current.get(r.doc_type) === r.id, isDraft: !r.published_at,
      }))
    },
    saveDocumentDraft: (d: { docType: string; title: string; body: string; changeSummary: string | null }, actor: string) =>
      call(sql`SELECT save_affiliate_document_draft(${d.docType}, ${d.title}, ${d.body}, ${d.changeSummary}, ${actor}) AS r`),
    discardDocumentDraft: (id: string, actor: string) => call(sql`SELECT discard_affiliate_document_draft(${id}::uuid, ${actor}) AS r`),
    publishDocument: (id: string, material: boolean, actor: string) =>
      call(sql`SELECT publish_affiliate_document(${id}::uuid, ${material}, ${actor}) AS r`),

    async reacceptanceList() {
      const rows = await sql`SELECT * FROM affiliate_reacceptance_list()` as any[]
      return rows.map(r => ({
        affiliateId: r.affiliate_id, code: r.code, displayName: r.display_name, email: r.email, programStatus: r.program_status,
        acceptedProgramTermsVersion: r.accepted_program_terms_version, acceptedDisclosureVersion: r.accepted_disclosure_version,
        currentProgramTermsVersion: r.current_program_terms_version, currentDisclosureVersion: r.current_disclosure_version,
        requiresReacceptance: !!r.requires_reacceptance, reason: r.reason as 'not_accepted' | 'outdated',
      }))
    },
    requestReacceptance: (ids: string[], actor: string) =>
      call(sql`SELECT request_affiliate_reacceptance(${ids}::uuid[], ${actor}) AS r`),

    // ── Audit + email ────────────────────────────────────────────────────────
    async listAudit(limit = 100) {
      const rows = await sql`
        SELECT actor_email, action, resource, resource_id, payload, created_at FROM admin_audit_logs
         WHERE action LIKE 'affiliate.%' OR resource IN ('affiliates','affiliate_applications','affiliate_documents','affiliate_invites','affiliate_links')
         ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 300)}` as any[]
      return rows.map(r => ({ actor: r.actor_email, action: r.action, resource: r.resource, resourceId: r.resource_id, payload: r.payload, at: iso(r.created_at) }))
    },

    async listEmailOutbox(limit = 50) {
      const rows = await sql`
        SELECT id, kind, status, attempt_count, last_error, created_at, sent_at FROM affiliate_email_outbox
         ORDER BY created_at DESC LIMIT ${limit}` as any[]
      return rows.map(r => ({ id: r.id, kind: r.kind, status: r.status, attempts: Number(r.attempt_count), lastError: r.last_error, createdAt: iso(r.created_at), sentAt: iso(r.sent_at) }))
    },

    async counts() {
      const [r] = await sql`
        SELECT (SELECT count(*) FROM affiliate_applications WHERE status IN ('pending','under_review','needs_info'))::int AS open_apps,
               (SELECT count(*) FROM affiliate_reacceptance_list())::int AS reaccept` as any[]
      return { openApplications: Number(r.open_apps), reacceptance: Number(r.reaccept) }
    },
  }
}

export type AffiliateProgramAdmin = ReturnType<typeof createAffiliateProgramAdmin>
export { ProgramError }
