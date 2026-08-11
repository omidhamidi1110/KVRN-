// lib/admin-orders.ts — Admin order management service
// Injectable SQL for testability. No public API exposure.
// V51.2: list, detail, count, and unfulfilled→processing transition only.

import type { NeonQueryFunction } from '@neondatabase/serverless'

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

export interface AdminOrderDetail extends AdminOrderRow {
  customerPhone:   string | null
  shippingAddress: Record<string, string | null> | null
  items:           AdminOrderItem[]
  shipment:        ShipmentInfo | null
}

export interface ListOrdersParams {
  paymentStatus?:     string
  fulfillmentStatus?: string
  search?:            string
  limit:              number
  offset:             number
}

export const VALID_PAYMENT_STATUSES     = ['pending','paid','failed','refunded'] as const
export const VALID_FULFILLMENT_STATUSES = ['unfulfilled','processing','shipped','delivered','cancelled'] as const
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Service factory ───────────────────────────────────────────────────────────

export function createAdminOrderService(sql: NeonQueryFunction<false, false>) {
  return {

    async listOrders(params: ListOrdersParams): Promise<AdminOrderRow[]> {
      const { paymentStatus, fulfillmentStatus, search, limit, offset } = params

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

      return {
        ...o,
        itemCount:     (countRow as any).itemCount    ?? 0,
        quantityCount: (countRow as any).quantityCount ?? 0,
        items: items as AdminOrderItem[],
        shipment,
      }
    },

    /** V51.2: only unfulfilled → processing. Returns outcome string. */
    async transitionToProcessing(id: string): Promise<
      'updated' | 'already_processing' | 'not_found' | 'conflict'
    > {
      const rows = await sql`SELECT fulfillment_status FROM orders WHERE id=${id}`
      if (rows.length === 0) return 'not_found'

      const current = (rows[0] as any).fulfillment_status
      if (current === 'processing') return 'already_processing'
      if (current !== 'unfulfilled') return 'conflict'

      const updated = await sql`
        UPDATE orders SET fulfillment_status='processing', updated_at=NOW()
        WHERE id=${id} AND fulfillment_status='unfulfilled'
        RETURNING id
      `
      if (updated.length === 0) return 'already_processing'
      return 'updated'
    },

    /** V51.3: processing → shipped. Calls mark_order_shipped() atomically. */
    async markOrderShipped(
      id: string,
      carrier: string,
      trackingNumber: string
    ): Promise<{
      outcome: 'shipped' | 'already_shipped' | 'not_found' | 'invalid_transition'
      shipmentId?: string
    }> {
      const rows = await sql`
        SELECT mark_order_shipped(
          ${id}::uuid,
          ${carrier},
          ${trackingNumber}
        ) AS result
      `
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
