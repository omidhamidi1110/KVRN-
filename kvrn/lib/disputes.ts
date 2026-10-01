// lib/disputes.ts — payment disputes / chargebacks
// Server-only.
//
// ── STALENESS, NOT RANK ─────────────────────────────────────────────────────
//
// Stripe can legitimately move a dispute late, including lost -> won. There is
// deliberately NO monotonic status ordering here. An event is applied only when
// Stripe's OWN event timestamp is newer than the last applied one, which rejects
// genuinely out-of-order delivery while permitting every valid later outcome.
//
// ── CASH IS NEVER INFERRED ──────────────────────────────────────────────────
//
// Dispute fees and cash movements are read from Stripe balance transactions and
// stored verbatim. Nothing assumes "the fee is always retained" — that varies by
// region and contract. If Stripe reports it, Stripe is authoritative.
//
// ── NO DOUBLE COUNTING WITH REFUNDS ─────────────────────────────────────────
//
// A merchant may refund and then also be disputed for the same money.
// refund_offset_cents excludes what was already refunded, so only
// net_revenue_impact_cents reduces revenue — counted once, never twice.

import type { NeonQueryFunction } from '@neondatabase/serverless'

/** KVRN's coarse accounting state, derived from Stripe's own status string. */
export type DisputeStatus =
  | 'open' | 'under_review' | 'won' | 'lost' | 'withdrawn' | 'prevented'

export const TERMINAL_STATUSES: DisputeStatus[] =
  ['won', 'lost', 'withdrawn', 'prevented']

/**
 * Statuses that reduce recognised revenue. ONLY a lost dispute does.
 *
 * 'prevented' is deliberately excluded. Stripe's dispute prevention either
 * BLOCKS the dispute (no money moves at all) or auto-RESOLVES it by refunding
 * the customer — and that refund already flows through order_refunds. Counting
 * it here as well would reduce revenue twice for the same dollar.
 */
export const REVENUE_REDUCING_STATUSES: DisputeStatus[] = ['lost']

/**
 * Map Stripe's dispute status onto KVRN's accounting state.
 * Unknown future values fall back to 'under_review' rather than being guessed
 * into a terminal state that would move money.
 */
export function mapStripeDisputeStatus(raw: unknown): DisputeStatus {
  const s = typeof raw === 'string' ? raw.toLowerCase() : ''
  switch (s) {
    case 'warning_needs_response':
    case 'warning_under_review':
    case 'needs_response':
      return 'open'
    case 'under_review':
      return 'under_review'
    case 'won':
    case 'warning_closed':
      return 'won'
    case 'lost':
      return 'lost'
    case 'charge_refunded':
      return 'withdrawn'
    case 'prevented':
      // Stripe API 2025-08-27.basil. The dispute was blocked or auto-resolved
      // before becoming a formal chargeback. Terminal, and not revenue-reducing:
      // an auto-resolution refunds the customer, and that refund is recorded
      // separately by order_refunds.
      return 'prevented'
    default:
      // Never assume a terminal outcome for an unrecognised status.
      return 'under_review'
  }
}

export interface DisputeUpsertInput {
  stripeDisputeId:  string
  stripeChargeId?:  string | null
  paymentIntentId?: string | null
  amountCents:      number
  currency?:        string
  stripeStatus:     string
  stripeEventId:    string
  stripeEventType:  string
  /** Stripe's event creation time — decides staleness, not arrival order. */
  stripeEventCreatedAt: string
  openedAt?:        string | null
  payload?:         unknown
}

export interface DisputeBalanceTxnInput {
  stripeDisputeId:  string
  balanceTransactionId: string
  amountCents:      number
  feeCents:         number
  netCents:         number
  currency?:        string
  reportingCategory?: string | null
  stripeCreatedAt?: string | null
}

export function createDisputesService(sql: NeonQueryFunction<false, false>) {
  return {
    /**
     * Idempotently record a dispute event and apply it if it is not stale.
     *
     * Returns an outcome describing what happened so the webhook can log it
     * without inventing state.
     */
    async upsertFromStripe(input: DisputeUpsertInput) {
      const rows = await sql`SELECT upsert_order_dispute(
        ${input.stripeDisputeId},
        ${input.stripeChargeId ?? null},
        ${input.paymentIntentId ?? null},
        ${input.amountCents}::integer,
        ${input.currency ?? 'usd'},
        ${input.stripeStatus},
        ${mapStripeDisputeStatus(input.stripeStatus)},
        ${input.stripeEventId},
        ${input.stripeEventType},
        ${input.stripeEventCreatedAt}::timestamptz,
        ${input.openedAt ?? null}::timestamptz,
        ${JSON.stringify(input.payload ?? {})}::jsonb
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Record an authoritative Stripe balance transaction for a dispute.
     * The UNIQUE balance transaction id means a redelivered webhook cannot
     * double-count the same real money movement.
     */
    async recordBalanceTransaction(input: DisputeBalanceTxnInput) {
      const rows = await sql`
        INSERT INTO dispute_balance_transactions (
          dispute_id, stripe_balance_transaction_id,
          amount_cents, fee_cents, net_cents, currency,
          reporting_category, stripe_created_at
        )
        SELECT d.id, ${input.balanceTransactionId},
               ${input.amountCents}::integer, ${input.feeCents}::integer,
               ${input.netCents}::integer, ${input.currency ?? 'usd'},
               ${input.reportingCategory ?? null},
               ${input.stripeCreatedAt ?? null}::timestamptz
        FROM order_disputes d
        WHERE d.stripe_dispute_id = ${input.stripeDisputeId}
        ON CONFLICT (stripe_balance_transaction_id) DO NOTHING
        RETURNING id
      `
      return (rows as any[]).length > 0 ? 'recorded' : 'duplicate_or_no_dispute'
    },

    /**
     * Apply the CURRENT authoritative Stripe Dispute object.
     *
     * Used when two distinct events share an event.created timestamp and imply
     * conflicting states. Reading the live object makes the outcome independent
     * of webhook delivery order: whichever tied event arrives second triggers
     * this, and it resolves to the same Stripe truth either way.
     */
    async reconcileFromStripe(input: {
      stripeDisputeId:  string
      stripeStatus:     string
      amountCents:      number
      stripeChargeId?:  string | null
      paymentIntentId?: string | null
      eventCreatedAt?:  string | null
      triggerEventId?:  string | null
    }) {
      const rows = await sql`SELECT reconcile_order_dispute(
        ${input.stripeDisputeId},
        ${input.stripeStatus},
        ${mapStripeDisputeStatus(input.stripeStatus)},
        ${input.amountCents}::integer,
        ${input.stripeChargeId ?? null},
        ${input.paymentIntentId ?? null},
        ${input.eventCreatedAt ?? null}::timestamptz,
        ${input.triggerEventId ?? null}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Dispute revenue effect for a reporting period.
     *
     * Computed from the APPEND-ONLY adjustment ledger keyed on the Stripe event
     * time, never from the current dispute row. That is what makes a historical
     * period reproducible: a June loss stays -$100 in June even after a July
     * reversal restores +$100 in July.
     *
     * Sign convention: negative reduced recognised revenue, positive restored it.
     */
    async getDisputeRevenueEffect(startISO: string, endISO: string) {
      const rows = await sql`
        SELECT COALESCE(SUM(adjustment_cents), 0)::int AS "netAdjustmentCents",
               COALESCE(SUM(adjustment_cents) FILTER (WHERE adjustment_cents < 0), 0)::int
                 AS "reductionsCents",
               COALESCE(SUM(adjustment_cents) FILTER (WHERE adjustment_cents > 0), 0)::int
                 AS "restorationsCents",
               COUNT(*)::int AS "adjustmentCount"
        FROM order_dispute_financial_adjustments
        WHERE effective_at >= ${startISO}::timestamptz
          AND effective_at <  ${endISO}::timestamptz
      `
      const r = (rows as any[])[0] ?? {}
      return {
        netAdjustmentCents: Number(r.netAdjustmentCents ?? 0),
        reductionsCents:    Number(r.reductionsCents ?? 0),
        restorationsCents:  Number(r.restorationsCents ?? 0),
        adjustmentCount:    Number(r.adjustmentCount ?? 0),
      }
    },

    /** Full append-only adjustment history for one dispute. */
    async getDisputeAdjustments(disputeId: string) {
      const rows = await sql`
        SELECT id, adjustment_cents AS "adjustmentCents", effective_at AS "effectiveAt",
               from_status AS "fromStatus", to_status AS "toStatus",
               disputed_amount_cents AS "disputedAmountCents",
               refund_offset_cents AS "refundOffsetCents",
               prior_impact_cents AS "priorImpactCents",
               new_impact_cents AS "newImpactCents",
               adjustment_type AS "adjustmentType", source,
               stripe_event_id AS "stripeEventId", created_at AS "createdAt"
        FROM order_dispute_financial_adjustments
        WHERE dispute_id = ${disputeId}::uuid
        ORDER BY effective_at ASC, created_at ASC
      `
      return (rows as any[]).map(a => ({
        ...a,
        adjustmentCents:     Number(a.adjustmentCents),
        disputedAmountCents: Number(a.disputedAmountCents),
        refundOffsetCents:   Number(a.refundOffsetCents),
        priorImpactCents:    Number(a.priorImpactCents),
        newImpactCents:      Number(a.newImpactCents),
        effectiveAt: new Date(a.effectiveAt).toISOString(),
        createdAt:   new Date(a.createdAt).toISOString(),
      }))
    },

    async listDisputes(limit = 100) {
      const rows = await sql`
        SELECT d.id, d.stripe_dispute_id AS "stripeDisputeId",
               d.order_id AS "orderId", o.order_number AS "orderNumber",
               d.amount_cents AS "amountCents", d.currency,
               d.status, d.stripe_status AS "stripeStatus",
               d.refund_offset_cents AS "refundOffsetCents",
               d.net_revenue_impact_cents AS "netRevenueImpactCents",
               d.opened_at AS "openedAt", d.resolved_at AS "resolvedAt",
               COALESCE(bt.fee_total, 0)::int AS "disputeFeesCents",
               COALESCE(bt.net_total, 0)::int AS "netCashCents",
               COALESCE(bt.txn_count, 0)::int AS "balanceTxnCount"
        FROM order_disputes d
        JOIN orders o ON o.id = d.order_id
        LEFT JOIN LATERAL (
          SELECT SUM(fee_cents) AS fee_total, SUM(net_cents) AS net_total,
                 COUNT(*) AS txn_count
          FROM dispute_balance_transactions b WHERE b.dispute_id = d.id
        ) bt ON TRUE
        ORDER BY d.opened_at DESC NULLS LAST, d.created_at DESC
        LIMIT ${limit}
      `
      return (rows as any[]).map(d => ({
        ...d,
        amountCents:           Number(d.amountCents),
        refundOffsetCents:     Number(d.refundOffsetCents),
        netRevenueImpactCents: Number(d.netRevenueImpactCents),
        disputeFeesCents:      Number(d.disputeFeesCents),
        netCashCents:          Number(d.netCashCents),
        balanceTxnCount:       Number(d.balanceTxnCount),
        openedAt:   d.openedAt   ? new Date(d.openedAt).toISOString()   : null,
        resolvedAt: d.resolvedAt ? new Date(d.resolvedAt).toISOString() : null,
      }))
    },

    async getDisputeEvents(disputeId: string) {
      const rows = await sql`
        SELECT id, stripe_event_id AS "stripeEventId",
               stripe_event_type AS "stripeEventType",
               stripe_event_created_at AS "stripeEventCreatedAt",
               from_status AS "fromStatus", to_status AS "toStatus",
               stripe_status AS "stripeStatus", applied, skipped_reason AS "skippedReason",
               created_at AS "createdAt"
        FROM order_dispute_events
        WHERE dispute_id = ${disputeId}::uuid
        ORDER BY stripe_event_created_at DESC
      `
      return (rows as any[]).map(e => ({
        ...e,
        stripeEventCreatedAt: new Date(e.stripeEventCreatedAt).toISOString(),
        createdAt: new Date(e.createdAt).toISOString(),
      }))
    },

    async getBalanceTransactions(disputeId: string) {
      const rows = await sql`
        SELECT id, stripe_balance_transaction_id AS "balanceTransactionId",
               amount_cents AS "amountCents", fee_cents AS "feeCents",
               net_cents AS "netCents", currency,
               reporting_category AS "reportingCategory",
               stripe_created_at AS "stripeCreatedAt"
        FROM dispute_balance_transactions
        WHERE dispute_id = ${disputeId}::uuid
        ORDER BY stripe_created_at DESC NULLS LAST
      `
      return (rows as any[]).map(b => ({
        ...b,
        amountCents: Number(b.amountCents),
        feeCents:    Number(b.feeCents),
        netCents:    Number(b.netCents),
        stripeCreatedAt: b.stripeCreatedAt ? new Date(b.stripeCreatedAt).toISOString() : null,
      }))
    },
  }
}

export type DisputesService = ReturnType<typeof createDisputesService>
