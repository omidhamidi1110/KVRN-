// lib/financials.ts — financial data access layer
// Server-only. Loads raw rows and hands them to lib/financial-calculator.ts.
// NO financial arithmetic lives here: this file's only job is faithful retrieval.
//
// ── REPORTING PERIOD SEMANTICS ───────────────────────────────────────────────
// Revenue is recognised on orders.paid_at. Only orders with paid_at IS NOT NULL are
// ever counted, which structurally excludes abandoned reservations, unpaid sessions
// and failed checkouts.
//
// A fully refunded order keeps payment_status='refunded' but retains its paid_at, so
// it still appears as a sale in its original period with the refund subtracted —
// history is never rewritten.
//
// Ranges are half-open [start, end) in UTC. The caller supplies ISO timestamps.
// UTC is used deliberately and consistently so a figure never changes based on who
// is viewing it or from where.

import type { NeonQueryFunction } from '@neondatabase/serverless'
import {
  autoGranularity,
  buildBuckets,
  bucketIndexFor,
  allocateAcrossBuckets,
  type Granularity,
} from './chart-math'
import {
  computeOrderEconomics,
  computePeriodEconomics,
  applyIntegrityGate,
  knownSoFarContribution,
  allocateDiscountToLines,
  recognizeExpenseRowsExact,
  recognizeAdSpendRowsExact,
  type ExpenseTxnRow,
  type AdSpendRow,
  type OrderEconomics,
  type PeriodEconomics,
  type OrderFinancialInputs,
  type IntegrityVerdict,
} from './financial-calculator'
import { mapPeriodIntegrity, createFinancialIntegrityService, type PeriodIntegrity, type OrderIntegrity } from './financial-integrity'
import { canonicalOrderContribution, type CanonicalOrderContribution } from './financial-presentation'

export interface DateRange {
  /** Inclusive ISO timestamp. */
  start: string
  /** Exclusive ISO timestamp. */
  end:   string
}

export interface OrderFinancialRow extends OrderFinancialInputs {
  orderId:     string
  orderNumber: string
  paidAt:      string | null
  paymentStatus: string
  customerEmail: string | null
}

/**
 * One order as the Admin financial API presents it (REV2).
 *   economics  RAW calculator output: known-so-far DIAGNOSTICS. Not authoritative: it cannot see
 *              reconciliation contradictions, so it may hold a number for an EXCEPTION order.
 *   integrity  the order's derived state from the canonical scan (RECONCILED/INCOMPLETE/EXCEPTION)
 *   canonical  the AUTHORITATIVE contribution: exact only when integrity is RECONCILED and every
 *              calculator input is known; otherwise null with Unknown / Invalid.
 */
export interface OrderFinancialView extends OrderEconomicsRow {
  integrity: OrderIntegrity
  canonical: CanonicalOrderContribution
}

export interface OrderEconomicsRow {
  orderId:       string
  orderNumber:   string
  paidAt:        string | null
  paymentStatus: string
  customerEmail: string | null
  economics:     OrderEconomics
  /**
   * Reconciliation state of THIS order (the order and its refunds, returns, exchanges,
   * disputes, commission, COGS/FIFO, shipping and fee). Present on period reports; an
   * order's exact contribution may only be shown as exact when this is RECONCILED.
   */
  integrityState?: IntegrityVerdict
}

/**
 * Fetch the financial inputs for paid orders in a window.
 *
 * COGS is deliberately NULL unless EVERY line on the order has a cost snapshot:
 * a partially-costed order would otherwise understate cost and overstate profit.
 * That is enforced by `bool_and(line_cogs_cents IS NOT NULL)`.
 */
function financialSelect() {
  return `
    SELECT
      o.id                                AS "orderId",
      o.order_number                      AS "orderNumber",
      o.paid_at                           AS "paidAt",
      o.payment_status                    AS "paymentStatus",
      o.customer_email                    AS "customerEmail",
      o.subtotal_cents                    AS "subtotalCents",
      o.discount_cents                    AS "merchandiseDiscountCents",
      o.shipping_cents                    AS "shippingRevenueCents",
      o.shipping_quoted_cents             AS "shippingQuotedCents",
      o.shipping_discount_cents           AS "shippingPromoDiscountCents",
      o.shipping_auto_free_discount_cents AS "shippingAutoFreeDiscountCents",
      o.tax_cents                         AS "taxCents",
      o.stripe_fee_cents                  AS "stripeFeeCents",
      ci."cogsCents",
      sc."shippingCostCents",
      COALESCE(rf."refundCents", 0)       AS "refundCents",
      rf."refundRevenueCents",
      rf."refundedFeeCents",
      dp."disputeLossCents",
      dp."disputeFeeCents",
      af."affiliateCommissionCents",
      rt."returnCogsCreditCents",
      rl."returnLabelCostCents",
      ex."exchangeCogsCents",
      ex."exchangeShippingCostCents",
      ex."exchangeRevenueCents"
    FROM orders o
    -- COGS: only known when every single line carries a snapshot
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_and(oi.line_cogs_cents IS NOT NULL)
                  THEN SUM(oi.line_cogs_cents)::int
                  ELSE NULL END AS "cogsCents"
      FROM order_items oi WHERE oi.order_id = o.id
    ) ci ON TRUE
    -- Merchant carrier cost: ONE canonical definition shared with the integrity scan
    -- (fi_order_shipping, migration 021). NULL = unknown: no shipment yet, any outbound
    -- shipment without a cost, or any checkout-quote ESTIMATE. Never a partial sum.
    LEFT JOIN LATERAL (
      SELECT cost_cents AS "shippingCostCents" FROM fi_order_shipping(o.id)
    ) sc ON TRUE
    -- Only succeeded refunds count.
    --   refundCents         total customer CASH refunded (cash-flow view)
    --   refundRevenueCents  the part that reverses REVENUE: merchandise + shipping. Refunded
    --                       sales tax reverses the tax liability, never revenue. When the
    --                       decomposition is unresolved: a tax-free order's whole refund is
    --                       revenue; an order WITH tax is NULL (the split is not guessed).
    --   refundedFeeCents    processing fee Stripe returned (migration 015: NULL = UNKNOWN):
    --                       no refund -> 0; ANY refund fee unknown -> NULL (never a partial
    --                       sum); else the exact sum.
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(r.amount_cents),0)::int AS "refundCents",
        CASE WHEN COUNT(*) = 0 THEN 0
             WHEN bool_and(r.component_breakdown_status = 'resolved'
                           AND r.merchandise_refund_cents IS NOT NULL
                           AND r.shipping_refund_cents IS NOT NULL)
                  THEN SUM(r.merchandise_refund_cents + r.shipping_refund_cents)::int
             WHEN o.tax_cents = 0 THEN SUM(r.amount_cents)::int
             ELSE NULL END AS "refundRevenueCents",
        CASE WHEN COUNT(*) = 0 THEN 0
             WHEN bool_or(r.fee_refunded_cents IS NULL) THEN NULL
             ELSE SUM(r.fee_refunded_cents)::int END AS "refundedFeeCents"
      FROM order_refunds r
      WHERE r.order_id = o.id AND r.status = 'succeeded'
    ) rf ON TRUE
    -- ── Order-attributable effects (Financial Integrity batch) ──────────────
    -- Every one of these is NULL when the effect exists but its amount is not yet
    -- known, so the order's profit becomes unknown instead of silently higher.
    --
    -- Disputes: recognised revenue loss, and Stripe's dispute fees. A dispute in a
    -- state that moves funds but has no balance transaction yet has an UNKNOWN fee.
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(d.net_revenue_impact_cents),0)::int AS "disputeLossCents",
             CASE
               WHEN COUNT(*) = 0 THEN 0
               WHEN bool_or(d.status IN ('open','under_review','lost','won')
                            AND NOT EXISTS (SELECT 1 FROM dispute_balance_transactions b
                                            WHERE b.dispute_id = d.id)) THEN NULL
               ELSE COALESCE((SELECT SUM(b.fee_cents) FROM dispute_balance_transactions b
                              JOIN order_disputes d2 ON d2.id = b.dispute_id
                              WHERE d2.order_id = o.id),0)::int
             END AS "disputeFeeCents"
      FROM order_disputes d WHERE d.order_id = o.id
    ) dp ON TRUE
    -- Affiliate commission EXPENSE = the append-only ledger net. Payout CASH is separate.
    --   no attribution and no commission row          -> 0 (genuinely no obligation)
    --   attribution but NO commission row             -> NULL (the obligation exists, its
    --                                                    amount does not: never a $0 expense)
    --   commission flagged incomplete, or a refund /
    --   dispute that affects its base is unresolved   -> NULL
    --   otherwise                                     -> the exact ledger amount (which is a
    --                                                    legitimate 0 when it nets to zero)
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN COUNT(c.id) = 0
                    THEN CASE WHEN EXISTS (SELECT 1 FROM order_affiliate_attributions a
                                           WHERE a.order_id = o.id)
                              THEN NULL ELSE 0 END
               WHEN bool_or(c.incomplete) THEN NULL
               WHEN bool_or(EXISTS (SELECT 1 FROM affiliate_unresolved_sources(c.id))) THEN NULL
               ELSE SUM((SELECT COALESCE(SUM(a.adjustment_cents),0)
                         FROM affiliate_commission_adjustments a
                         WHERE a.commission_id = c.id))::int
             END AS "affiliateCommissionCents"
      FROM affiliate_commissions c WHERE c.order_id = o.id
    ) af ON TRUE
    -- Sellable returns put units (and their cost) back into inventory: a COGS credit.
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_or(ri.restocked AND ri.cogs_credit_cents IS NULL) THEN NULL
                  ELSE COALESCE(SUM(ri.cogs_credit_cents),0)::int END AS "returnCogsCreditCents"
      FROM order_returns rtn
      JOIN order_return_items ri ON ri.return_id = rtn.id
      WHERE rtn.order_id = o.id AND rtn.status <> 'cancelled'
    ) rt ON TRUE
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_or(rtn.return_shipping_paid_by = 'kvrn'
                               AND rtn.status IN ('received','completed')
                               AND rtn.return_label_cost_cents IS NULL) THEN NULL
                  ELSE COALESCE(SUM(rtn.return_label_cost_cents),0)::int END AS "returnLabelCostCents"
      FROM order_returns rtn
      WHERE rtn.order_id = o.id AND rtn.status <> 'cancelled'
    ) rl ON TRUE
    -- Exchanges: replacement COGS and carrier cost (only once shipped), plus any
    -- price difference actually collected (net of tax, which is never revenue).
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN bool_or(e.status IN ('shipped','completed')
                          AND EXISTS (SELECT 1 FROM order_exchange_items i
                                      WHERE i.exchange_id = e.id AND i.line_cogs_cents IS NULL)) THEN NULL
             ELSE COALESCE(SUM((SELECT COALESCE(SUM(i.line_cogs_cents),0)
                                FROM order_exchange_items i WHERE i.exchange_id = e.id))
                           FILTER (WHERE e.status IN ('shipped','completed')),0)::int
        END AS "exchangeCogsCents",
        CASE WHEN bool_or(e.status IN ('shipped','completed')
                          AND e.replacement_shipping_cost_cents IS NULL) THEN NULL
             ELSE COALESCE(SUM(e.replacement_shipping_cost_cents),0)::int
        END AS "exchangeShippingCostCents",
        COALESCE(SUM(e.price_difference_cents - e.price_difference_tax_cents)
                 FILTER (WHERE e.price_difference_status = 'succeeded'
                           AND e.price_difference_cents > 0),0)::int AS "exchangeRevenueCents"
      FROM order_exchanges e WHERE e.order_id = o.id AND e.status <> 'cancelled'
    ) ex ON TRUE
  `
}

function toInputs(r: any): OrderFinancialRow {
  const num = (v: any) => Number(v ?? 0)
  const nullable = (v: any) => (v === null || v === undefined ? null : Number(v))
  return {
    orderId:       r.orderId,
    orderNumber:   r.orderNumber,
    paidAt:        r.paidAt ? new Date(r.paidAt).toISOString() : null,
    paymentStatus: r.paymentStatus,
    customerEmail: r.customerEmail ?? null,

    subtotalCents:                 num(r.subtotalCents),
    merchandiseDiscountCents:      num(r.merchandiseDiscountCents),
    shippingRevenueCents:          num(r.shippingRevenueCents),
    shippingQuotedCents:           nullable(r.shippingQuotedCents),
    shippingPromoDiscountCents:    num(r.shippingPromoDiscountCents),
    shippingAutoFreeDiscountCents: num(r.shippingAutoFreeDiscountCents),
    taxCents:                      num(r.taxCents),
    cogsCents:                     nullable(r.cogsCents),
    shippingCostCents:             nullable(r.shippingCostCents),
    stripeFeeCents:                nullable(r.stripeFeeCents),
    refundCents:                   num(r.refundCents),
    refundRevenueCents:            nullable(r.refundRevenueCents),
    refundedFeeCents:              nullable(r.refundedFeeCents),
    disputeLossCents:              num(r.disputeLossCents),
    disputeFeeCents:               nullable(r.disputeFeeCents),
    affiliateCommissionCents:      nullable(r.affiliateCommissionCents),
    returnCogsCreditCents:         nullable(r.returnCogsCreditCents),
    returnLabelCostCents:          nullable(r.returnLabelCostCents),
    exchangeCogsCents:             nullable(r.exchangeCogsCents),
    exchangeShippingCostCents:     nullable(r.exchangeShippingCostCents),
    exchangeRevenueCents:          num(r.exchangeRevenueCents),
  }
}

/** Convert a half-open [start, end) ISO range into inclusive yyyy-mm-dd bounds. */
function toDateBounds(range: DateRange): { startDate: string; endDate: string } {
  return {
    startDate: range.start.slice(0, 10),
    endDate:   new Date(Date.parse(range.end) - 1).toISOString().slice(0, 10),
  }
}

/**
 * Expense transactions that could touch [startDate, endDate].
 * Fetched once and reused across every chart bucket so the time series costs one
 * query rather than one per bucket.
 */
async function fetchExpenseRows(
  sql: NeonQueryFunction<false, false>,
  startDate: string,
  endDate: string,
): Promise<ExpenseTxnRow[]> {
  const rows = await sql.query(
    `SELECT amount_cents, category, paid_at, period_start, period_end
     FROM expense_transactions
     WHERE paid_at IS NOT NULL
       AND voided_at IS NULL
       AND (
         (period_start IS NULL AND paid_at >= $1 AND paid_at <= $2)
         OR (period_start IS NOT NULL AND period_start <= $2
             AND COALESCE(period_end, period_start) >= $1)
       )`,
    [startDate, endDate],
  )
  return (rows as any[]).map(r => ({
    amountCents: Number(r.amount_cents),
    category:    String(r.category),
    paidAt:      r.paid_at      ? String(r.paid_at).slice(0, 10)      : null,
    periodStart: r.period_start ? String(r.period_start).slice(0, 10) : null,
    periodEnd:   r.period_end   ? String(r.period_end).slice(0, 10)   : null,
  }))
}

/** Ad spend rows overlapping [startDate, endDate]. Fetched once, reused per bucket. */
async function fetchAdSpendRows(
  sql: NeonQueryFunction<false, false>,
  startDate: string,
  endDate: string,
): Promise<AdSpendRow[]> {
  const rows = await sql.query(
    `SELECT spend_cents, period_start, period_end
     FROM ad_spend
     WHERE voided_at IS NULL AND period_start <= $1 AND period_end >= $2`,
    [endDate, startDate],
  )
  return (rows as any[]).map(r => ({
    spendCents:  Number(r.spend_cents),
    periodStart: String(r.period_start).slice(0, 10),
    periodEnd:   String(r.period_end).slice(0, 10),
  }))
}

export function createFinancialService(sql: NeonQueryFunction<false, false>) {
  return {
    /** Paid orders in [start, end) with full economics computed. */
    async getOrderEconomicsInRange(range: DateRange): Promise<OrderEconomicsRow[]> {
      const rows = await sql.query(
        `${financialSelect()}
         WHERE o.paid_at IS NOT NULL AND o.paid_at >= $1 AND o.paid_at < $2
         ORDER BY o.paid_at DESC`,
        [range.start, range.end],
      )
      return (rows as any[]).map(r => {
        const inputs = toInputs(r)
        return {
          orderId:       inputs.orderId,
          orderNumber:   inputs.orderNumber,
          paidAt:        inputs.paidAt,
          paymentStatus: inputs.paymentStatus,
          customerEmail: inputs.customerEmail,
          economics:     computeOrderEconomics(inputs),
        }
      })
    },

    /** Economics for one order, by id. */
    async getOrderEconomics(orderId: string): Promise<OrderEconomicsRow | null> {
      const rows = await sql.query(`${financialSelect()} WHERE o.id = $1 LIMIT 1`, [orderId])
      const r = (rows as any[])[0]
      if (!r) return null
      const inputs = toInputs(r)
      return {
        orderId:       inputs.orderId,
        orderNumber:   inputs.orderNumber,
        paidAt:        inputs.paidAt,
        paymentStatus: inputs.paymentStatus,
        customerEmail: inputs.customerEmail,
        economics:     computeOrderEconomics(inputs),
      }
    },

    /** Economics + derived integrity + the authoritative (gated) contribution for one order. */
    async getOrderFinancialView(orderId: string): Promise<OrderFinancialView | null> {
      const row = await this.getOrderEconomics(orderId)
      if (!row) return null
      const integrity = await createFinancialIntegrityService(sql).getOrderIntegrity(orderId)
      const canonical = canonicalOrderContribution({
        integrityState: integrity.state,
        contributionProfitCents: row.economics.contributionProfitCents,
        contributionMarginPct: row.economics.contributionMarginPct,
      })
      return { ...row, integrity, canonical }
    },

    /**
     * RECOGNIZED operating expense for a window, split by development vs the rest.
     *
     * RECOGNITION BASIS — read this before comparing to the Infrastructure page:
     *
     *   Source      real expense_transactions ONLY. Never expense_definitions: an
     *               expected obligation is not money spent, and counting it would
     *               reduce profit by an invoice that may never arrive.
     *
     *   Timing      a transaction WITHOUT a service period is recognised on paid_at.
     *               A transaction WITH a service period is apportioned across that
     *               period by overlapping days.
     *
     *   Consequence a $40 annual renewal paid in August recognises ~$3.33 into the
     *               August P&L, while the Infrastructure page correctly reports
     *               ACTUAL PAID of $40 for August. These are two different, both
     *               correct, measures — cash out versus period cost. The underlying
     *               annual transaction is never split into fake monthly rows.
     */
    async getRecognizedOperatingExpensesCents(range: DateRange): Promise<{
      operating: number
      development: number
    }> {
      const { startDate, endDate } = toDateBounds(range)
      const rows = await fetchExpenseRows(sql, startDate, endDate)
      // Canonical primitive, shared with the per-bucket chart path.
      const exact = recognizeExpenseRowsExact(rows, startDate, endDate)
      return {
        operating:   Math.round(exact.operating),
        development: Math.round(exact.development),
      }
    },

    /**
     * FORECAST totals from the latest usage snapshot per provider.
     *
     * These are estimates, never bills. They are returned so the dashboard can show
     * them beside actuals, and are never subtracted from realised profit.
     */
    async getForecastOperatingExpensesCents(): Promise<{
      estimatedAccrued: number
      projectedMonthEnd: number
    }> {
      const rows = await sql`
        SELECT DISTINCT ON (provider, metric_name)
               estimated_accrued_cents   AS "estimatedAccruedCents",
               projected_month_end_cents AS "projectedMonthEndCents"
        FROM provider_usage_snapshots
        ORDER BY provider, metric_name, captured_at DESC
      `
      let estimatedAccrued = 0
      let projectedMonthEnd = 0
      for (const r of rows as any[]) {
        if (r.estimatedAccruedCents  !== null) estimatedAccrued  += Number(r.estimatedAccruedCents)
        if (r.projectedMonthEndCents !== null) projectedMonthEnd += Number(r.projectedMonthEndCents)
      }
      return { estimatedAccrued, projectedMonthEnd }
    },

    /**
     * Advertising spend attributable to a window.
     * A campaign whose period straddles the window boundary is pro-rated by the
     * number of overlapping days, so a 30-day campaign viewed through a 7-day
     * window contributes 7/30 of its spend rather than all or nothing.
     */
    async getAdvertisingSpendCents(range: DateRange): Promise<number> {
      const { startDate, endDate } = toDateBounds(range)
      const rows = await fetchAdSpendRows(sql, startDate, endDate)
      // Canonical primitive, shared with the per-bucket chart path.
      return Math.round(recognizeAdSpendRowsExact(rows, startDate, endDate))
    },

    /**
     * Inventory written off or given away in a window. These units were bought and
     * capitalised earlier; the loss is recognised when they leave stock, on the
     * write-off's own timestamp (it belongs to no order). `unknown` is true when any
     * of the units had no known cost: the sum is then a floor, never "complete".
     */
    async getWriteOffCostInRange(range: DateRange): Promise<{ costCents: number; unknown: boolean }> {
      const rows = await sql.query(
        `SELECT COALESCE(SUM(total_cost_cents),0)::int AS cost,
                COALESCE(bool_or(total_cost_cents IS NULL OR unknown_cost_quantity > 0), FALSE) AS unknown
         FROM inventory_write_offs
         WHERE created_at >= $1 AND created_at < $2`,
        [range.start, range.end],
      )
      const r = (rows as any[])[0] ?? {}
      return { costCents: Number(r.cost ?? 0), unknown: Boolean(r.unknown) }
    },

    /**
     * RECORDED CASH MOVEMENT for a window. THIS IS NOT PROFIT and is deliberately
     * never combined with it: paying a supplier is capitalised inventory (not an
     * expense), an affiliate payout settles a commission already expensed, and an
     * annual bill is paid once but recognised over its service period.
     *
     * Only cash events that carry their own date are included. Stripe payouts,
     * carrier label payments and ad-platform billing are not dated cash facts in the
     * database, so they are listed in `notIncluded` instead of being guessed.
     */
    async getRecordedCashMovement(range: DateRange): Promise<{
      customerReceiptsCents: number
      refundsPaidCents: number
      inventoryPurchasePaymentsCents: number
      affiliatePayoutsPaidCents: number
      expensePaymentsCents: number
      recordedNetCashMovementCents: number
      notIncluded: string[]
      isComplete: false
      label: string
    }> {
      const { startDate, endDate } = toDateBounds(range)
      const [rec, ref, inv, exp, aff] = await Promise.all([
        sql.query(`SELECT COALESCE(SUM(total_cents),0)::bigint AS v FROM orders
                   WHERE paid_at IS NOT NULL AND paid_at >= $1 AND paid_at < $2`, [range.start, range.end]),
        sql.query(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM order_refunds
                   WHERE status = 'succeeded' AND refunded_at >= $1 AND refunded_at < $2`, [range.start, range.end]),
        sql.query(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM inventory_purchase_payments
                   WHERE paid_at >= $1 AND paid_at <= $2`, [startDate, endDate]),
        sql.query(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM expense_transactions
                   WHERE voided_at IS NULL AND paid_at >= $1 AND paid_at <= $2`, [startDate, endDate]),
        sql.query(`SELECT paid_cents AS v FROM affiliate_payout_cash($1::timestamptz, $2::timestamptz)`,
                  [range.start, range.end]),
      ])
      const n = (x: any) => Number((x as any[])[0]?.v ?? 0)
      const customerReceiptsCents = n(rec)
      const refundsPaidCents = n(ref)
      const inventoryPurchasePaymentsCents = n(inv)
      const expensePaymentsCents = n(exp)
      const affiliatePayoutsPaidCents = n(aff)
      return {
        customerReceiptsCents,
        refundsPaidCents,
        inventoryPurchasePaymentsCents,
        affiliatePayoutsPaidCents,
        expensePaymentsCents,
        recordedNetCashMovementCents:
          customerReceiptsCents - refundsPaidCents - inventoryPurchasePaymentsCents
          - affiliatePayoutsPaidCents - expensePaymentsCents,
        notIncluded: [
          'Stripe processing fees and payout timing',
          'Carrier label payments',
          'Advertising platform billing',
          'Dispute withdrawals and reinstatements',
        ],
        isComplete: false,
        label: 'Recorded cash movement — not profit',
      }
    },

    /**
     * Reconciliation state RELEVANT to a period (see financial_integrity_period_state):
     * the order cohort paid in the window plus the expenses, ad spend and write-offs
     * actually included in it. Unrelated history outside the window is not consulted.
     */
    async getPeriodIntegrity(range: DateRange): Promise<PeriodIntegrity> {
      const rows = await sql.query(
        `SELECT financial_integrity_period_state($1::timestamptz, $2::timestamptz) AS s`,
        [range.start, range.end])
      return mapPeriodIntegrity((rows as any[])[0]?.s, new Date().toISOString())
    },

    /**
     * Full period report: order economics + operating expenses + ad spend, GATED by the
     * period's reconciliation state. `period.canonical*` are exact numbers only when
     * `integrity.state` is RECONCILED; INCOMPLETE -> null (unknown), EXCEPTION -> null
     * (invalid). The known-so-far figures stay available as non-authoritative diagnostics.
     */
    async getPeriodReport(range: DateRange): Promise<{
      period:  PeriodEconomics
      orders:  OrderEconomicsRow[]
      integrity: PeriodIntegrity
    }> {
      const [orders, recognized, advertisingSpendCents, forecast, writeOffs, integrity] = await Promise.all([
        this.getOrderEconomicsInRange(range),
        this.getRecognizedOperatingExpensesCents(range),
        this.getAdvertisingSpendCents(range),
        this.getForecastOperatingExpensesCents(),
        this.getWriteOffCostInRange(range),
        this.getPeriodIntegrity(range),
      ])

      const period = applyIntegrityGate(
        computePeriodEconomics({
          orders: orders.map(o => o.economics),
          // RECOGNIZED from real transactions only — definitions and forecasts
          // are excluded by construction
          recognizedOperatingExpensesCents:   recognized.operating,
          recognizedDevelopmentExpensesCents: recognized.development,
          advertisingSpendCents,
          writeOffCostCents:   writeOffs.costCents,
          writeOffCostUnknown: writeOffs.unknown,
          // FORECASTS — carried for display, never subtracted from realised profit
          estimatedAccruedOperatingExpensesCents: forecast.estimatedAccrued,
          projectedOperatingExpensesCents:        forecast.projectedMonthEnd,
        }),
        integrity.state,
      )

      return {
        period,
        orders: orders.map(o => ({ ...o, integrityState: integrity.orderStates[o.orderId] ?? 'RECONCILED' })),
        integrity,
      }
    },

    /**
     * Financial time series for the Overview chart.
     *
     * RECONCILIATION GUARANTEE: buckets are contiguous and non-overlapping, and
     * order-derived series are summed from the SAME computeOrderEconomics results
     * the summary cards use.
     *
     * Operating expense and advertising are recognised per bucket using the SAME
     * canonical primitives as the period totals, driven by each cost's own dates.
     * They are NOT weighted by revenue: a cost must not appear to move into a
     * different day merely because that day sold more. The exact per-bucket
     * amounts then act as weights for a largest-remainder apportionment of the
     * rounded period total, which keeps the sum cent-exact.
     *
     * The consequence is that adding up any series across every bucket reproduces
     * the headline figure exactly — the chart can never quietly disagree with the
     * cards above it. This is asserted in the test suite.
     */
    async getFinancialTimeSeries(range: DateRange, granularity?: Granularity): Promise<{
      granularity: Granularity
      buckets: Array<{
        label: string
        start: string
        end: string
        orderCount: number
        netRevenueCents: number
        grossMerchandiseCents: number
        cogsCents: number
        shippingCostCents: number
        stripeFeeCents: number
        operatingExpenseCents: number
        developmentExpenseCents: number
        advertisingCents: number
        contributionProfitCents: number
        /** Inventory written off in the bucket (known part). */
        writeOffCostCents: number
        realizedProfitCents: number
        /** True when anything in the bucket is unknown: known costs are floors and known-so-far profit is an upper bound. */
        isPartial: boolean
        // ── Additive, display-supporting fields (ADVANCED CHARTS) ───────────────
        // None of these changes an existing figure above. They let a chart say
        // honestly WHICH figures are floors, instead of drawing a floor as the truth.
        /** Customer-charged merchandise + shipping, ex-tax, before refunds (the AOV numerator). */
        grossCustomerRevenueCents: number
        /** Refunds against orders PAID in this bucket (cohort basis, same as the cards). */
        refundCents: number
        /** Same definition as the period card: gross customer revenue / paid orders; null with no orders. */
        averageOrderValueCents: number | null
        /** Paid orders in the bucket whose COGS / shipping label cost / Stripe fee is still unknown. */
        ordersMissingCogs: number
        ordersMissingShippingCost: number
        ordersMissingStripeFee: number
        /** Paid orders with ANY unknown cost component (the cards' ordersWithUnknownCosts). */
        ordersWithUnknownCosts: number
        /** Inventory write-offs in the bucket whose cost is not fully known. */
        unknownWriteOffs: number
      }>
    }> {
      const g = granularity ?? autoGranularity(range.start, range.end)
      const buckets = buildBuckets(range.start, range.end, g)
      if (buckets.length === 0) return { granularity: g, buckets: [] }

      const { startDate, endDate } = toDateBounds(range)

      const [orders, expenseRows, adRows, writeOffRows] = await Promise.all([
        this.getOrderEconomicsInRange(range),
        // Fetched once for the whole window, then recognised per bucket below.
        fetchExpenseRows(sql, startDate, endDate),
        fetchAdSpendRows(sql, startDate, endDate),
        sql.query(
          `SELECT created_at, COALESCE(total_cost_cents,0)::int AS cost,
                  (total_cost_cents IS NULL OR unknown_cost_quantity > 0) AS unknown
           FROM inventory_write_offs WHERE created_at >= $1 AND created_at < $2`,
          [range.start, range.end]),
      ])

      // Bucket each order by the instant revenue was recognised (paid_at).
      const perBucket = buckets.map(() => ({
        orderCount: 0, netRevenueCents: 0, grossMerchandiseCents: 0,
        cogsCents: 0, shippingCostCents: 0, stripeFeeCents: 0,
        contributionProfitCents: 0,
        writeOffCostCents: 0,
        isPartial: false,
        grossCustomerRevenueCents: 0, refundCents: 0,
        ordersMissingCogs: 0, ordersMissingShippingCost: 0, ordersMissingStripeFee: 0,
        ordersWithUnknownCosts: 0, unknownWriteOffs: 0,
      }))

      for (const row of orders) {
        if (!row.paidAt) continue
        const i = bucketIndexFor(buckets, row.paidAt)
        if (i < 0) continue
        const e = row.economics
        const b = perBucket[i]
        b.orderCount            += 1
        b.netRevenueCents       += e.netRevenueCents
        b.grossMerchandiseCents += e.grossMerchandiseCents
        // Unknown costs contribute 0 to the bar rather than voiding the bucket;
        // the summary cards carry the "partial" warning for the same window.
        b.cogsCents             += e.cogsCents ?? 0
        b.shippingCostCents     += e.shippingCostCents ?? 0
        b.stripeFeeCents        += e.netStripeFeeCents ?? 0
        // Known-so-far, the SAME algebra the period total uses, so the buckets
        // add up to the headline instead of dropping a whole order when one cost
        // is unknown.
        b.contributionProfitCents += knownSoFarContribution(e)
        if (e.reconciliation.missing.length > 0) b.isPartial = true
        // Display support: same inputs and same null tests the period card uses
        // (countMissing / ordersWithUnknownCosts in computePeriodEconomics).
        b.grossCustomerRevenueCents += e.grossCustomerRevenueCents
        b.refundCents               += e.refundCents
        if (e.cogsCents === null)         b.ordersMissingCogs         += 1
        if (e.shippingCostCents === null) b.ordersMissingShippingCost += 1
        if (e.stripeFeeCents === null)    b.ordersMissingStripeFee    += 1
        if (e.reconciliation.missing.length > 0) b.ordersWithUnknownCosts += 1
      }

      // Write-offs belong to no order: bucket them by their own timestamp.
      for (const w of writeOffRows as any[]) {
        const i = bucketIndexFor(buckets, new Date(w.created_at).toISOString())
        if (i < 0) continue
        perBucket[i].writeOffCostCents += Number(w.cost)
        if (w.unknown) { perBucket[i].isPartial = true; perBucket[i].unknownWriteOffs += 1 }
      }

      // ── Period costs are recognised by their OWN dates, never by revenue ──
      //
      // Each bucket is run through the same canonical recognition primitives the
      // period totals use, with that bucket's real date bounds. A cost therefore
      // lands in the period it economically belongs to and cannot drift into a
      // different day merely because more revenue happened there.
      //
      // The primitives return unrounded cents. Rounding each bucket then summing
      // would drift from the period figure, so the exact per-bucket amounts are
      // used as WEIGHTS and the already-rounded period total is apportioned with
      // largest-remainder. That is timing-faithful and cent-exact simultaneously.
      const bucketBounds = buckets.map(bk => toDateBounds({ start: bk.start, end: bk.end }))

      const opexExact = bucketBounds.map(b =>
        recognizeExpenseRowsExact(expenseRows, b.startDate, b.endDate))
      const adsExact = bucketBounds.map(b =>
        recognizeAdSpendRowsExact(adRows, b.startDate, b.endDate))

      const periodOperating   = Math.round(
        recognizeExpenseRowsExact(expenseRows, startDate, endDate).operating)
      const periodDevelopment = Math.round(
        recognizeExpenseRowsExact(expenseRows, startDate, endDate).development)
      const periodAds         = Math.round(
        recognizeAdSpendRowsExact(adRows, startDate, endDate))

      const operatingPerBucket   = allocateAcrossBuckets(
        periodOperating, opexExact.map(e => e.operating))
      const developmentPerBucket = allocateAcrossBuckets(
        periodDevelopment, opexExact.map(e => e.development))
      const adsPerBucket         = allocateAcrossBuckets(periodAds, adsExact)

      // Development stays distinguishable, matching the P&L semantics, but both
      // are surfaced as one chart line to keep the series list readable.
      const opexPerBucket = operatingPerBucket.map((v, i) => v + developmentPerBucket[i])

      return {
        granularity: g,
        buckets: buckets.map((bk, i) => {
          const b = perBucket[i]
          return {
            label: bk.label,
            start: bk.start,
            end:   bk.end,
            ...b,
            // Same expression as computePeriodEconomics' averageOrderValueCents.
            averageOrderValueCents: b.orderCount === 0
              ? null : Math.round(b.grossCustomerRevenueCents / b.orderCount),
            operatingExpenseCents:   opexPerBucket[i],
            developmentExpenseCents: developmentPerBucket[i],
            advertisingCents:        adsPerBucket[i],
            realizedProfitCents:
              b.contributionProfitCents - b.writeOffCostCents - opexPerBucket[i] - adsPerBucket[i],
          }
        }),
      }
    },

    /**
     * Cost composition for the breakdown / donut view.
     * Only positive components are returned — a pie implies parts of a whole and
     * a negative slice has no coherent area.
     */
    async getCostComposition(range: DateRange): Promise<Array<{ label: string; valueCents: number }>> {
      const report = await this.getPeriodReport(range)
      const p = report.period
      return [
        // Net of returned stock; a negative net is not a slice and is filtered below.
        { label: 'Product COGS',       valueCents: p.cogsCents - p.returnCogsCreditCents + p.exchangeCogsCents },
        { label: 'Shipping cost',      valueCents: p.shippingCostCents + p.exchangeShippingCostCents + p.returnLabelCostCents },
        { label: 'Stripe fees',        valueCents: p.stripeFeeCents + p.disputeFeeCents },
        { label: 'Affiliate commission', valueCents: p.affiliateCommissionCents },
        { label: 'Inventory write-offs', valueCents: p.writeOffCostCents },
        { label: 'Operating expenses', valueCents: p.recognizedOperatingExpensesCents },
        { label: 'Development',        valueCents: p.recognizedDevelopmentExpensesCents },
        { label: 'Advertising',        valueCents: p.advertisingSpendCents },
      ].filter(c => c.valueCents > 0)
    },

    /**
     * Per-product profitability for a window.
     *
     * DISCOUNT ALLOCATION uses the SINGLE authoritative allocator,
     * allocateDiscountToLines() from lib/financial-calculator.ts. There is
     * deliberately no second allocation formula in SQL: a per-line ROUND() cannot
     * guarantee that the parts sum back to the order discount, so an order with a
     * $1.00 discount across three equal lines would silently allocate $0.99 or
     * $1.01 and the product report would not reconcile to the P&L.
     *
     * Lines are fetched flat, grouped by order in TypeScript, allocated per order
     * with largest-remainder apportionment (cent-exact by construction), then
     * aggregated by SKU.
     */
    async getProductProfitability(range: DateRange): Promise<Array<{
      sku: string
      productName: string
      unitsSold: number
      grossSalesCents: number
      allocatedDiscountCents: number
      netRevenueCents: number
      cogsCents: number | null
      itemsMissingCogs: number
      grossProfitCents: number | null
      marginPct: number | null
    }>> {
      const rows = await sql.query(
        `SELECT
           oi.id              AS "lineId",
           oi.order_id        AS "orderId",
           oi.sku             AS "sku",
           oi.product_name    AS "productName",
           oi.quantity        AS "quantity",
           oi.line_total_cents AS "lineTotalCents",
           oi.line_cogs_cents  AS "lineCogsCents",
           o.discount_cents    AS "orderDiscountCents"
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.paid_at IS NOT NULL AND o.paid_at >= $1 AND o.paid_at < $2`,
        [range.start, range.end],
      )

      // Group lines by order so each order's discount is apportioned within itself.
      const byOrder = new Map<string, {
        discountCents: number
        lines: Array<{
          id: string; sku: string; productName: string
          quantity: number; lineTotalCents: number; lineCogsCents: number | null
        }>
      }>()

      for (const r of rows as any[]) {
        const orderId = r.orderId as string
        if (!byOrder.has(orderId)) {
          byOrder.set(orderId, {
            discountCents: Number(r.orderDiscountCents ?? 0),
            lines: [],
          })
        }
        byOrder.get(orderId)!.lines.push({
          id:             r.lineId,
          sku:            r.sku,
          productName:    r.productName,
          quantity:       Number(r.quantity),
          lineTotalCents: Number(r.lineTotalCents),
          lineCogsCents:  r.lineCogsCents === null ? null : Number(r.lineCogsCents),
        })
      }

      // Aggregate exact allocations by SKU.
      const bySku = new Map<string, {
        sku: string; productName: string
        unitsSold: number; grossSalesCents: number; allocatedDiscountCents: number
        cogsCents: number; itemsMissingCogs: number
      }>()

      for (const order of byOrder.values()) {
        // Authoritative allocator — sums exactly to order.discountCents.
        const allocated = allocateDiscountToLines(
          order.lines.map(l => ({ id: l.id, lineTotalCents: l.lineTotalCents })),
          order.discountCents,
        )
        const allocById = new Map(allocated.map(a => [a.id, a.allocatedDiscountCents]))

        for (const line of order.lines) {
          const existing = bySku.get(line.sku) ?? {
            sku: line.sku, productName: line.productName,
            unitsSold: 0, grossSalesCents: 0, allocatedDiscountCents: 0,
            cogsCents: 0, itemsMissingCogs: 0,
          }
          existing.unitsSold              += line.quantity
          existing.grossSalesCents        += line.lineTotalCents
          existing.allocatedDiscountCents += allocById.get(line.id) ?? 0
          if (line.lineCogsCents === null) existing.itemsMissingCogs += 1
          else                             existing.cogsCents        += line.lineCogsCents
          bySku.set(line.sku, existing)
        }
      }

      return [...bySku.values()]
        .map(p => {
          const netRevenueCents = p.grossSalesCents - p.allocatedDiscountCents
          // COGS is only reportable when EVERY line for the SKU carries a snapshot.
          const cogsCents = p.itemsMissingCogs > 0 ? null : p.cogsCents
          const grossProfitCents = cogsCents === null ? null : netRevenueCents - cogsCents
          return {
            sku:         p.sku,
            productName: p.productName,
            unitsSold:   p.unitsSold,
            grossSalesCents: p.grossSalesCents,
            allocatedDiscountCents: p.allocatedDiscountCents,
            netRevenueCents,
            cogsCents,
            itemsMissingCogs: p.itemsMissingCogs,
            grossProfitCents,
            marginPct: grossProfitCents === null || netRevenueCents === 0
              ? null
              : Math.round((grossProfitCents / netRevenueCents) * 10000) / 100,
          }
        })
        .sort((a, b) => b.grossSalesCents - a.grossSalesCents)
    },
  }
}

export type FinancialService = ReturnType<typeof createFinancialService>

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'ytd' | '1y' | 'all'

/** Resolve a preset into a half-open UTC [start, end) range. */
export function resolveRangePreset(preset: RangePreset, now: Date = new Date()): DateRange {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0
  ))
  let start: Date

  switch (preset) {
    case 'today':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      break
    case '7d':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6))
      break
    case '30d':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29))
      break
    case 'mtd':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      break
    case '90d':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89))
      break
    case 'ytd':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
      break
    case '1y':
      start = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1))
      break
    case 'all':
      // KVRN has no orders before 2024; this is a safe floor that still lets the
      // query planner use the paid_at index rather than scanning unbounded time.
      start = new Date(Date.UTC(2024, 0, 1))
      break
  }

  return { start: start.toISOString(), end: end.toISOString() }
}

/** Validate a custom ISO date range from admin input. */
export function parseCustomRange(startRaw: unknown, endRaw: unknown): DateRange | null {
  if (typeof startRaw !== 'string' || typeof endRaw !== 'string') return null
  const s = Date.parse(startRaw.length === 10 ? startRaw + 'T00:00:00Z' : startRaw)
  const e = Date.parse(endRaw.length === 10   ? endRaw   + 'T00:00:00Z' : endRaw)
  if (Number.isNaN(s) || Number.isNaN(e)) return null
  // Custom ranges are inclusive of the end DATE, so advance to the next midnight.
  const endExclusive = endRaw.length === 10 ? e + 86400000 : e
  if (endExclusive <= s) return null
  // Guard against absurd ranges that would scan the whole table.
  if (endExclusive - s > 366 * 2 * 86400000) return null
  return { start: new Date(s).toISOString(), end: new Date(endExclusive).toISOString() }
}
