// lib/admin-orders.ts — Admin order management service
// Injectable SQL for testability. No public API exposure.
// V51.2: list, detail, count, and unfulfilled→processing transition only.
// Orders refresh: internal order tags (list chips, tag filter, detail) and the server-enforced
// Stripe Radar fulfillment hold (an early, friendly 409 on top of the database triggers in 031).

import type { NeonQueryFunction } from '@neondatabase/serverless'
import { createOrderTagService, type OrderTagChip } from './order-tags'
import { createFraudReviewService, hasActiveFraudHold, isFraudHoldDbError, type HoldState } from './fraud-review'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdminOrderRow {
  id:                string
  orderNumber:       string
  paymentStatus:     string
  fulfillmentStatus: string
  currency:          string
  subtotalCents:     number
  shippingCents:     number
  taxCents:          number
  discountCents:     number
  totalCents:        number
  shippingMethod:    string | null
  customerEmail:     string | null
  customerName:      string | null
  paidAt:            string | null
  createdAt:         string
  updatedAt:         string
  itemCount:         number
  quantityCount:     number
}

export interface AdminOrderItem {
  id:             string
  sku:            string
  productName:    string
  color:          string
  size:           string
  quantity:       number
  unitPriceCents: number
  lineTotalCents: number
}

export interface ShipmentInfo {
  id:             string
  carrier:        string | null
  trackingNumber: string | null
  shippedAt:      string | null
}

/** Migration 025: the record that a fully refunded, never-shipped order was cancelled and restocked. */
export interface OrderCancellationInfo {
  id:               string
  reason:           string
  cancelledBy:      string
  cancelledAt:      string
  restockedUnits:   number
  unknownCostUnits: number
  /** null = at least one restored unit has an UNKNOWN cost (never zero). */
  cogsCreditCents:  number | null
}

/** A set ("Complete the Set") bought on this order, from the immutable order snapshot. */
export interface AdminOrderBundle {
  bundleId: string
  setQuantity: number
  pricingMode: string
  pricingValue: number
  componentSubtotalCents: number
  bundleDiscountCents: number
  bundleNetCents: number
  lines: Array<{
    orderItemId: string; sku: string; productName: string; quantity: number
    originalUnitPriceCents: number; allocatedDiscountCents: number; netLineCents: number
  }>
}

export interface AdminOrderDetail extends AdminOrderRow {
  customerPhone:   string | null
  shippingAddress: Record<string, string | null> | null
  items:           AdminOrderItem[]
  shipment:        ShipmentInfo | null
  cancellation:    OrderCancellationInfo | null
  /** INTERNAL labels (never customer-facing). Empty if none or if tags are unavailable. */
  tags:            OrderTagChip[]
  /** True while a server-enforced fraud fulfillment hold is active. Payment status is unaffected. */
  fraudHoldActive: boolean
  /** Present only when the order contains a set. Absent on every other order. */
  bundle?: AdminOrderBundle | null
}

/** A list row decorated with internal tags and a compact fraud summary (see decorateRows). */
export interface AdminOrderListItem extends AdminOrderRow {
  tags:  OrderTagChip[]
  fraud: { hold: HoldState; flagged: boolean; syncError: boolean } | null
}

export interface ListOrdersParams {
  paymentStatus?:     string
  fulfillmentStatus?: string
  search?:            string
  /** Orders carrying this internal tag (uuid). Absent = the original, unchanged queries. */
  tagId?:             string
  limit:              number
  offset:             number
}

export const VALID_PAYMENT_STATUSES     = ['pending','paid','failed','refunded'] as const
export const VALID_FULFILLMENT_STATUSES = ['unfulfilled','processing','shipped','delivered','cancelled'] as const
export const CANCEL_REASON_MIN = 3
export const CANCEL_REASON_MAX = 500

/** Trim and bound the free-text reason. The database re-validates; this gives a clean 400. */
export function validateCancelReason(raw: unknown):
  { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'A reason is required.' }
  const reason = raw.trim()
  if (reason.length < CANCEL_REASON_MIN) {
    return { ok: false, error: `The reason must be at least ${CANCEL_REASON_MIN} characters.` }
  }
  if (reason.length > CANCEL_REASON_MAX) {
    return { ok: false, error: `The reason must be ${CANCEL_REASON_MAX} characters or fewer.` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(reason)) return { ok: false, error: 'The reason contains control characters.' }
  return { ok: true, reason }
}

/**
 * Database error code (KVRN_CANCEL|<CODE>|...) -> HTTP status and a plain-language message.
 * Every eligibility failure is a 409: the request was well-formed, the ORDER is not eligible.
 */
export const CANCEL_ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_REQUIRED:   { status: 400, message: 'Invalid order.' },
  ACTOR_REQUIRED:   { status: 400, message: 'An admin identity is required.' },
  ACTOR_INVALID:    { status: 400, message: 'The admin identity is invalid.' },
  REASON_REQUIRED:  { status: 400, message: 'A reason is required.' },
  REASON_TOO_SHORT: { status: 400, message: `The reason must be at least ${CANCEL_REASON_MIN} characters.` },
  REASON_INVALID:   { status: 400, message: 'The reason is too long or contains control characters.' },
  ORDER_NOT_FOUND:  { status: 404, message: 'Order not found.' },
  NOT_PAID:         { status: 409, message: 'The order was never paid.' },
  ALREADY_SHIPPED:  { status: 409, message: 'The order has already shipped or been delivered; it cannot be cancelled as an unshipped order.' },
  INVALID_FULFILLMENT_STATUS: { status: 409, message: 'The order is not unfulfilled or processing.' },
  NOT_REFUNDED:     { status: 409, message: 'The order is not marked refunded.' },
  NO_PAYMENT_TO_REFUND: { status: 409, message: 'The order has no payment to have been refunded.' },
  PARTIAL_REFUND:   { status: 409, message: 'The order is only partially refunded; only a full refund can cancel and restock it.' },
  REFUND_EXCEEDS_TOTAL: { status: 409, message: 'Refunds on record exceed the order total; resolve that in Reconciliation first.' },
  SHIPMENT_EXISTS:  { status: 409, message: 'A shipment or label exists for this order; it cannot use the unshipped-cancellation path.' },
  HAS_RETURN:       { status: 409, message: 'The order has a return; handle the goods through the Returns workflow.' },
  HAS_EXCHANGE:     { status: 409, message: 'The order has an exchange; it cannot be cancelled this way.' },
  HAS_DISPUTE:      { status: 409, message: 'The order has a dispute; it cannot be cancelled this way.' },
  NO_ITEMS:         { status: 409, message: 'The order has no items to restock.' },
  VARIANT_MISSING:  { status: 409, message: 'An order line has no product variant, so its stock cannot be restored.' },
  FIFO_QUANTITY_MISMATCH: { status: 409, message: 'The inventory consumed for this order does not match what it sold; resolve that in Reconciliation first.' },
  ALREADY_CANCELLED_DIFFERENT_REASON: { status: 409, message: 'This order was already cancelled with a different reason; the record cannot be changed.' },
}

export class CancelOrderError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}

export type CancelOrderResult = {
  outcome:            'cancelled' | 'already_cancelled'
  orderId:            string
  cancellationId:     string
  restockedUnits:     number
  unknownCostUnits:   number
  cogsCreditCents:    number | null
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Service factory ───────────────────────────────────────────────────────────

export function createAdminOrderService(sql: NeonQueryFunction<false, false>) {
  return {

    async listOrders(params: ListOrdersParams): Promise<AdminOrderRow[]> {
      const { paymentStatus, fulfillmentStatus, search, limit, offset } = params

      // Tag filter: ONE dedicated query. Every request without a tag filter falls through to the
      // original queries below, untouched.
      if (params.tagId) {
        const q = search ? `%${search.replace(/%/g,'\\%').replace(/_/g,'\\_')}%` : null
        const pay = paymentStatus ?? null
        const ful = fulfillmentStatus ?? null
        return sql`
          SELECT o.id, o.order_number AS "orderNumber",
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
            o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
            o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
            o.customer_name AS "customerName", o.paid_at AS "paidAt",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE EXISTS (SELECT 1 FROM order_tag_assignments a WHERE a.order_id = o.id AND a.tag_id = ${params.tagId}::uuid)
            AND (${pay}::text IS NULL OR o.payment_status = ${pay})
            AND (${ful}::text IS NULL OR o.fulfillment_status = ${ful})
            AND (${q}::text IS NULL OR (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q}))
          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
        ` as any
      }

      // Build with positional params — no dynamic SQL from user input
      // Neon tagged template handles parameterization
      if (search) {
        const q = `%${search.replace(/%/g,'\\%').replace(/_/g,'\\_')}%`
        if (paymentStatus && fulfillmentStatus) {
          return sql`
            SELECT o.id, o.order_number AS "orderNumber",
              o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
              o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
              o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
              o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
              o.customer_name AS "customerName", o.paid_at AS "paidAt",
              o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
            FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.payment_status = ${paymentStatus}
              AND o.fulfillment_status = ${fulfillmentStatus}
              AND (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q})
            GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
          ` as any
        }
        if (paymentStatus) {
          return sql`
            SELECT o.id, o.order_number AS "orderNumber",
              o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
              o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
              o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
              o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
              o.customer_name AS "customerName", o.paid_at AS "paidAt",
              o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
            FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.payment_status = ${paymentStatus}
              AND (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q})
            GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
          ` as any
        }
        if (fulfillmentStatus) {
          return sql`
            SELECT o.id, o.order_number AS "orderNumber",
              o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
              o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
              o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
              o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
              o.customer_name AS "customerName", o.paid_at AS "paidAt",
              o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
            FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.fulfillment_status = ${fulfillmentStatus}
              AND (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q})
            GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
          ` as any
        }
        return sql`
          SELECT o.id, o.order_number AS "orderNumber",
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
            o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
            o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
            o.customer_name AS "customerName", o.paid_at AS "paidAt",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q})
          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
        ` as any
      }

      // No search
      if (paymentStatus && fulfillmentStatus) {
        return sql`
          SELECT o.id, o.order_number AS "orderNumber",
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
            o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
            o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
            o.customer_name AS "customerName", o.paid_at AS "paidAt",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.payment_status = ${paymentStatus} AND o.fulfillment_status = ${fulfillmentStatus}
          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
        ` as any
      }
      if (paymentStatus) {
        return sql`
          SELECT o.id, o.order_number AS "orderNumber",
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
            o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
            o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
            o.customer_name AS "customerName", o.paid_at AS "paidAt",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.payment_status = ${paymentStatus}
          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
        ` as any
      }
      if (fulfillmentStatus) {
        return sql`
          SELECT o.id, o.order_number AS "orderNumber",
            o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
            o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
            o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
            o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
            o.customer_name AS "customerName", o.paid_at AS "paidAt",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
          FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.fulfillment_status = ${fulfillmentStatus}
          GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
        ` as any
      }
      return sql`
        SELECT o.id, o.order_number AS "orderNumber",
          o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
          o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
          o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
          o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
          o.customer_name AS "customerName", o.paid_at AS "paidAt",
          o.created_at AS "createdAt", o.updated_at AS "updatedAt",
          COUNT(oi.id)::int AS "itemCount", COALESCE(SUM(oi.quantity),0)::int AS "quantityCount"
        FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}
      ` as any
    },

    async countOrders(params: Omit<ListOrdersParams, 'limit' | 'offset'>): Promise<number> {
      const { paymentStatus, fulfillmentStatus, search } = params
      if (params.tagId) {
        const q = search ? `%${search.replace(/%/g,'\\%').replace(/_/g,'\\_')}%` : null
        const pay = paymentStatus ?? null
        const ful = fulfillmentStatus ?? null
        const r = await sql`
          SELECT COUNT(*)::int AS n FROM orders o
          WHERE EXISTS (SELECT 1 FROM order_tag_assignments a WHERE a.order_id = o.id AND a.tag_id = ${params.tagId}::uuid)
            AND (${pay}::text IS NULL OR o.payment_status = ${pay})
            AND (${ful}::text IS NULL OR o.fulfillment_status = ${ful})
            AND (${q}::text IS NULL OR (o.order_number ILIKE ${q} OR o.customer_email ILIKE ${q} OR o.customer_name ILIKE ${q}))`
        return Number((r[0] as any).n)
      }
      if (search) {
        const q = `%${search.replace(/%/g,'\\%').replace(/_/g,'\\_')}%`
        if (paymentStatus && fulfillmentStatus) {
          const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE payment_status=${paymentStatus} AND fulfillment_status=${fulfillmentStatus} AND (order_number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_name ILIKE ${q})`
          return Number((r[0] as any).n)
        }
        if (paymentStatus) {
          const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE payment_status=${paymentStatus} AND (order_number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_name ILIKE ${q})`
          return Number((r[0] as any).n)
        }
        if (fulfillmentStatus) {
          const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE fulfillment_status=${fulfillmentStatus} AND (order_number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_name ILIKE ${q})`
          return Number((r[0] as any).n)
        }
        const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE (order_number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_name ILIKE ${q})`
        return Number((r[0] as any).n)
      }
      if (paymentStatus && fulfillmentStatus) {
        const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE payment_status=${paymentStatus} AND fulfillment_status=${fulfillmentStatus}`
        return Number((r[0] as any).n)
      }
      if (paymentStatus) {
        const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE payment_status=${paymentStatus}`
        return Number((r[0] as any).n)
      }
      if (fulfillmentStatus) {
        const r = await sql`SELECT COUNT(*)::int AS n FROM orders WHERE fulfillment_status=${fulfillmentStatus}`
        return Number((r[0] as any).n)
      }
      const r = await sql`SELECT COUNT(*)::int AS n FROM orders`
      return Number((r[0] as any).n)
    },

    async getOrderDetail(id: string): Promise<AdminOrderDetail | null> {
      const orders = await sql`
        SELECT o.id, o.order_number AS "orderNumber",
          o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
          o.currency, o.subtotal_cents AS "subtotalCents", o.shipping_cents AS "shippingCents",
          o.tax_cents AS "taxCents", o.discount_cents AS "discountCents", o.total_cents AS "totalCents",
          o.shipping_method AS "shippingMethod", o.customer_email AS "customerEmail",
          o.customer_name AS "customerName", o.customer_phone AS "customerPhone",
          o.shipping_address AS "shippingAddress", o.paid_at AS "paidAt",
          o.created_at AS "createdAt", o.updated_at AS "updatedAt"
        FROM orders o WHERE o.id = ${id} LIMIT 1
      `
      if (orders.length === 0) return null
      const o = orders[0] as any

      const items = await sql`
        SELECT id, sku, product_name AS "productName", color, size, quantity,
               unit_price_cents AS "unitPriceCents", line_total_cents AS "lineTotalCents"
        FROM order_items WHERE order_id = ${id} ORDER BY created_at
      `

      const [countRow] = await sql`
        SELECT COUNT(id)::int AS "itemCount", COALESCE(SUM(quantity),0)::int AS "quantityCount"
        FROM order_items WHERE order_id = ${id}
      `

      const shipmentRows = await sql`
        SELECT id, carrier, tracking_number AS "trackingNumber", shipped_at AS "shippedAt"
        FROM shipments WHERE order_id = ${id} LIMIT 1
      `
      const shipment: ShipmentInfo | null = shipmentRows.length > 0
        ? shipmentRows[0] as ShipmentInfo
        : null

      const cancelRows = await sql`
        SELECT id, reason, cancelled_by AS "cancelledBy", created_at AS "cancelledAt",
               restocked_units AS "restockedUnits", unknown_cost_units AS "unknownCostUnits",
               cogs_credit_cents AS "cogsCreditCents"
        FROM order_cancellations WHERE order_id = ${id} LIMIT 1
      `
      const cr = (cancelRows as any[])[0]
      const cancellation: OrderCancellationInfo | null = cr
        ? {
            id: cr.id, reason: cr.reason, cancelledBy: cr.cancelledBy,
            cancelledAt: new Date(cr.cancelledAt).toISOString(),
            restockedUnits: Number(cr.restockedUnits), unknownCostUnits: Number(cr.unknownCostUnits),
            cogsCreditCents: cr.cogsCreditCents === null ? null : Number(cr.cogsCreditCents),
          }
        : null

      // Internal tags and the fraud-hold flag. Both are additive: if migration 031 is not applied yet they
      // read as empty / false and the order detail loads exactly as before.
      let tags: OrderTagChip[] = []
      let fraudHoldActive = false
      try { tags = await createOrderTagService(sql).tagsForOrder(id) } catch { tags = [] }
      try { fraudHoldActive = await hasActiveFraudHold(sql, id) } catch { fraudHoldActive = false }

      // Set snapshot (migration 029). Additive: missing table / no set = the detail is exactly as before.
      let bundle: AdminOrderBundle | null = null
      try { bundle = await loadOrderBundle(sql, id) } catch { bundle = null }

      return {
        ...o,
        ...(bundle ? { bundle } : {}),
        itemCount:     (countRow as any).itemCount    ?? 0,
        quantityCount: (countRow as any).quantityCount ?? 0,
        items: items as AdminOrderItem[],
        shipment,
        cancellation,
        tags,
        fraudHoldActive,
      }
    },

    /**
     * Attach internal tags and a compact fraud summary to list rows (two extra queries, regardless of page
     * size). Best-effort by design: if either lookup fails the rows are returned undecorated rather than
     * breaking the Orders list.
     */
    async decorateRows(rows: AdminOrderRow[]): Promise<AdminOrderListItem[]> {
      const ids = rows.map(r => r.id)
      let tagMap = new Map<string, OrderTagChip[]>()
      let fraudMap = new Map<string, { hold: HoldState; flagged: boolean; syncError: boolean }>()
      try { tagMap = await createOrderTagService(sql).tagsForOrders(ids) } catch (err: any) {
        console.error('[admin-orders] tags unavailable (non-fatal):', String(err?.message ?? '').slice(0, 80))
      }
      try { fraudMap = await createFraudReviewService(sql).summariesForOrders(ids) } catch (err: any) {
        console.error('[admin-orders] fraud summary unavailable (non-fatal):', String(err?.message ?? '').slice(0, 80))
      }
      return rows.map(r => ({ ...r, tags: tagMap.get(r.id) ?? [], fraud: fraudMap.get(r.id) ?? null }))
    },

    /** V51.2: only unfulfilled → processing. Returns outcome string. */
    async transitionToProcessing(id: string): Promise<
      'updated' | 'already_processing' | 'not_found' | 'conflict' | 'fraud_hold'
    > {
      const rows = await sql`SELECT fulfillment_status FROM orders WHERE id=${id}`
      if (rows.length === 0) return 'not_found'

      const current = (rows[0] as any).fulfillment_status
      if (current === 'processing') return 'already_processing'
      if (current !== 'unfulfilled') return 'conflict'

      // Early refusal; the database trigger (031) is the real enforcement and is mapped below too.
      if (await hasActiveFraudHold(sql, id)) return 'fraud_hold'

      let updated: any[]
      try {
        updated = await sql`
          UPDATE orders SET fulfillment_status='processing', updated_at=NOW()
          WHERE id=${id} AND fulfillment_status='unfulfilled'
          RETURNING id
        ` as any[]
      } catch (err) {
        if (isFraudHoldDbError(err)) return 'fraud_hold'
        throw err
      }
      if (updated.length === 0) return 'already_processing'
      return 'updated'
    },

    /**
     * Migration 025: cancel a FULLY REFUNDED, NEVER-SHIPPED order and restore its inventory.
     * The database function is the authority (it re-checks every eligibility rule under a row
     * lock); nothing here pre-decides eligibility. An exact repeat returns 'already_cancelled'.
     * Throws CancelOrderError with a stable code on every refusal.
     */
    async cancelUnshippedOrder(id: string, actorEmail: string, reason: string): Promise<CancelOrderResult> {
      try {
        const rows = await sql`
          SELECT cancel_fully_refunded_unshipped_order(${id}::uuid, ${actorEmail}, ${reason}) AS result
        `
        const r = (rows[0] as any).result
        return {
          outcome:          r.outcome,
          orderId:          r.order_id,
          cancellationId:   r.cancellation_id,
          restockedUnits:   Number(r.restocked_units),
          unknownCostUnits: Number(r.unknown_cost_units),
          cogsCreditCents:  r.cogs_credit_cents === null || r.cogs_credit_cents === undefined
                              ? null : Number(r.cogs_credit_cents),
        }
      } catch (err: any) {
        const m = /KVRN_CANCEL\|([A-Z_]+)/.exec(String(err?.message ?? ''))
        if (m) {
          const known = CANCEL_ERRORS[m[1]]
          if (known) throw new CancelOrderError(m[1], known.status, known.message)
        }
        throw err
      }
    },

    /** V51.3: processing → shipped. Calls mark_order_shipped() atomically. */
    async markOrderShipped(
      id: string,
      carrier: string,
      trackingNumber: string
    ): Promise<{
      outcome: 'shipped' | 'already_shipped' | 'not_found' | 'invalid_transition' | 'fraud_hold'
      shipmentId?: string
    }> {
      // Early refusal; the database triggers (031) refuse the shipment and the status change regardless.
      if (await hasActiveFraudHold(sql, id)) return { outcome: 'fraud_hold' }
      let rows: any[]
      try {
        rows = await sql`
          SELECT mark_order_shipped(
            ${id}::uuid,
            ${carrier},
            ${trackingNumber}
          ) AS result
        ` as any[]
      } catch (err) {
        if (isFraudHoldDbError(err)) return { outcome: 'fraud_hold' }
        throw err
      }
      const result = (rows[0] as any).result as {
        outcome:        string
        shipment_id?:   string
        current_status?: string
      }
      return {
        outcome:    result.outcome as 'shipped' | 'already_shipped' | 'not_found' | 'invalid_transition',
        shipmentId: result.shipment_id,
      }
    },
  }
}

export type AdminOrderService = ReturnType<typeof createAdminOrderService>


/** Reads the immutable set snapshot of an order. Null when the order has no set. */
export async function loadOrderBundle(sql: any, orderId: string): Promise<AdminOrderBundle | null> {
  const heads = await sql`
    SELECT id, bundle_id, set_quantity, pricing_mode, pricing_value,
           component_subtotal_cents, bundle_discount_cents, bundle_net_cents
      FROM order_bundles WHERE order_id = ${orderId} LIMIT 1` as any[]
  if (!heads.length) return null
  const h = heads[0]
  const rows = await sql`
    SELECT order_item_id, sku, product_name, quantity, original_unit_price_cents,
           allocated_discount_cents, net_line_cents
      FROM order_bundle_items WHERE order_bundle_id = ${h.id} ORDER BY created_at, sku` as any[]
  return {
    bundleId: String(h.bundle_id), setQuantity: Number(h.set_quantity),
    pricingMode: String(h.pricing_mode), pricingValue: Number(h.pricing_value),
    componentSubtotalCents: Number(h.component_subtotal_cents),
    bundleDiscountCents: Number(h.bundle_discount_cents),
    bundleNetCents: Number(h.bundle_net_cents),
    lines: rows.map(r => ({
      orderItemId: String(r.order_item_id), sku: String(r.sku), productName: String(r.product_name),
      quantity: Number(r.quantity), originalUnitPriceCents: Number(r.original_unit_price_cents),
      allocatedDiscountCents: Number(r.allocated_discount_cents), netLineCents: Number(r.net_line_cents),
    })),
  }
}
