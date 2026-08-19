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
  computeOrderEconomics,
  computePeriodEconomics,
  allocateDiscountToLines,
  type OrderEconomics,
  type PeriodEconomics,
  type OrderFinancialInputs,
} from './financial-calculator'

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

export interface OrderEconomicsRow {
  orderId:       string
  orderNumber:   string
  paidAt:        string | null
  paymentStatus: string
  customerEmail: string | null
  economics:     OrderEconomics
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
      rf."refundedFeeCents"
    FROM orders o
    -- COGS: only known when every single line carries a snapshot
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_and(oi.line_cogs_cents IS NOT NULL)
                  THEN SUM(oi.line_cogs_cents)::int
                  ELSE NULL END AS "cogsCents"
      FROM order_items oi WHERE oi.order_id = o.id
    ) ci ON TRUE
    -- Actual carrier cost: shipments is authoritative. NULL when nothing recorded.
    LEFT JOIN LATERAL (
      SELECT CASE WHEN COUNT(s.label_cost_cents) = 0
                  THEN NULL
                  ELSE SUM(s.label_cost_cents)::int END AS "shippingCostCents"
      FROM shipments s WHERE s.order_id = o.id
    ) sc ON TRUE
    -- Only succeeded refunds reduce recognised revenue
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(r.amount_cents),0)::int AS "refundCents",
        CASE WHEN COUNT(r.fee_refunded_cents) = 0
             THEN NULL
             ELSE SUM(r.fee_refunded_cents)::int END AS "refundedFeeCents"
      FROM order_refunds r
      WHERE r.order_id = o.id AND r.status = 'succeeded'
    ) rf ON TRUE
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
    refundedFeeCents:              nullable(r.refundedFeeCents),
  }
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
      const startDate = range.start.slice(0, 10)
      const endDate   = new Date(Date.parse(range.end) - 1).toISOString().slice(0, 10)

      const rows = await sql.query(
        `SELECT amount_cents, category, paid_at, period_start, period_end
         FROM expense_transactions
         WHERE paid_at IS NOT NULL
           AND (
             (period_start IS NULL AND paid_at >= $1 AND paid_at <= $2)
             OR (period_start IS NOT NULL AND period_start <= $2
                 AND COALESCE(period_end, period_start) >= $1)
           )`,
        [startDate, endDate],
      )

      const DAY = 86400000
      const rs = Date.parse(startDate + 'T00:00:00Z')
      const re = Date.parse(endDate   + 'T00:00:00Z')

      let operating = 0
      let development = 0

      for (const r of rows as any[]) {
        const amount = Number(r.amount_cents)
        let share = amount

        if (r.period_start) {
          const ps = Date.parse(String(r.period_start).slice(0, 10) + 'T00:00:00Z')
          const pe = Date.parse(
            String(r.period_end ?? r.period_start).slice(0, 10) + 'T00:00:00Z')
          const spanDays    = Math.floor((pe - ps) / DAY) + 1
          const overlapDays =
            Math.floor((Math.min(pe, re) - Math.max(ps, rs)) / DAY) + 1
          if (overlapDays <= 0 || spanDays <= 0) continue
          share = Math.round(amount * (overlapDays / spanDays))
        }

        if (r.category === 'development') development += share
        else                              operating   += share
      }

      return { operating, development }
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
      const startDate = range.start.slice(0, 10)
      const endDate   = new Date(Date.parse(range.end) - 1).toISOString().slice(0, 10)

      const rows = await sql.query(
        `SELECT spend_cents, period_start, period_end
         FROM ad_spend
         WHERE period_start <= $1 AND period_end >= $2`,
        [endDate, startDate],
      )

      const DAY = 86400000
      let total = 0
      for (const r of rows as any[]) {
        const ps = Date.parse(String(r.period_start).slice(0, 10) + 'T00:00:00Z')
        const pe = Date.parse(String(r.period_end).slice(0, 10)   + 'T00:00:00Z')
        const rs = Date.parse(startDate + 'T00:00:00Z')
        const re = Date.parse(endDate   + 'T00:00:00Z')

        const campaignDays = Math.floor((pe - ps) / DAY) + 1
        const overlapStart = Math.max(ps, rs)
        const overlapEnd   = Math.min(pe, re)
        const overlapDays  = Math.floor((overlapEnd - overlapStart) / DAY) + 1

        if (overlapDays <= 0 || campaignDays <= 0) continue
        total += Math.round(Number(r.spend_cents) * (overlapDays / campaignDays))
      }
      return total
    },

    /** Full period report: order economics + operating expenses + ad spend. */
    async getPeriodReport(range: DateRange): Promise<{
      period:  PeriodEconomics
      orders:  OrderEconomicsRow[]
    }> {
      const [orders, recognized, advertisingSpendCents, forecast] = await Promise.all([
        this.getOrderEconomicsInRange(range),
        this.getRecognizedOperatingExpensesCents(range),
        this.getAdvertisingSpendCents(range),
        this.getForecastOperatingExpensesCents(),
      ])

      return {
        period: computePeriodEconomics({
          orders: orders.map(o => o.economics),
          // RECOGNIZED from real transactions only — definitions and forecasts
          // are excluded by construction
          recognizedOperatingExpensesCents:   recognized.operating,
          recognizedDevelopmentExpensesCents: recognized.development,
          advertisingSpendCents,
          // FORECASTS — carried for display, never subtracted from realised profit
          estimatedAccruedOperatingExpensesCents: forecast.estimatedAccrued,
          projectedOperatingExpensesCents:        forecast.projectedMonthEnd,
        }),
        orders,
      }
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

export type RangePreset = 'today' | '7d' | '30d' | 'mtd' | 'ytd'

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
    case 'ytd':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
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
