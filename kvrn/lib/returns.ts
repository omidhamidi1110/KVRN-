// lib/returns.ts — returns, exchanges and refund component resolution
// Server-only.
//
// ── THE RULE THIS FILE EXISTS TO PROTECT ────────────────────────────────────
//
// A RETURN NEVER REDUCES REVENUE. Only order_refunds does.
//
// A return records what physically came back and what it means for inventory and
// COGS. The money is handled by whichever refund the return is allocated to.
// Treating a return as a revenue reducer as well would count the same dollar
// twice — the likeliest error in this whole area.
//
// ── REFUND COMPONENT BREAKDOWN ──────────────────────────────────────────────
//
// Stripe reports a refund TOTAL and does not decompose it. A NULL component means
// "not known", not zero and not "anything up to the total". Component-level
// allocation is therefore refused until the split is resolved either by
// deterministic derivation (full refund) or by an exact admin decomposition.
//
// While unresolved the refund still reduces customer cash and total refunded
// amount, returns may still be created, and physical receipt may still be
// recorded. Only the component split waits.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export const RETURN_STATUSES = [
  'requested', 'in_transit', 'received', 'completed', 'cancelled',
] as const
export type ReturnStatus = typeof RETURN_STATUSES[number]

export const DISPOSITIONS = [
  'sellable', 'damaged', 'defective', 'lost', 'disposed',
] as const
export type Disposition = typeof DISPOSITIONS[number]

export const RETURN_SHIPPING_PAYERS = ['kvrn', 'customer', 'not_applicable'] as const
export type ReturnShippingPayer = typeof RETURN_SHIPPING_PAYERS[number]

export const EXCHANGE_STATUSES = ['pending', 'shipped', 'completed', 'cancelled'] as const
export type ExchangeStatus = typeof EXCHANGE_STATUSES[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CENTS = 1_000_000_00

export interface ReturnItemInput {
  orderItemId: string
  quantity:    number
  disposition: Disposition
  notes?:      string | null
}

export interface CreateReturnInput {
  orderId:     string
  items:       ReturnItemInput[]
  returnShippingPaidBy?: ReturnShippingPayer
  reason?:     string | null
  notes?:      string | null
}

export interface DecompositionInput {
  merchandiseCents: number
  shippingCents:    number
  taxCents:         number
}

type Result = { ok: true } | { ok: false; error: string }

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

export function validateCreateReturn(d: Partial<CreateReturnInput>): Result {
  if (!d.orderId || !UUID_RE.test(d.orderId)) {
    return { ok: false, error: 'A valid order is required.' }
  }
  if (!Array.isArray(d.items) || d.items.length === 0) {
    return { ok: false, error: 'At least one returned item is required.' }
  }
  const seen = new Set<string>()
  for (const item of d.items) {
    if (!item.orderItemId || !UUID_RE.test(item.orderItemId)) {
      return { ok: false, error: 'Each item must reference a valid order line.' }
    }
    if (seen.has(item.orderItemId)) {
      return { ok: false, error: 'The same order line appears twice in this return.' }
    }
    seen.add(item.orderItemId)
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return { ok: false, error: 'Return quantity must be a positive whole number.' }
    }
    if (!DISPOSITIONS.includes(item.disposition)) {
      return { ok: false, error: 'Each item needs a valid disposition.' }
    }
  }
  if (d.returnShippingPaidBy && !RETURN_SHIPPING_PAYERS.includes(d.returnShippingPaidBy)) {
    return { ok: false, error: 'Return shipping payer is not valid.' }
  }
  return { ok: true }
}

/**
 * An admin decomposition must sum EXACTLY to the refund total.
 * No component may be omitted and silently treated as zero.
 */
export function validateDecomposition(
  d: Partial<DecompositionInput>,
  refundTotalCents: number,
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
    if ((v as number) > MAX_CENTS) {
      return { ok: false, error: `${label} is implausibly large.` }
    }
  }
  const sum = (d.merchandiseCents ?? 0) + (d.shippingCents ?? 0) + (d.taxCents ?? 0)
  if (sum !== refundTotalCents) {
    return {
      ok: false,
      error: `Components must total exactly the refund amount. Entered ${sum}, refund is ${refundTotalCents}.`,
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export function createReturnsService(sql: NeonQueryFunction<false, false>) {
  return {
    /**
     * Create a return with its line items.
     *
     * Snapshots unit COGS and unit price from order_items so a later cost-batch
     * change cannot alter the economics of goods already returned. Enforces that
     * cumulative returned quantity never exceeds the quantity actually ordered.
     *
     * No restock happens here — restocking is a separate physical event and
     * arrives with the inventory layer work in migration 019.
     */
    async createReturn(input: CreateReturnInput, actorEmail: string) {
      const rows = await sql`SELECT create_order_return(
        ${input.orderId}::uuid,
        ${JSON.stringify(input.items)}::jsonb,
        ${input.returnShippingPaidBy ?? 'not_applicable'},
        ${input.reason ?? null},
        ${input.notes ?? null},
        ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    async listReturns(limit = 100) {
      const rows = await sql`
        SELECT r.id, r.return_number AS "returnNumber", r.order_id AS "orderId",
               o.order_number AS "orderNumber", r.status,
               r.return_shipping_paid_by AS "returnShippingPaidBy",
               r.return_label_cost_cents AS "returnLabelCostCents",
               r.return_shipping_charged_to_customer_cents AS "returnShippingChargedCents",
               r.reason, r.requested_at AS "requestedAt", r.received_at AS "receivedAt",
               r.completed_at AS "completedAt",
               (SELECT COUNT(*) FROM order_return_items ri WHERE ri.return_id = r.id)::int
                 AS "itemCount",
               (SELECT COALESCE(SUM(ri.quantity),0) FROM order_return_items ri
                 WHERE ri.return_id = r.id)::int AS "totalQuantity"
        FROM order_returns r
        JOIN orders o ON o.id = r.order_id
        ORDER BY r.requested_at DESC
        LIMIT ${limit}
      `
      return (rows as any[]).map(r => ({
        ...r,
        returnLabelCostCents: r.returnLabelCostCents === null ? null : Number(r.returnLabelCostCents),
        returnShippingChargedCents:
          r.returnShippingChargedCents === null ? null : Number(r.returnShippingChargedCents),
        requestedAt: r.requestedAt ? new Date(r.requestedAt).toISOString() : null,
        receivedAt:  r.receivedAt  ? new Date(r.receivedAt).toISOString()  : null,
        completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
      }))
    },

    async getReturn(returnId: string) {
      const [header] = (await sql`
        SELECT r.*, o.order_number AS "orderNumber"
        FROM order_returns r JOIN orders o ON o.id = r.order_id
        WHERE r.id = ${returnId}::uuid
      `) as any[]
      if (!header) return null

      const [items, allocations] = await Promise.all([
        sql`
          SELECT ri.id, ri.order_item_id AS "orderItemId", ri.quantity, ri.disposition,
                 ri.restocked, ri.restocked_at AS "restockedAt",
                 ri.unit_cogs_cents_snapshot  AS "unitCogsCentsSnapshot",
                 ri.unit_price_cents_snapshot AS "unitPriceCentsSnapshot",
                 ri.cogs_credit_cents AS "cogsCreditCents",
                 oi.sku, oi.product_name AS "productName", oi.size, oi.color
          FROM order_return_items ri
          JOIN order_items oi ON oi.id = ri.order_item_id
          WHERE ri.return_id = ${returnId}::uuid
          ORDER BY oi.sku
        `,
        sql`
          SELECT a.id, a.refund_id AS "refundId",
                 a.merchandise_cents AS "merchandiseCents",
                 a.shipping_cents AS "shippingCents", a.tax_cents AS "taxCents",
                 f.stripe_refund_id AS "stripeRefundId", f.amount_cents AS "refundAmountCents",
                 f.component_breakdown_status AS "breakdownStatus"
          FROM return_refund_allocations a
          JOIN order_refunds f ON f.id = a.refund_id
          WHERE a.return_id = ${returnId}::uuid
        `,
      ])

      return {
        id: header.id,
        returnNumber: header.return_number,
        orderId: header.order_id,
        orderNumber: header.orderNumber,
        status: header.status,
        returnShippingPaidBy: header.return_shipping_paid_by,
        returnLabelCostCents: header.return_label_cost_cents === null
          ? null : Number(header.return_label_cost_cents),
        reason: header.reason,
        notes: header.notes,
        items: (items as any[]).map(i => ({
          ...i,
          unitCogsCentsSnapshot: i.unitCogsCentsSnapshot === null ? null : Number(i.unitCogsCentsSnapshot),
          unitPriceCentsSnapshot: i.unitPriceCentsSnapshot === null ? null : Number(i.unitPriceCentsSnapshot),
          cogsCreditCents: i.cogsCreditCents === null ? null : Number(i.cogsCreditCents),
          restockedAt: i.restockedAt ? new Date(i.restockedAt).toISOString() : null,
        })),
        allocations: (allocations as any[]).map(a => ({
          ...a,
          merchandiseCents: Number(a.merchandiseCents),
          shippingCents:    Number(a.shippingCents),
          taxCents:         Number(a.taxCents),
          refundAmountCents: Number(a.refundAmountCents),
        })),
      }
    },

    async updateReturnStatus(returnId: string, status: ReturnStatus) {
      const rows = await sql`
        UPDATE order_returns
        SET status = ${status},
            received_at  = CASE WHEN ${status} = 'received'  AND received_at  IS NULL
                                THEN NOW() ELSE received_at  END,
            completed_at = CASE WHEN ${status} = 'completed' AND completed_at IS NULL
                                THEN NOW() ELSE completed_at END,
            updated_at = NOW()
        WHERE id = ${returnId}::uuid
        RETURNING id
      `
      return (rows as any[]).length > 0
    },

    /**
     * Record KVRN's actual carrier cost for a return label.
     * Only meaningful when KVRN paid; the DB constraint enforces that too.
     */
    async setReturnLabelCost(returnId: string, cents: number) {
      const rows = await sql`
        UPDATE order_returns
        SET return_label_cost_cents = ${cents}, updated_at = NOW()
        WHERE id = ${returnId}::uuid AND return_shipping_paid_by = 'kvrn'
        RETURNING id
      `
      return (rows as any[]).length > 0
    },

    /** Refunds whose component split is still unknown — the admin worklist. */
    async listRefundsAwaitingBreakdown() {
      const rows = await sql`
        SELECT f.id, f.stripe_refund_id AS "stripeRefundId",
               f.amount_cents AS "amountCents", f.status, f.refunded_at AS "refundedAt",
               f.order_id AS "orderId", o.order_number AS "orderNumber",
               o.subtotal_cents AS "orderSubtotalCents",
               o.discount_cents AS "orderDiscountCents",
               o.shipping_cents AS "orderShippingCents",
               o.tax_cents      AS "orderTaxCents",
               o.total_cents    AS "orderTotalCents"
        FROM order_refunds f
        JOIN orders o ON o.id = f.order_id
        WHERE f.component_breakdown_status = 'unknown'
        ORDER BY f.created_at DESC
        LIMIT 200
      `
      return (rows as any[]).map(r => ({
        ...r,
        amountCents:        Number(r.amountCents),
        orderSubtotalCents: Number(r.orderSubtotalCents),
        orderDiscountCents: Number(r.orderDiscountCents),
        orderShippingCents: Number(r.orderShippingCents),
        orderTaxCents:      Number(r.orderTaxCents),
        orderTotalCents:    Number(r.orderTotalCents),
        // Signals whether deterministic derivation is available for this refund.
        canDeriveFullRefund: Number(r.amountCents) === Number(r.orderTotalCents),
        refundedAt: r.refundedAt ? new Date(r.refundedAt).toISOString() : null,
      }))
    },

    /**
     * Resolve a refund's component breakdown.
     *
     * Pass no components to derive deterministically (full refunds only).
     * Pass all three to record an admin decomposition; it is rejected unless the
     * three sum exactly to the refund total.
     */
    async resolveRefundComponents(
      refundId: string,
      components: DecompositionInput | null,
      actorEmail: string,
    ) {
      const rows = await sql`SELECT resolve_refund_components(
        ${refundId}::uuid,
        ${components?.merchandiseCents ?? null}::integer,
        ${components?.shippingCents ?? null}::integer,
        ${components?.taxCents ?? null}::integer,
        ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    /**
     * Allocate part of a refund to a return.
     *
     * Refuses entirely while the refund's breakdown is unresolved — NULL
     * components are neither permissive caps nor zeros.
     */
    async allocateReturnRefund(
      returnId: string,
      refundId: string,
      components: DecompositionInput,
      actorEmail: string,
    ) {
      const rows = await sql`SELECT allocate_return_refund(
        ${returnId}::uuid,
        ${refundId}::uuid,
        ${components.merchandiseCents}::integer,
        ${components.shippingCents}::integer,
        ${components.taxCents}::integer,
        ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },

    // ── Exchanges ───────────────────────────────────────────────────────────

    async listExchanges(limit = 100) {
      const rows = await sql`
        SELECT e.id, e.exchange_number AS "exchangeNumber", e.order_id AS "orderId",
               o.order_number AS "orderNumber", e.status, e.return_id AS "returnId",
               e.price_difference_cents  AS "priceDifferenceCents",
               e.price_difference_status AS "priceDifferenceStatus",
               e.replacement_shipping_cost_cents AS "replacementShippingCostCents",
               e.created_at AS "createdAt", e.shipped_at AS "shippedAt"
        FROM order_exchanges e
        JOIN orders o ON o.id = e.order_id
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `
      return (rows as any[]).map(e => ({
        ...e,
        priceDifferenceCents: Number(e.priceDifferenceCents),
        replacementShippingCostCents: e.replacementShippingCostCents === null
          ? null : Number(e.replacementShippingCostCents),
        createdAt: new Date(e.createdAt).toISOString(),
        shippedAt: e.shippedAt ? new Date(e.shippedAt).toISOString() : null,
      }))
    },

    /**
     * Create an exchange.
     *
     * An exchange is not a sale: it records replacement units and shipping cost.
     * Any price difference starts as 'pending' and has NO financial effect until
     * settled with real Stripe evidence.
     */
    async createExchange(input: {
      orderId: string
      returnId?: string | null
      items: Array<{ variantId: string; sku: string; quantity: number }>
      priceDifferenceCents?: number
      reason?: string | null
    }, actorEmail: string) {
      const rows = await sql`SELECT create_order_exchange(
        ${input.orderId}::uuid,
        ${input.returnId ?? null}::uuid,
        ${JSON.stringify(input.items)}::jsonb,
        ${input.priceDifferenceCents ?? 0}::integer,
        ${input.reason ?? null},
        ${actorEmail}
      ) AS result`
      return (rows as any[])[0]?.result
    },
  }
}

export type ReturnsService = ReturnType<typeof createReturnsService>
