// lib/affiliates.ts — affiliate / referral accounting
// Server-only.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
//
// It never computes money. Commission amounts, reversals, payable balances and
// payout totals are all derived in SQL, because those are the numbers the books
// depend on and a browser must never be able to influence them. This layer
// validates shape, calls the canonical functions, and formats results.
//
// It is also not a second discount engine: an affiliate's customer discount is an
// ordinary `discounts` row, so claims, redemptions, stacking and the
// NO_CLAIM_FOR_LIMITED_CODE invariant in finalize_paid_order all keep working.
//
// ── THE TWO SEPARATE ECONOMIC EFFECTS ───────────────────────────────────────
//
//   customer discount   reduces what the customer paid (orders.discount_cents)
//   affiliate commission a cost KVRN owes the affiliate
//
// Both may apply to one order. The discount reduces the commission base, so it is
// accounted exactly once.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export const AFFILIATE_STATUSES = ['active', 'paused', 'terminated'] as const
export type AffiliateStatus = typeof AFFILIATE_STATUSES[number]

export const COMMISSION_TYPES = ['percentage', 'fixed'] as const
export type CommissionType = typeof COMMISSION_TYPES[number]

export const FIXED_REVERSAL_POLICIES = ['proportional', 'all_or_nothing'] as const
export type FixedReversalPolicy = typeof FIXED_REVERSAL_POLICIES[number]

export const COMMISSION_STATUSES = ['pending', 'approved', 'paid', 'reversed'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/
const MAX_CENTS = 1_000_000_00

type Result = { ok: true } | { ok: false; error: string }

export interface CreateAffiliateInput {
  code:  string
  name:  string
  email?: string | null
  commissionType: CommissionType
  commissionRateBps?: number | null
  commissionFixedCents?: number | null
  fixedReversalPolicy?: FixedReversalPolicy
  attributionWindowDays?: number
  commissionHoldDays?: number
  discountId?: string | null
  notes?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

export function validateCreateAffiliate(d: Partial<CreateAffiliateInput>): Result {
  if (!d.code || !CODE_RE.test(d.code)) {
    return { ok: false, error: 'Code must be 2–32 characters: A–Z, 0–9, hyphen or underscore.' }
  }
  if (!d.name || !d.name.trim()) {
    return { ok: false, error: 'Name is required.' }
  }
  if (!d.commissionType || !COMMISSION_TYPES.includes(d.commissionType)) {
    return { ok: false, error: 'Commission type must be percentage or fixed.' }
  }

  if (d.commissionType === 'percentage') {
    const bps = d.commissionRateBps
    if (bps === undefined || bps === null) {
      return { ok: false, error: 'A percentage rate is required.' }
    }
    if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) {
      return { ok: false, error: 'Rate must be between 0.01% and 100% (1–10000 basis points).' }
    }
  } else {
    const fixed = d.commissionFixedCents
    if (fixed === undefined || fixed === null) {
      return { ok: false, error: 'A fixed commission amount is required.' }
    }
    if (!Number.isInteger(fixed) || fixed < 0 || fixed > MAX_CENTS) {
      return { ok: false, error: 'Fixed commission must be a non-negative whole number of cents.' }
    }
  }

  if (d.fixedReversalPolicy && !FIXED_REVERSAL_POLICIES.includes(d.fixedReversalPolicy)) {
    return { ok: false, error: 'Reversal policy is not valid.' }
  }
  // Bounds mirror the migration-020 CHECK constraints exactly. Accepting a value
  // the database rejects would turn a validation error into a 500.
  for (const [label, v, min, max] of [
    ['Attribution window', d.attributionWindowDays, 1, 365],   // CHECK > 0
    ['Commission hold',    d.commissionHoldDays,    0, 365],   // CHECK >= 0
  ] as const) {
    if (v === undefined || v === null) continue
    if (!Number.isInteger(v) || v < min || v > max) {
      return { ok: false,
               error: `${label} must be a whole number of days between ${min} and ${max}.` }
    }
  }
  if (d.discountId && !UUID_RE.test(d.discountId)) {
    return { ok: false, error: 'Linked discount is not valid.' }
  }
  return { ok: true }
}

/**
 * A dispute decomposition must total the disputed amount EXACTLY.
 * Nothing may be omitted and silently treated as zero, and nothing is inferred.
 */
export function validateDisputeDecomposition(
  d: { merchandiseCents?: unknown; shippingCents?: unknown; taxCents?: unknown },
  disputedAmountCents: number,
): Result {
  const parts: Array<[string, unknown]> = [
    ['Merchandise', d.merchandiseCents],
    ['Shipping',    d.shippingCents],
    ['Tax',         d.taxCents],
  ]
  for (const [label, v] of parts) {
    if (v === undefined || v === null) {
      return { ok: false, error: `${label} amount is required — it cannot be left blank.` }
    }
    if (!Number.isInteger(v) || (v as number) < 0) {
      return { ok: false, error: `${label} must be a non-negative whole number of cents.` }
    }
  }
  const sum = (d.merchandiseCents as number) + (d.shippingCents as number) + (d.taxCents as number)
  if (sum !== disputedAmountCents) {
    return {
      ok: false,
      error: `Components must total exactly the disputed amount. Entered ${sum}, disputed is ${disputedAmountCents}.`,
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export function createAffiliatesService(sql: NeonQueryFunction<false, false>) {
  return {
    async listAffiliates() {
      const rows = await sql`
        SELECT a.id, a.code, a.name, a.email, a.status,
               a.default_commission_type   AS "commissionType",
               a.default_commission_rate_bps AS "commissionRateBps",
               a.default_commission_fixed_cents AS "commissionFixedCents",
               a.default_fixed_reversal_policy  AS "fixedReversalPolicy",
               a.attribution_window_days AS "attributionWindowDays",
               a.commission_hold_days    AS "commissionHoldDays",
               a.discount_id AS "discountId", d.code AS "discountCode",
               a.created_at AS "createdAt",
               (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.affiliate_id = a.id)::int
                 AS "orderCount",
               -- Money always from the ledger, never recomputed here.
               COALESCE((SELECT SUM(adj.adjustment_cents)
                         FROM affiliate_commission_adjustments adj
                         WHERE adj.affiliate_id = a.id), 0)::int AS "netCommissionCents",
               COALESCE((SELECT SUM(p.amount_cents) FROM affiliate_payouts p
                         WHERE p.affiliate_id = a.id AND p.status = 'paid'), 0)::int
                 AS "paidCents",
               (SELECT COUNT(*) FROM affiliate_commissions c
                 WHERE c.affiliate_id = a.id AND c.incomplete)::int AS "incompleteCount"
        FROM affiliates a
        LEFT JOIN discounts d ON d.id = a.discount_id
        ORDER BY a.created_at DESC
      `
      return (rows as any[]).map(r => ({
        ...r,
        commissionRateBps:    r.commissionRateBps    === null ? null : Number(r.commissionRateBps),
        commissionFixedCents: r.commissionFixedCents === null ? null : Number(r.commissionFixedCents),
        attributionWindowDays: Number(r.attributionWindowDays),
        commissionHoldDays:    Number(r.commissionHoldDays),
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    },

    /**
     * Create an affiliate through the canonical SQL function.
     *
     * One transaction writes the affiliate row, its initial status event, its
     * initial TERMS event and the audit record. Splitting these across separate
     * statements previously meant the terms ledger was never seeded, so
     * affiliate_terms_at() silently fell back to the mutable current row and a
     * late backfill would have used present-day rates.
     */
    async createAffiliate(input: CreateAffiliateInput, actorEmail: string) {
      const rows = await sql`SELECT create_affiliate(
        ${input.code.toUpperCase()}, ${input.name.trim()}, ${input.email ?? null},
        ${input.commissionType},
        ${input.commissionRateBps ?? null}::integer,
        ${input.commissionFixedCents ?? null}::integer,
        ${input.fixedReversalPolicy ?? 'proportional'},
        ${input.attributionWindowDays ?? 30}::integer,
        ${input.commissionHoldDays ?? 30}::integer,
        ${input.discountId ?? null}::uuid,
        ${input.notes ?? null}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result?.affiliate_id as string
    },

    /** Append new financial terms; history stays immutable. */
    async updateTerms(affiliateId: string, t: {
      commissionType: CommissionType
      commissionRateBps?: number | null
      commissionFixedCents?: number | null
      fixedReversalPolicy: FixedReversalPolicy
      attributionWindowDays: number
      commissionHoldDays: number
      discountId?: string | null
      effectiveAt?: string | null
      reason?: string | null
    }, actorEmail: string) {
      const rows = await sql`SELECT update_affiliate_terms(
        ${affiliateId}::uuid, ${t.commissionType},
        ${t.commissionRateBps ?? null}::integer, ${t.commissionFixedCents ?? null}::integer,
        ${t.fixedReversalPolicy}, ${t.attributionWindowDays}::integer,
        ${t.commissionHoldDays}::integer, ${t.discountId ?? null}::uuid,
        ${t.effectiveAt ?? null}::timestamptz, ${t.reason ?? null}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Deterministic late attribution.
     *
     * Recovers the visitor's opaque session from persisted order data, so an
     * admin only ever supplies the ORDER. Idempotent and audited inside the
     * canonical transaction.
     */
    async backfillAttribution(
      orderId: string, actorEmail: string,
      recoveredSessionId: string | null = null,
    ) {
      const rows = await sql`SELECT backfill_order_affiliate_attribution(
        ${orderId}::uuid, ${recoveredSessionId}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Is the locally persisted referral session actually USABLE?
     *
     * `Boolean(sid)` was unsafe. A corrupt or truncated kvrn_sid is non-empty, so
     * it suppressed the Stripe fallback — and the SQL resolver then ignored it
     * because it maps to no click, yielding no_attribution. That converts
     * CORRUPT EVIDENCE into a confident negative, which is the one outcome this
     * whole recovery path exists to prevent.
     *
     * A local sid counts only when BOTH hold:
     *   1. it matches the canonical opaque format, and
     *   2. it maps to a real affiliate_clicks row.
     *
     * Otherwise the caller must fall through to the authoritative Stripe
     * checkout session, exactly as if nothing had been stored.
     */
    async needsStripeSessionRecovery(orderId: string) {
      const [row] = (await sql`
        SELECT attribution->>'kvrn_sid'    AS sid,
               stripe_checkout_session_id  AS "checkoutSessionId"
        FROM orders WHERE id = ${orderId}::uuid
      `) as any[]
      if (!row) return null

      const sid: string | null = row.sid ?? null
      const wellFormed = typeof sid === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(sid)

      let evidenced = false
      if (wellFormed) {
        const hits = await sql`
          SELECT 1 FROM affiliate_clicks WHERE session_id = ${sid} LIMIT 1
        `
        evidenced = (hits as any[]).length > 0
      }

      return {
        hasLocal: wellFormed && evidenced,
        checkoutSessionId: row.checkoutSessionId as string | null,
        // Reported so the caller can audit WHY a fallback was needed rather than
        // collapsing several different situations into one silent branch.
        localSidPresent: Boolean(sid),
        localSidWellFormed: wellFormed,
        localSidEvidenced: evidenced,
      }
    },

    /**
     * Change status with an EXPLICIT effective instant.
     *
     * A pause stops new qualifying activity from that instant; activity before it
     * still qualifies. Nothing already accrued, adjusted or owed is affected.
     */
    async setAffiliateStatus(
      affiliateId: string, status: AffiliateStatus,
      effectiveAt: string | null, reason: string | null, actorEmail: string,
    ) {
      const rows = await sql`SELECT set_affiliate_status(
        ${affiliateId}::uuid, ${status}, ${effectiveAt}::timestamptz,
        ${reason}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result?.outcome === 'updated'
    },

    async createLink(affiliateId: string, slug: string, destination: string, actorEmail: string) {
      const rows = await sql`SELECT create_affiliate_link(
        ${affiliateId}::uuid, ${slug}, ${destination || '/'}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result?.link_id as string
    },

    /** Record a referral click. Session id only — no IP, no PII. */
    async recordClick(slug: string, sessionId: string | null, referrer: string | null) {
      const rows = await sql`
        INSERT INTO affiliate_clicks (link_id, affiliate_id, session_id, referrer)
        SELECT l.id, l.affiliate_id, ${sessionId}, ${referrer}
        FROM affiliate_links l
        WHERE l.slug = ${slug} AND l.active
        RETURNING id
      `
      return (rows as any[])[0]?.id ?? null
    },

    async listCommissions(affiliateId?: string | null, limit = 200) {
      const rows = await sql`
        SELECT c.id, c.order_id AS "orderId", o.order_number AS "orderNumber",
               c.affiliate_id AS "affiliateId", a.code AS "affiliateCode",
               c.base_cents AS "baseCents", c.commission_cents AS "commissionCents",
               c.status, c.eligible_at AS "eligibleAt",
               c.incomplete, c.incomplete_reason AS "incompleteReason",
               affiliate_commission_payable(c.id) AS "payableCents",
               affiliate_commission_overpaid(c.id) AS "overpaidCents",
               COALESCE((SELECT SUM(adj.adjustment_cents)
                         FROM affiliate_commission_adjustments adj
                         WHERE adj.commission_id = c.id), 0)::int AS "netLedgerCents",
               att.attribution_method AS "attributionMethod",
               att.commission_type_snapshot AS "commissionTypeSnapshot",
               att.hold_days_snapshot AS "holdDaysSnapshot",
               c.created_at AS "createdAt"
        FROM affiliate_commissions c
        JOIN orders o ON o.id = c.order_id
        JOIN affiliates a ON a.id = c.affiliate_id
        JOIN order_affiliate_attributions att ON att.id = c.attribution_id
        WHERE (${affiliateId ?? null}::uuid IS NULL OR c.affiliate_id = ${affiliateId ?? null}::uuid)
        ORDER BY c.created_at DESC
        LIMIT ${limit}
      `
      return (rows as any[]).map(c => ({
        ...c,
        baseCents:       Number(c.baseCents),
        commissionCents: Number(c.commissionCents),
        payableCents:    Number(c.payableCents),
        overpaidCents:   Number(c.overpaidCents),
        netLedgerCents:  Number(c.netLedgerCents),
        holdDaysSnapshot: Number(c.holdDaysSnapshot),
        eligibleAt: new Date(c.eligibleAt).toISOString(),
        createdAt:  new Date(c.createdAt).toISOString(),
      }))
    },

    /** Full append-only history for one commission, with all three timestamps. */
    async getAdjustments(commissionId: string) {
      const rows = await sql`
        SELECT id, adjustment_cents AS "adjustmentCents",
               effective_at AS "effectiveAt", knowledge_at AS "knowledgeAt",
               reason, recovery_status AS "recoveryStatus",
               recovery_amount_cents AS "recoveryAmountCents",
               merchandise_reversed_this AS "merchandiseReversedThis",
               cumulative_merchandise_reversed_after AS "cumulativeMerchandiseReversed",
               source_refund_id AS "sourceRefundId",
               source_dispute_id AS "sourceDisputeId",
               created_by AS "createdBy", created_at AS "createdAt"
        FROM affiliate_commission_adjustments
        WHERE commission_id = ${commissionId}::uuid
        ORDER BY effective_at ASC, created_at ASC
      `
      return (rows as any[]).map(a => ({
        ...a,
        adjustmentCents: Number(a.adjustmentCents),
        recoveryAmountCents: a.recoveryAmountCents === null ? null : Number(a.recoveryAmountCents),
        merchandiseReversedThis: Number(a.merchandiseReversedThis),
        cumulativeMerchandiseReversed: Number(a.cumulativeMerchandiseReversed),
        effectiveAt: new Date(a.effectiveAt).toISOString(),
        knowledgeAt: new Date(a.knowledgeAt).toISOString(),
        createdAt:   new Date(a.createdAt).toISOString(),
      }))
    },

    /**
     * Unresolved blockers, ONE ROW PER SOURCE.
     *
     * A commission can be blocked by several things at once — two partial
     * disputes, or a refund and a dispute together. Returning one row per
     * COMMISSION made them indistinguishable, so the operator could not tell
     * which source a decomposition would resolve, and a UI keyed on commission id
     * would collapse or cross-contaminate them.
     *
     * Rows are therefore keyed by source. Dispute rows carry disputeId and are
     * decomposable here; refund rows carry refundId and belong to the refund
     * component workflow instead. The two are never conflated.
     *
     * Driven by affiliate_unresolved_sources(), which reads CURRENT exposure, so
     * a lost partial dispute appears even when 018 recorded no revenue delta and
     * therefore wrote no adjustment row at all.
     */
    async listIncomplete() {
      const rows = await sql`
        SELECT c.id                          AS "commissionId",
               s.source_kind                 AS "sourceKind",
               s.source_id                   AS "sourceId",
               s.detail                      AS "reason",
               c.order_id                    AS "orderId",
               o.order_number                AS "orderNumber",
               c.affiliate_id                AS "affiliateId",
               a.code                        AS "affiliateCode",
               c.commission_cents            AS "commissionCents",
               o.total_cents                 AS "orderTotalCents",
               o.subtotal_cents              AS "orderSubtotalCents",
               o.discount_cents              AS "orderDiscountCents",
               d.id                          AS "disputeId",
               d.amount_cents                AS "disputedAmountCents",
               d.status                      AS "disputeStatus",
               r.id                          AS "refundId",
               r.amount_cents                AS "refundAmountCents"
        FROM affiliate_commissions c
        JOIN orders o     ON o.id = c.order_id
        JOIN affiliates a ON a.id = c.affiliate_id
        CROSS JOIN LATERAL affiliate_unresolved_sources(c.id) s
        LEFT JOIN order_disputes d
          ON s.source_kind = 'dispute' AND d.id = s.source_id
        LEFT JOIN order_refunds r
          ON s.source_kind = 'refund'  AND r.id = s.source_id
        ORDER BY o.order_number, s.source_kind, s.source_id
      `
      return (rows as any[]).map(r => ({
        ...r,
        // Collision-safe across multiple blockers on one commission.
        rowKey: `${r.commissionId}:${r.sourceKind}:${r.sourceId}`,
        commissionCents:     Number(r.commissionCents),
        orderTotalCents:     Number(r.orderTotalCents),
        orderSubtotalCents:  Number(r.orderSubtotalCents),
        orderDiscountCents:  Number(r.orderDiscountCents),
        disputedAmountCents: r.disputedAmountCents === null ? null : Number(r.disputedAmountCents),
        refundAmountCents:   r.refundAmountCents === null ? null : Number(r.refundAmountCents),
        // Only a dispute is decomposable through the reconciliation route.
        // A refund belongs to the refund-component workflow.
        canResolveHere: r.sourceKind === 'dispute' && Boolean(r.disputeId),
      }))
    },

    /** Admin decomposition of a partial dispute. Amounts validated in SQL too. */
    async resolveDisputeMerchandise(
      disputeId: string,
      c: { merchandiseCents: number; shippingCents: number; taxCents: number },
      actorEmail: string, notes: string | null,
    ) {
      const rows = await sql`SELECT resolve_dispute_merchandise_by_dispute(
        ${disputeId}::uuid, ${c.merchandiseCents}, ${c.shippingCents},
        ${c.taxCents}, ${actorEmail}, ${notes}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    async payableCommissions(affiliateId: string) {
      const rows = await sql`SELECT * FROM affiliate_payable_commissions(${affiliateId}::uuid)`
      return (rows as any[]).map(r => ({
        commissionId: r.commission_id, orderId: r.order_id, orderNumber: r.order_number,
        commissionCents: Number(r.commission_cents),
        payableCents: Number(r.payable_cents),
        status: r.status,
      }))
    },

    /**
     * Create a DRAFT payout. Amounts are computed in SQL under row locks; the
     * caller supplies only which commissions to include.
     */
    async createPayout(affiliateId: string, commissionIds: string[], actorEmail: string) {
      const rows = await sql`SELECT create_affiliate_payout(
        ${affiliateId}::uuid, ${commissionIds}::uuid[], ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /** Record that money actually moved. This is the cash-flow event. */
    async markPayoutPaid(
      payoutId: string, paidAt: string | null, method: string | null,
      reference: string | null, actorEmail: string,
    ) {
      const rows = await sql`SELECT mark_affiliate_payout_paid(
        ${payoutId}::uuid, ${paidAt}::timestamptz, ${method}, ${reference}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Void a DRAFT payout.
     *
     * A draft reserves payable, so a mistaken draft would otherwise hold a
     * commission hostage until someone edited the database. Voiding releases the
     * reservation immediately, because payable ignores void payouts.
     *
     * The canonical SQL owns the mutation AND its audit row, so this adds none.
     */
    async voidPayout(payoutId: string, reason: string | null, actorEmail: string) {
      const rows = await sql`SELECT void_affiliate_payout(
        ${payoutId}::uuid, ${reason}, ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Current recovery position for a commission.
     *
     * outstanding is DERIVED (cash paid minus what the ledger says was earned,
     * less cash already collected), so it can never disagree with the ledger.
     * `recordedOwed` is the workflow marker; `collected` is real cash received.
     * They are reported separately because treating a pending marker as cash is
     * exactly the confusion this lifecycle exists to prevent.
     */
    async getRecoveryState(commissionId: string) {
      const [row] = (await sql`
        SELECT affiliate_commission_overpaid(${commissionId}::uuid) AS outstanding,
               COALESCE((SELECT SUM(recovered_cents) FROM affiliate_commission_adjustments
                         WHERE commission_id = ${commissionId}::uuid), 0) AS collected,
               COALESCE((SELECT SUM(recovery_amount_cents) FROM affiliate_commission_adjustments
                         WHERE commission_id = ${commissionId}::uuid
                           AND recovery_status = 'pending'), 0) AS "recordedOwed",
               affiliate_commission_payable(${commissionId}::uuid) AS payable
      `) as any[]
      if (!row) return null
      return {
        outstandingCents: Number(row.outstanding),
        collectedCents:   Number(row.collected),
        recordedOwedCents: Number(row.recordedOwed),
        payableCents:     Number(row.payable),
      }
    },

    /**
     * Record that recovery is OWED. This is a workflow marker, not cash.
     *
     * Kept deliberately: the outstanding amount is already derived, but an
     * explicit row records WHEN KVRN decided to pursue the money, who decided,
     * and why — which the derived figure cannot express. It carries
     * adjustment_cents = 0 so it never moves the ledger a second time.
     */
    async recordRecoveryOwed(
      commissionId: string, amountCents: number,
      effectiveAt: string | null, notes: string | null, actorEmail: string,
      idempotencyKey: string,
    ) {
      // effectiveAt is passed twice: once resolved to a timestamptz (the
      // economic date), and once as the raw literal string for idempotency
      // comparison — the resolved column defaults to NOW() when blank, which
      // a retry that also left it blank could never reproduce.
      const rows = await sql`SELECT record_affiliate_payout_recovery(
        ${commissionId}::uuid, ${amountCents}, ${effectiveAt}::timestamptz,
        ${actorEmail}, ${notes}, ${idempotencyKey}, ${effectiveAt}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /** Record recovery CASH actually received back from the affiliate. */
    async collectRecovery(
      commissionId: string, amountCents: number, collectedAt: string | null,
      method: string | null, reference: string | null, actorEmail: string,
      idempotencyKey: string, notes: string | null = null,
    ) {
      const rows = await sql`SELECT collect_affiliate_recovery(
        ${commissionId}::uuid, ${amountCents}, ${collectedAt}::timestamptz,
        ${method}, ${reference}, ${actorEmail}, ${idempotencyKey},
        ${notes}, ${collectedAt}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /** Commissions where cash paid exceeds what the ledger says was earned. */
    async listRecoveries() {
      const rows = await sql`
        SELECT c.id AS "commissionId", o.order_number AS "orderNumber",
               a.code AS "affiliateCode", c.affiliate_id AS "affiliateId",
               affiliate_commission_overpaid(c.id) AS outstanding,
               COALESCE((SELECT SUM(recovered_cents) FROM affiliate_commission_adjustments
                         WHERE commission_id = c.id), 0) AS collected,
               COALESCE((SELECT SUM(recovery_amount_cents) FROM affiliate_commission_adjustments
                         WHERE commission_id = c.id AND recovery_status = 'pending'), 0)
                 AS "recordedOwed"
        FROM affiliate_commissions c
        JOIN orders o ON o.id = c.order_id
        JOIN affiliates a ON a.id = c.affiliate_id
        WHERE affiliate_commission_overpaid(c.id) > 0
           OR EXISTS (SELECT 1 FROM affiliate_commission_adjustments
                      WHERE commission_id = c.id AND recovered_cents > 0)
        ORDER BY o.order_number
      `
      return (rows as any[]).map(r => ({
        ...r,
        outstandingCents:  Number(r.outstanding),
        collectedCents:    Number(r.collected),
        recordedOwedCents: Number(r.recordedOwed),
      }))
    },

    async listPayouts(affiliateId?: string | null) {
      const rows = await sql`
        SELECT p.id, p.payout_number AS "payoutNumber", p.affiliate_id AS "affiliateId",
               a.code AS "affiliateCode", p.amount_cents AS "amountCents",
               p.status, p.paid_at AS "paidAt", p.method, p.reference,
               p.created_at AS "createdAt",
               (SELECT COUNT(*) FROM affiliate_payout_lines l WHERE l.payout_id = p.id)::int
                 AS "lineCount"
        FROM affiliate_payouts p
        JOIN affiliates a ON a.id = p.affiliate_id
        WHERE (${affiliateId ?? null}::uuid IS NULL OR p.affiliate_id = ${affiliateId ?? null}::uuid)
        ORDER BY p.created_at DESC
        LIMIT 200
      `
      return (rows as any[]).map(p => ({
        ...p,
        amountCents: Number(p.amountCents),
        paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
        createdAt: new Date(p.createdAt).toISOString(),
      }))
    },

    /**
     * Period economics.
     *
     * Accrual comes from the append-only ledger keyed on the ECONOMIC date, so a
     * closed period reflects what happened then even if it was quantified later.
     * Cash comes from payouts. The two are never mixed.
     */
    async getPeriodEffect(startISO: string, endISO: string) {
      const [accrual] = (await sql`
        SELECT * FROM affiliate_commission_effect(${startISO}::timestamptz, ${endISO}::timestamptz)
      `) as any[]
      const [cash] = (await sql`
        SELECT * FROM affiliate_payout_cash(${startISO}::timestamptz, ${endISO}::timestamptz)
      `) as any[]
      return {
        accruedCents:       Number(accrual?.accrued_cents ?? 0),
        reversedCents:      Number(accrual?.reversed_cents ?? 0),
        restoredCents:      Number(accrual?.restored_cents ?? 0),
        netCommissionCents: Number(accrual?.net_commission_cents ?? 0),
        adjustmentCount:    Number(accrual?.adjustment_count ?? 0),
        incompleteCount:    Number(accrual?.incomplete_commission_count ?? 0),
        cashPaidCents:      Number(cash?.paid_cents ?? 0),
        payoutCount:        Number(cash?.payout_count ?? 0),
      }
    },
  }
}

export type AffiliatesService = ReturnType<typeof createAffiliatesService>
