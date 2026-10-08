// lib/affiliate-compliance.ts — Compliance center: saved promotional posts, warning history, review log,
// fraud / abuse flags (self-referral heuristics), paid-ad permission, compliance suspension.
// Server-only. Every mutation is ONE statement (or one SQL function) that writes the change, its history row and
// its admin_audit_logs row atomically. Nothing is ever deleted; history is append-only (database triggers).
//
// FRAUD RESPONSE PRINCIPLES
//   * A heuristic can only RAISE A QUESTION (`review`/`info` flag, freeze_commissions=false). Matching emails
//     does not prove fraud — the Admin decides.
//   * "Freeze" is an explicit Admin decision recorded on the flag. It blocks PAYOUT through the payout gate;
//     it never edits, deletes or rewrites a commission or ledger row.
//   * Resolving / dismissing a flag requires a written note and keeps the whole history.
import { normalizeHttpsUrl } from '@/lib/affiliate-portal-validation'
import { getCurrentDocuments } from '@/lib/affiliate-portal-bridge'

type Sql = any

export const ITEM_STATUSES = ['compliant', 'needs_review', 'violation', 'resolved'] as const
export const WARNING_SEVERITIES = ['notice', 'warning', 'final'] as const
export const WARNING_CATEGORIES = ['disclosure', 'brand', 'paid_ads', 'email_sms', 'claims', 'self_referral', 'other'] as const
export const REVIEW_OUTCOMES = ['no_issues', 'issues_found', 'follow_up'] as const
export const PAID_ADS_POLICIES = ['not_permitted', 'written_approval', 'approved'] as const
export const FLAG_SIGNALS = [
  'customer_email_matches_affiliate', 'customer_email_similar_to_affiliate', 'suspected_coupon_leakage',
  'suspected_cookie_stuffing', 'suspected_duplicate_account', 'suspected_manipulated_attribution', 'other',
] as const
export const FLAG_STATUSES = ['open', 'investigating', 'resolved', 'dismissed'] as const

type Result<T> = { ok: true; value: T } | { ok: false; error: string }
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const text = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  return s === '' ? null : s.slice(0, max)
}

// ── validation (pure) ────────────────────────────────────────────────────────
export function validateItemInput(b: any): Result<{ url: string; platform: string | null; title: string | null; note: string | null }> {
  const u = normalizeHttpsUrl(b?.url, 500)
  if (!u.ok) return { ok: false, error: 'Enter the post link (https only).' }
  return { ok: true, value: { url: u.value, platform: text(b?.platform, 40), title: text(b?.title, 160), note: text(b?.note, 1000) } }
}

export function validateWarningInput(b: any): Result<{
  severity: typeof WARNING_SEVERITIES[number]; category: typeof WARNING_CATEGORIES[number]; summary: string
  internalNote: string | null; notifyAffiliate: boolean; itemId: string | null }> {
  if (!inList(WARNING_SEVERITIES, b?.severity)) return { ok: false, error: 'Choose a severity.' }
  if (!inList(WARNING_CATEGORIES, b?.category)) return { ok: false, error: 'Choose a category.' }
  const summary = text(b?.summary, 500)
  if (!summary || summary.length < 3) return { ok: false, error: 'Write the message the affiliate will see.' }
  const itemId = b?.itemId ? String(b.itemId) : null
  if (itemId && !/^[0-9a-f-]{36}$/i.test(itemId)) return { ok: false, error: 'Post not found.' }
  return { ok: true, value: {
    severity: b.severity, category: b.category, summary, internalNote: text(b?.internalNote, 1000),
    notifyAffiliate: b?.notifyAffiliate !== false, itemId,
  } }
}

// ── service ──────────────────────────────────────────────────────────────────
export function createAffiliateComplianceService(sql: Sql) {
  return {
    /** Current Disclosure Guide / Brand Rules / Program Terms versions (read from affiliate_documents). */
    async currentDocuments() {
      const docs = await getCurrentDocuments(sql)
      return docs.filter(d => ['program_terms', 'disclosure_policy', 'brand_rules', 'privacy_notice', 'ugc_license'].includes(d.docType))
    },

    /** One row per affiliate that needs attention, plus the headline numbers. */
    async attention(limit = 200) {
      const rows = await sql`
        SELECT a.id, a.code, a.name, a.status,
               (SELECT MAX(reviewed_at) FROM affiliate_compliance_reviews r WHERE r.affiliate_id = a.id) AS last_review,
               (SELECT COUNT(*) FROM affiliate_compliance_items i WHERE i.affiliate_id = a.id AND i.status IN ('needs_review','violation'))::int AS items_open,
               (SELECT COUNT(*) FROM affiliate_compliance_warnings w WHERE w.affiliate_id = a.id AND w.status = 'open')::int AS warnings_open,
               (SELECT COUNT(*) FROM affiliate_fraud_flags f WHERE f.affiliate_id = a.id AND f.status IN ('open','investigating'))::int AS flags_open
          FROM affiliates a ORDER BY a.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}` as any[]
      return rows.map(r => ({
        affiliateId: r.id as string, code: r.code as string, name: r.name as string, status: r.status as string,
        lastReviewAt: r.last_review ? new Date(r.last_review).toISOString() : null,
        itemsOpen: Number(r.items_open), warningsOpen: Number(r.warnings_open), flagsOpen: Number(r.flags_open),
      }))
    },

    async detail(affiliateId: string) {
      const [items, warnings, reviews, flags, policy, ugc] = await Promise.all([
        sql`SELECT id, url, platform, title, status, internal_note, reviewed_at, reviewed_by, created_at
              FROM affiliate_compliance_items WHERE affiliate_id = ${affiliateId}::uuid ORDER BY created_at DESC LIMIT 100` as Promise<any[]>,
        sql`SELECT id, item_id, severity, category, summary, internal_note, notify_affiliate, status, issued_by, issued_at,
                   resolved_at, resolved_by, resolution_note
              FROM affiliate_compliance_warnings WHERE affiliate_id = ${affiliateId}::uuid ORDER BY issued_at DESC LIMIT 100` as Promise<any[]>,
        sql`SELECT outcome, note, reviewed_by, reviewed_at FROM affiliate_compliance_reviews
             WHERE affiliate_id = ${affiliateId}::uuid ORDER BY reviewed_at DESC LIMIT 20` as Promise<any[]>,
        sql`SELECT f.id, f.order_id, f.signal, f.source, f.severity, f.status, f.freeze_commissions, f.detail,
                   f.investigation_note, f.created_at, f.resolved_at, f.resolution_note, o.order_number
              FROM affiliate_fraud_flags f LEFT JOIN orders o ON o.id = f.order_id
             WHERE f.affiliate_id = ${affiliateId}::uuid ORDER BY f.created_at DESC LIMIT 100` as Promise<any[]>,
        sql`SELECT p.program_status, p.paid_ads_policy, p.portal_access FROM affiliate_profiles p WHERE p.affiliate_id = ${affiliateId}::uuid` as Promise<any[]>,
        sql`SELECT COUNT(*)::int AS n FROM affiliate_ugc_licenses WHERE affiliate_id = ${affiliateId}::uuid AND revoked_at IS NULL` as Promise<any[]>,
      ])
      const iso = (v: any) => (v ? new Date(v).toISOString() : null)
      return {
        profile: policy[0] ? { programStatus: policy[0].program_status, paidAdsPolicy: policy[0].paid_ads_policy, portalAccess: policy[0].portal_access } : null,
        lastReviewAt: iso(reviews[0]?.reviewed_at),
        reviews: reviews.map(r => ({ outcome: r.outcome, note: r.note, by: r.reviewed_by, at: iso(r.reviewed_at) })),
        items: items.map(i => ({ id: i.id, url: i.url, platform: i.platform, title: i.title, status: i.status, note: i.internal_note,
          reviewedAt: iso(i.reviewed_at), reviewedBy: i.reviewed_by, createdAt: iso(i.created_at) })),
        warnings: warnings.map(w => ({ id: w.id, itemId: w.item_id, severity: w.severity, category: w.category, summary: w.summary,
          internalNote: w.internal_note, notifyAffiliate: w.notify_affiliate, status: w.status, issuedBy: w.issued_by,
          issuedAt: iso(w.issued_at), resolvedAt: iso(w.resolved_at), resolvedBy: w.resolved_by, resolutionNote: w.resolution_note })),
        flags: flags.map(f => ({ id: f.id, orderNumber: f.order_number ?? null, signal: f.signal, source: f.source, severity: f.severity,
          status: f.status, freezeCommissions: f.freeze_commissions, detail: f.detail, note: f.investigation_note,
          createdAt: iso(f.created_at), resolvedAt: iso(f.resolved_at), resolutionNote: f.resolution_note })),
        activeUgcLicenses: Number(ugc[0]?.n ?? 0),
      }
    },

    async recordReview(affiliateId: string, outcome: string, note: string | null, actor: string) {
      if (!inList(REVIEW_OUTCOMES, outcome)) throw new Error('BAD_OUTCOME')
      await sql`
        WITH ins AS (INSERT INTO affiliate_compliance_reviews (affiliate_id, outcome, note, reviewed_by)
                     VALUES (${affiliateId}::uuid, ${outcome}, ${text(note, 1000)}, ${actor}) RETURNING id)
        INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
        SELECT ${actor}, 'affiliate.compliance_review', 'affiliates', ${affiliateId}, jsonb_build_object('outcome', ${outcome}::text) FROM ins`
    },

    async addItem(affiliateId: string, v: { url: string; platform: string | null; title: string | null; note: string | null }, actor: string) {
      const rows = await sql`
        WITH ins AS (
          INSERT INTO affiliate_compliance_items (affiliate_id, url, platform, title, internal_note, created_by)
          VALUES (${affiliateId}::uuid, ${v.url}, ${v.platform}, ${v.title}, ${v.note}, ${actor}) RETURNING id
        ), ev AS (
          INSERT INTO affiliate_compliance_item_events (item_id, affiliate_id, from_status, to_status, note, actor_email)
          SELECT id, ${affiliateId}::uuid, NULL, 'needs_review', 'Added', ${actor} FROM ins
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.compliance_item_add', 'affiliates', ${affiliateId}, jsonb_build_object('item_id', id) FROM ins
        ) SELECT id FROM ins` as any[]
      return rows[0]?.id as string
    },

    async setItemStatus(affiliateId: string, itemId: string, status: string, note: string | null, actor: string): Promise<boolean> {
      if (!inList(ITEM_STATUSES, status)) throw new Error('BAD_STATUS')
      const rows = await sql`
        WITH cur AS (SELECT id, status FROM affiliate_compliance_items WHERE id = ${itemId}::uuid AND affiliate_id = ${affiliateId}::uuid FOR UPDATE),
        upd AS (
          UPDATE affiliate_compliance_items i
             SET status = ${status}, internal_note = COALESCE(${text(note, 1000)}, i.internal_note),
                 reviewed_at = NOW(), reviewed_by = ${actor}
            FROM cur WHERE i.id = cur.id RETURNING i.id
        ), ev AS (
          INSERT INTO affiliate_compliance_item_events (item_id, affiliate_id, from_status, to_status, note, actor_email)
          SELECT cur.id, ${affiliateId}::uuid, cur.status, ${status}, ${text(note, 1000)}, ${actor} FROM cur JOIN upd ON upd.id = cur.id
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.compliance_item_status', 'affiliates', ${affiliateId},
                 jsonb_build_object('item_id', cur.id, 'from', cur.status, 'to', ${status}::text) FROM cur JOIN upd ON upd.id = cur.id
        ) SELECT id FROM upd` as any[]
      return rows.length === 1
    },

    /** Issue a warning. When notify_affiliate, a notification is queued in the same statement (email failure can never undo it). */
    async issueWarning(affiliateId: string, v: NonNullable<ReturnType<typeof validateWarningInput> extends Result<infer T> ? T : never>, actor: string) {
      const rows = await sql`
        WITH ins AS (
          INSERT INTO affiliate_compliance_warnings (affiliate_id, item_id, severity, category, summary, internal_note, notify_affiliate, issued_by)
          VALUES (${affiliateId}::uuid, ${v.itemId}::uuid, ${v.severity}, ${v.category}, ${v.summary}, ${v.internalNote}, ${v.notifyAffiliate}, ${actor})
          RETURNING id, severity, category, summary, notify_affiliate
        ), q AS (
          INSERT INTO affiliate_portal_notifications (affiliate_id, kind, dedupe_key, payload)
          SELECT ${affiliateId}::uuid, 'compliance_warning', 'compliance_warning:' || id::text,
                 jsonb_build_object('severity', severity, 'category', category, 'message', summary)
            FROM ins WHERE notify_affiliate
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.compliance_warning', 'affiliates', ${affiliateId},
                 jsonb_build_object('warning_id', id, 'severity', severity, 'category', category) FROM ins
        ) SELECT id FROM ins` as any[]
      return rows[0]?.id as string
    },

    async resolveWarning(affiliateId: string, warningId: string, note: string | null, actor: string): Promise<boolean> {
      const rows = await sql`
        WITH upd AS (
          UPDATE affiliate_compliance_warnings
             SET status = 'resolved', resolved_at = NOW(), resolved_by = ${actor}, resolution_note = ${text(note, 500)}
           WHERE id = ${warningId}::uuid AND affiliate_id = ${affiliateId}::uuid AND status = 'open' RETURNING id
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.compliance_warning_resolve', 'affiliates', ${affiliateId}, jsonb_build_object('warning_id', id) FROM upd
        ) SELECT id FROM upd` as any[]
      return rows.length === 1
    },

    async setPaidAdsPolicy(affiliateId: string, policy: string, note: string | null, actor: string) {
      const rows = await sql`SELECT set_affiliate_paid_ads_policy(${affiliateId}::uuid, ${policy}, ${text(note, 200)}, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    async suspend(affiliateId: string, reason: string, revokePortal: boolean, actor: string) {
      const rows = await sql`SELECT suspend_affiliate_for_compliance(${affiliateId}::uuid, ${reason}, ${revokePortal}, ${actor}) AS r` as any[]
      return rows[0]?.r
    },

    // ── fraud / abuse flags ──────────────────────────────────────────────────
    async openFlag(affiliateId: string, v: { signal: string; severity?: string; orderId?: string | null; note: string | null; freeze?: boolean }, actor: string) {
      if (!inList(FLAG_SIGNALS, v.signal)) throw new Error('BAD_SIGNAL')
      const sev = inList(['info', 'review', 'high'] as const, v.severity) ? v.severity : 'review'
      const rows = await sql`
        WITH ins AS (
          INSERT INTO affiliate_fraud_flags (affiliate_id, order_id, signal, source, severity, freeze_commissions, investigation_note, created_by)
          VALUES (${affiliateId}::uuid, ${v.orderId ?? null}::uuid, ${v.signal}, 'admin', ${sev}, ${v.freeze === true}, ${text(v.note, 1000)}, ${actor})
          RETURNING id, freeze_commissions
        ), ev AS (
          INSERT INTO affiliate_fraud_flag_events (flag_id, affiliate_id, action, to_status, note, actor_email)
          SELECT id, ${affiliateId}::uuid, 'opened', 'open', ${text(v.note, 1000)}, ${actor} FROM ins
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.fraud_flag_open', 'affiliates', ${affiliateId},
                 jsonb_build_object('flag_id', id, 'signal', ${v.signal}::text, 'freeze', freeze_commissions) FROM ins
        ) SELECT id FROM ins` as any[]
      return rows[0]?.id as string
    },

    /** Investigate / freeze / unfreeze / resolve / dismiss. Resolve & dismiss need a written note. */
    async updateFlag(affiliateId: string, flagId: string,
      v: { status?: string; note?: string | null; freeze?: boolean }, actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
      if (v.status !== undefined && !inList(FLAG_STATUSES, v.status)) return { ok: false, error: 'That status is not valid.' }
      const closing = v.status === 'resolved' || v.status === 'dismissed'
      const note = text(v.note, 1000)
      if (closing && (!note || note.length < 5)) return { ok: false, error: 'Add a note explaining the outcome.' }
      const rows = await sql`
        WITH cur AS (SELECT id, status, freeze_commissions FROM affiliate_fraud_flags
                      WHERE id = ${flagId}::uuid AND affiliate_id = ${affiliateId}::uuid FOR UPDATE),
        upd AS (
          UPDATE affiliate_fraud_flags f SET
            status = COALESCE(${v.status ?? null}, f.status),
            freeze_commissions = CASE WHEN ${v.freeze !== undefined} THEN ${v.freeze === true} ELSE f.freeze_commissions END,
            investigation_note = COALESCE(${closing ? null : note}, f.investigation_note),
            resolved_at = CASE WHEN ${closing} THEN NOW() ELSE f.resolved_at END,
            resolved_by = CASE WHEN ${closing} THEN ${actor} ELSE f.resolved_by END,
            resolution_note = CASE WHEN ${closing} THEN ${note} ELSE f.resolution_note END
          FROM cur WHERE f.id = cur.id AND (cur.status IN ('open','investigating') OR ${v.status === undefined && v.freeze === undefined})
          RETURNING f.id, f.status, f.freeze_commissions
        ), ev AS (
          INSERT INTO affiliate_fraud_flag_events (flag_id, affiliate_id, action, from_status, to_status, note, actor_email)
          SELECT cur.id, ${affiliateId}::uuid,
                 CASE WHEN ${v.freeze !== undefined} AND cur.freeze_commissions IS DISTINCT FROM upd.freeze_commissions
                      THEN CASE WHEN upd.freeze_commissions THEN 'freeze' ELSE 'unfreeze' END
                      WHEN ${v.status !== undefined} AND cur.status IS DISTINCT FROM upd.status THEN 'status_change' ELSE 'note' END,
                 cur.status, upd.status, ${note}, ${actor}
            FROM cur JOIN upd ON upd.id = cur.id
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.fraud_flag_update', 'affiliates', ${affiliateId},
                 jsonb_build_object('flag_id', upd.id, 'status', upd.status, 'freeze', upd.freeze_commissions) FROM upd
        ) SELECT id FROM upd` as any[]
      return rows.length === 1 ? { ok: true } : { ok: false, error: 'Flag not found or already closed.' }
    },

    /**
     * Self-referral HEURISTIC. Read-only over existing attribution data; the only write is an idempotent
     * `review`/`info` flag (never frozen, never an accusation). Matches: customer email equals the affiliate's
     * email (exact → review) or equals it after lowercasing / removing +tags / gmail dots (similar → info).
     * The flag stores NO email — only that a match of that kind exists on that order.
     */
    async scanSelfReferral(opts: { sinceDays?: number; affiliateId?: string | null; actor?: string } = {}) {
      const since = Math.min(Math.max(Math.trunc(opts.sinceDays ?? 3), 1), 3650)
      const actor = opts.actor ?? 'system:affiliate-maintenance'
      const aff = opts.affiliateId ?? null
      const hasProfiles = ((await sql`SELECT to_regclass('public.affiliate_profiles') IS NOT NULL AS p` as any[])[0]?.p) === true

      const rows = hasProfiles ? await sql`
        WITH cand AS (
          SELECT att.affiliate_id, att.order_id,
                 CASE WHEN LOWER(BTRIM(o.customer_email)) IN (LOWER(BTRIM(COALESCE(a.email,''))), COALESCE(p.email_normalized,'')) THEN 'exact' ELSE 'normalized' END AS kind
            FROM order_affiliate_attributions att
            JOIN orders o ON o.id = att.order_id
            JOIN affiliates a ON a.id = att.affiliate_id
            LEFT JOIN affiliate_profiles p ON p.affiliate_id = att.affiliate_id
           WHERE att.attributed_at >= NOW() - make_interval(days => ${since}::integer)
             AND (${aff}::uuid IS NULL OR att.affiliate_id = ${aff}::uuid)
             AND o.customer_email IS NOT NULL
             AND affiliate_match_email(o.customer_email) IS NOT NULL
             AND affiliate_match_email(o.customer_email) IN (affiliate_match_email(a.email), affiliate_match_email(p.email_normalized))
        ), ins AS (
          INSERT INTO affiliate_fraud_flags (affiliate_id, order_id, signal, source, severity, freeze_commissions, detail, created_by)
          SELECT affiliate_id, order_id,
                 CASE WHEN kind = 'exact' THEN 'customer_email_matches_affiliate' ELSE 'customer_email_similar_to_affiliate' END,
                 'heuristic', CASE WHEN kind = 'exact' THEN 'review' ELSE 'info' END, FALSE,
                 jsonb_build_object('match', kind), ${actor}
            FROM cand
          ON CONFLICT (affiliate_id, order_id, signal) WHERE source = 'heuristic' AND order_id IS NOT NULL DO NOTHING
          RETURNING id, affiliate_id
        ), ev AS (
          INSERT INTO affiliate_fraud_flag_events (flag_id, affiliate_id, action, to_status, note, actor_email)
          SELECT id, affiliate_id, 'opened', 'open', 'Raised by the self-referral check. Needs a human review.', ${actor} FROM ins
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.fraud_flag_detected', 'affiliates', affiliate_id::text, jsonb_build_object('flag_id', id) FROM ins
        ) SELECT (SELECT COUNT(*) FROM cand)::int AS candidates, (SELECT COUNT(*) FROM ins)::int AS created` as any[]
      : await sql`
        WITH cand AS (
          SELECT att.affiliate_id, att.order_id,
                 CASE WHEN LOWER(BTRIM(o.customer_email)) = LOWER(BTRIM(COALESCE(a.email,''))) THEN 'exact' ELSE 'normalized' END AS kind
            FROM order_affiliate_attributions att
            JOIN orders o ON o.id = att.order_id
            JOIN affiliates a ON a.id = att.affiliate_id
           WHERE att.attributed_at >= NOW() - make_interval(days => ${since}::integer)
             AND (${aff}::uuid IS NULL OR att.affiliate_id = ${aff}::uuid)
             AND o.customer_email IS NOT NULL
             AND affiliate_match_email(o.customer_email) IS NOT NULL
             AND affiliate_match_email(o.customer_email) = affiliate_match_email(a.email)
        ), ins AS (
          INSERT INTO affiliate_fraud_flags (affiliate_id, order_id, signal, source, severity, freeze_commissions, detail, created_by)
          SELECT affiliate_id, order_id,
                 CASE WHEN kind = 'exact' THEN 'customer_email_matches_affiliate' ELSE 'customer_email_similar_to_affiliate' END,
                 'heuristic', CASE WHEN kind = 'exact' THEN 'review' ELSE 'info' END, FALSE,
                 jsonb_build_object('match', kind), ${actor}
            FROM cand
          ON CONFLICT (affiliate_id, order_id, signal) WHERE source = 'heuristic' AND order_id IS NOT NULL DO NOTHING
          RETURNING id, affiliate_id
        ), ev AS (
          INSERT INTO affiliate_fraud_flag_events (flag_id, affiliate_id, action, to_status, note, actor_email)
          SELECT id, affiliate_id, 'opened', 'open', 'Raised by the self-referral check. Needs a human review.', ${actor} FROM ins
        ), aud AS (
          INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
          SELECT ${actor}, 'affiliate.fraud_flag_detected', 'affiliates', affiliate_id::text, jsonb_build_object('flag_id', id) FROM ins
        ) SELECT (SELECT COUNT(*) FROM cand)::int AS candidates, (SELECT COUNT(*) FROM ins)::int AS created` as any[]
      return { candidates: Number(rows[0]?.candidates ?? 0), created: Number(rows[0]?.created ?? 0) }
    },
  }
}

export type AffiliateComplianceService = ReturnType<typeof createAffiliateComplianceService>
