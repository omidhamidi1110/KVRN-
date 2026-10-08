// lib/affiliate-portal.ts — read models for the affiliate portal. OWN DATA ONLY.
// Server-only.
//
// RULES
//   * Every method takes the affiliate id as its first argument and every query filters on it. Route handlers
//     pass ONLY the id from the validated session (requireAffiliate) — never anything from the request.
//   * NO new money math. Numbers come from the existing append-only ledger, affiliate_commission_payable(),
//     affiliate_outstanding_merchandise(), payout lines and affiliate_portal_balances() (034, pure sums of those).
//   * Unknown is never zero: an unresolved commission is reported as such, and net revenue that cannot be
//     determined is flagged `partial` with the count of orders under review.
//   * Sale detail is the MINIMUM that explains a commission: date, product summary, attributable/net sale
//     amount, commission amount/status, reversal status and a non-reversible reference (never the order number).
import { getSiteOrigin } from '@/lib/site-origin'
import { maskEmail } from '@/lib/affiliate-portal-validation'
import {
  getAcceptanceState, getProfileByAffiliateId, type ProfileRow,
} from '@/lib/affiliate-portal-bridge'

type Sql = any

export const RANGE_KEYS = ['30d', '90d', 'ytd', 'all'] as const
export type RangeKey = typeof RANGE_KEYS[number]
export const SUPPORT_EMAIL_HINT = 'support@kvrn.shop'

export function resolveRange(key: string | null | undefined, now = new Date()): { key: RangeKey; start: string; end: string } {
  const k: RangeKey = (RANGE_KEYS as readonly string[]).includes(key ?? '') ? (key as RangeKey) : '30d'
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  let start: Date
  if (k === '30d') start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29))
  else if (k === '90d') start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89))
  else if (k === 'ytd') start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  else start = new Date(Date.UTC(2024, 0, 1))
  return { key: k, start: start.toISOString(), end: end.toISOString() }
}

// ── pure status derivation ───────────────────────────────────────────────────
export type SaleStatus = 'pending' | 'available' | 'in_payout' | 'paid' | 'reversed' | 'under_review'
export type ReversalStatus = 'none' | 'partial' | 'full' | 'under_review'

export function deriveSaleStatus(c: {
  status: string; incomplete: boolean; payableCents: number; reservedCents: number
}): SaleStatus {
  if (c.incomplete) return 'under_review'
  if (c.status === 'reversed') return 'reversed'
  if (c.reservedCents > 0) return 'in_payout'
  if (c.payableCents > 0 && (c.status === 'approved' || c.status === 'paid')) return 'available'
  if (c.status === 'paid') return 'paid'
  if (c.status === 'approved') return 'available'
  return 'pending'
}

export function deriveReversalStatus(c: { incomplete: boolean; commissionCents: number; netLedgerCents: number }): ReversalStatus {
  if (c.incomplete) return 'under_review'
  if (c.commissionCents > 0 && c.netLedgerCents <= 0) return 'full'
  if (c.netLedgerCents < c.commissionCents) return 'partial'
  return 'none'
}

export type PayoutDisplayStatus = 'processing' | 'paid' | 'failed' | 'cancelled'
export function derivePayoutDisplayStatus(p: { status: string; lastAttemptStatus: string | null }): PayoutDisplayStatus {
  if (p.status === 'paid') return 'paid'
  if (p.status === 'void') return 'cancelled'
  if (p.lastAttemptStatus === 'failed') return 'failed'
  return 'processing'
}

const n = (v: unknown) => Number(v ?? 0)
const iso = (v: unknown) => (v ? new Date(v as any).toISOString() : null)

export function createAffiliatePortalService(sql: Sql, deps: { siteOrigin?: () => string | null } = {}) {
  const origin = deps.siteOrigin ?? getSiteOrigin

  async function summary(affiliateId: string) {
    const rows = await sql`
      SELECT a.code, a.name, a.default_commission_type AS ctype, a.default_commission_rate_bps AS rate_bps,
             a.default_commission_fixed_cents AS fixed_cents, a.attribution_window_days AS window_days,
             a.commission_hold_days AS hold_days,
             d.code AS discount_code, d.type AS discount_type, d.percentage_bps AS discount_bps,
             d.amount_cents AS discount_cents, d.active AS discount_active,
             affiliate_active_at(a.id, NOW()) AS code_live
        FROM affiliates a LEFT JOIN discounts d ON d.id = a.discount_id
       WHERE a.id = ${affiliateId}::uuid` as any[]
    const r = rows[0]
    if (!r) return null
    const links = await sql`
      SELECT slug FROM affiliate_links WHERE affiliate_id = ${affiliateId}::uuid AND active
       ORDER BY created_at LIMIT 5` as any[]
    const profile = await getProfileByAffiliateId(sql, affiliateId)
    return {
      name: profile?.displayName || r.name,
      programStatus: profile?.programStatus ?? null,
      code: r.code as string,
      codeLive: r.code_live === true,
      referralPaths: links.map(l => `/r/${l.slug}`),
      siteOrigin: origin(),
      discount: r.discount_code ? {
        code: r.discount_code as string,
        kind: r.discount_type as string,
        percentageBps: r.discount_bps === null ? null : n(r.discount_bps),
        amountCents: r.discount_cents === null ? null : n(r.discount_cents),
        active: r.discount_active === true,
      } : null,
      commissionRule: {
        type: r.ctype as 'percentage' | 'fixed',
        rateBps: r.rate_bps === null ? null : n(r.rate_bps),
        fixedCents: r.fixed_cents === null ? null : n(r.fixed_cents),
        basis: 'net merchandise (after discounts, before shipping and tax)',
      },
      attributionWindowDays: n(r.window_days),
      holdDays: n(r.hold_days),
      loginHint: maskEmail(profile?.emailNormalized),
    }
  }

  async function balances(affiliateId: string) {
    const rows = await sql`SELECT * FROM affiliate_portal_balances(${affiliateId}::uuid)` as any[]
    const b = rows[0] ?? {}
    return {
      earnedCents: n(b.earned_cents), reversedCents: n(b.reversed_cents), restoredCents: n(b.restored_cents),
      pendingCents: n(b.pending_cents), availableCents: n(b.available_cents), inPayoutCents: n(b.in_payout_cents),
      paidCents: n(b.paid_cents), recoveredCents: n(b.recovered_cents), owedBackCents: n(b.owed_back_cents),
      // Value not yet certain: shown as "Unresolved", never folded into pending or zero.
      unresolvedCents: n(b.unresolved_cents), unresolvedCount: n(b.incomplete_count),
    }
  }

  async function performance(affiliateId: string, range: { start: string; end: string }) {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_id = ${affiliateId}::uuid
            AND occurred_at >= ${range.start}::timestamptz AND occurred_at < ${range.end}::timestamptz)::int AS clicks,
        (SELECT COUNT(*) FROM order_affiliate_attributions WHERE affiliate_id = ${affiliateId}::uuid
            AND attributed_at >= ${range.start}::timestamptz AND attributed_at < ${range.end}::timestamptz)::int AS orders,
        (SELECT COALESCE(SUM(o.subtotal_cents),0) FROM order_affiliate_attributions att JOIN orders o ON o.id = att.order_id
          WHERE att.affiliate_id = ${affiliateId}::uuid
            AND att.attributed_at >= ${range.start}::timestamptz AND att.attributed_at < ${range.end}::timestamptz)::bigint AS gross,
        (SELECT COALESCE(SUM(c.base_cents - affiliate_outstanding_merchandise(c.id)),0)
           FROM affiliate_commissions c JOIN order_affiliate_attributions att ON att.id = c.attribution_id
          WHERE c.affiliate_id = ${affiliateId}::uuid AND NOT c.incomplete
            AND att.attributed_at >= ${range.start}::timestamptz AND att.attributed_at < ${range.end}::timestamptz)::bigint AS net,
        (SELECT COUNT(*) FROM affiliate_commissions c JOIN order_affiliate_attributions att ON att.id = c.attribution_id
          WHERE c.affiliate_id = ${affiliateId}::uuid AND c.incomplete
            AND att.attributed_at >= ${range.start}::timestamptz AND att.attributed_at < ${range.end}::timestamptz)::int AS incomplete_orders` as any[]
    const r = rows[0] ?? {}
    return {
      clicks: n(r.clicks), attributedOrders: n(r.orders),
      grossReferredSalesCents: n(r.gross),
      netReferredRevenueCents: n(r.net),
      // true ⇒ the net figure excludes orders still under review; the UI must say so.
      netIsPartial: n(r.incomplete_orders) > 0,
      ordersUnderReview: n(r.incomplete_orders),
    }
  }

  return {
    summary,
    balances,
    performance,

    async overview(affiliateId: string, rangeKey?: string | null) {
      const range = resolveRange(rangeKey)
      const [s, b, p] = await Promise.all([summary(affiliateId), balances(affiliateId), performance(affiliateId, range)])
      return { range: { key: range.key, start: range.start, end: range.end }, summary: s, balances: b, performance: p }
    },

    async listSales(affiliateId: string, opts: { limit?: number; offset?: number } = {}) {
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), 100)
      const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
      await sql`SELECT promote_eligible_commissions_for_affiliate(${affiliateId}::uuid)`
      const rows = await sql`
        SELECT c.id AS cid, att.attributed_at, c.base_cents, c.commission_cents, c.status, c.incomplete,
               affiliate_public_ref('sale', c.id, c.affiliate_id) AS ref,
               affiliate_commission_payable(c.id) AS payable_cents,
               COALESCE((SELECT SUM(a.adjustment_cents) FROM affiliate_commission_adjustments a WHERE a.commission_id = c.id),0)::int AS net_ledger_cents,
               affiliate_outstanding_merchandise(c.id) AS outstanding_merch,
               COALESCE((SELECT SUM(l.amount_cents) FROM affiliate_payout_lines l JOIN affiliate_payouts p ON p.id = l.payout_id
                          WHERE l.commission_id = c.id AND p.status = 'draft'),0)::int AS reserved_cents,
               (SELECT string_agg(
                         oi.product_name || ' · ' || oi.color || ' · ' || oi.size
                         || CASE WHEN oi.quantity > 1 THEN ' ×' || oi.quantity ELSE '' END, '; ' ORDER BY oi.created_at)
                  FROM (SELECT * FROM order_items WHERE order_id = c.order_id ORDER BY created_at LIMIT 4) oi) AS items,
               (SELECT COUNT(*) FROM order_items WHERE order_id = c.order_id)::int AS item_lines
          FROM affiliate_commissions c
          JOIN order_affiliate_attributions att ON att.id = c.attribution_id
         WHERE c.affiliate_id = ${affiliateId}::uuid
         ORDER BY att.attributed_at DESC, c.id DESC
         LIMIT ${limit + 1} OFFSET ${offset}` as any[]
      const page = rows.slice(0, limit)
      return {
        hasMore: rows.length > limit,
        sales: page.map(r => {
          const incomplete = r.incomplete === true
          const commissionCents = n(r.commission_cents)
          const netLedgerCents = n(r.net_ledger_cents)
          return {
            ref: r.ref as string | null,
            date: iso(r.attributed_at),
            items: (r.items as string | null) ? `${r.items}${n(r.item_lines) > 4 ? ` +${n(r.item_lines) - 4} more` : ''}` : null,
            attributableSaleCents: n(r.base_cents),
            // Unknown while a refund / dispute is unresolved: null, never a fake number.
            netSaleCents: incomplete ? null : n(r.base_cents) - n(r.outstanding_merch),
            commissionCents,
            netCommissionCents: incomplete ? null : netLedgerCents,
            status: deriveSaleStatus({ status: r.status, incomplete, payableCents: n(r.payable_cents), reservedCents: n(r.reserved_cents) }),
            reversalStatus: deriveReversalStatus({ incomplete, commissionCents, netLedgerCents }),
          }
        }),
      }
    },

    async listPayouts(affiliateId: string) {
      const rows = await sql`
        SELECT p.status, p.amount_cents, p.paid_at, p.method, p.created_at,
               affiliate_public_ref('payout', p.id, p.affiliate_id) AS ref,
               (SELECT COUNT(*) FROM affiliate_payout_lines l WHERE l.payout_id = p.id)::int AS line_count,
               (SELECT at.status FROM affiliate_payout_attempts at WHERE at.payout_id = p.id ORDER BY at.attempt_no DESC LIMIT 1) AS last_attempt
          FROM affiliate_payouts p
         WHERE p.affiliate_id = ${affiliateId}::uuid
         ORDER BY p.created_at DESC LIMIT 100` as any[]
      return rows.map(r => ({
        ref: r.ref as string | null,
        status: derivePayoutDisplayStatus({ status: r.status, lastAttemptStatus: r.last_attempt ?? null }),
        amountCents: n(r.amount_cents),
        currency: 'USD',
        date: iso(r.paid_at ?? r.created_at),
        method: typeof r.method === 'string' && /^[A-Za-z0-9 _-]{1,24}$/.test(r.method) ? r.method : null,
        lineCount: n(r.line_count),
      }))
    },

    /** Resolved ONLY through (ref, affiliate): another affiliate's ref, or a UUID, finds nothing. */
    async findOwnPayoutByRef(affiliateId: string, ref: string): Promise<{ id: string } | null> {
      if (!/^P-[0-9A-F]{10}$/.test(ref)) return null
      const rows = await sql`
        SELECT p.id FROM affiliate_public_refs r
          JOIN affiliate_payouts p ON p.id = r.source_id AND p.affiliate_id = r.affiliate_id
         WHERE r.kind = 'payout' AND r.ref = ${ref} AND r.affiliate_id = ${affiliateId}::uuid` as any[]
      return rows[0] ? { id: rows[0].id } : null
    },

    async onboarding(affiliateId: string) {
      const profile: ProfileRow | null = await getProfileByAffiliateId(sql, affiliateId)
      if (!profile) return null
      const [docs, warnings, account] = await Promise.all([
        getAcceptanceState(sql, affiliateId),
        sql`SELECT severity, category, summary, status, issued_at
              FROM affiliate_compliance_warnings
             WHERE affiliate_id = ${affiliateId}::uuid AND notify_affiliate
             ORDER BY issued_at DESC LIMIT 20` as Promise<any[]>,
        sql`SELECT provider, masked_metadata FROM affiliate_payout_accounts
             WHERE affiliate_id = ${affiliateId}::uuid ORDER BY updated_at DESC LIMIT 1` as Promise<any[]>,
      ])
      const stale = docs.filter(d => d.needsAcceptance)
      return {
        readiness: {
          identity: profile.kycStatus,
          tax: profile.taxStatus,
          payoutMethod: profile.payoutMethodStatus,
          payoutProvider: profile.payoutProvider ?? account[0]?.provider ?? null,
          payoutMethodDisplay: account[0]?.masked_metadata ?? {},
        },
        terms: {
          acceptedProgramTermsVersion: profile.acceptedProgramTermsVersion,
          acceptedDisclosureVersion: profile.acceptedDisclosureVersion,
          requiresReacceptance: profile.requiresReacceptance || stale.some(d => d.docType === 'program_terms' || d.docType === 'disclosure_policy'),
          documents: docs.map(d => ({
            docType: d.docType, title: d.title, version: d.currentVersion,
            acceptedVersion: d.acceptedVersion, needsAcceptance: d.needsAcceptance,
          })),
        },
        paidAdsPolicy: profile.paidAdsPolicy,
        payoutThresholdCents: profile.payoutThresholdCents,
        payoutSchedule: profile.payoutSchedule,
        warnings: warnings.map(w => ({
          severity: w.severity as string, category: w.category as string, message: w.summary as string,
          status: w.status as string, date: iso(w.issued_at),
        })),
        help: { contact: SUPPORT_EMAIL_HINT },
      }
    },

    async profile(affiliateId: string) {
      const p = await getProfileByAffiliateId(sql, affiliateId)
      if (!p) return null
      return {
        displayName: p.displayName, website: p.website, socialLinks: p.socialLinks,
        country: p.country, region: p.stateRegion, programStatus: p.programStatus,
      }
    },
  }
}

export type AffiliatePortalService = ReturnType<typeof createAffiliatePortalService>
