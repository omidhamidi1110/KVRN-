// lib/reservations.ts — calls PL/pgSQL functions for true atomicity.
// Uses injectable SQL executor for testability.
// Production: uses global DATABASE_URL client (imported at bottom).
// Tests:      createReservationService(neon(TEST_DATABASE_URL)).

import type { NeonQueryFunction } from '@neondatabase/serverless'

const PROVISIONAL_TTL_MINUTES = 35
const MAX_QTY_PER_SKU         = 10

export interface LineItemInput { sku: string; quantity: number }

export interface ReservationItemSnapshot {
  variantId:      string
  sku:            string
  productName:    string
  size:           string
  color:          string
  unitPriceCents: number
  quantity:       number
}

export interface ReservationResult {
  ok:            true
  reservationId: string
  expiresAt:     Date
  items:         ReservationItemSnapshot[]
}

export type ReservationErrCode =
  | 'EMPTY_CART' | 'INVALID_SKU' | 'INVALID_QUANTITY' | 'INACTIVE_VARIANT'
  | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | 'DUPLICATE_SKU'
  | 'ITEM_UNAVAILABLE' | 'DB_ERROR' | 'CONFIG_ERROR'

export interface ReservationErr {
  ok:      false
  code:    ReservationErrCode
  message: string
  sku?:    string
}

/** Aggregate duplicate SKUs and validate inputs before the DB call. */
export function aggregateAndValidate(
  items: LineItemInput[]
): LineItemInput[] | ReservationErr {
  if (!items || items.length === 0) {
    return { ok: false, code: 'EMPTY_CART', message: 'Cart is empty.' }
  }
  const map = new Map<string, number>()
  for (const { sku, quantity } of items) {
    if (!sku || typeof sku !== 'string' || !sku.startsWith('KVRN-')) {
      return { ok: false, code: 'INVALID_SKU', message: `Invalid SKU: ${sku}`, sku }
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, code: 'INVALID_QUANTITY',
               message: `Quantity for ${sku} must be a positive integer.`, sku }
    }
    map.set(sku, (map.get(sku) ?? 0) + quantity)
  }
  for (const [sku, qty] of map) {
    if (qty > MAX_QTY_PER_SKU) {
      return { ok: false, code: 'INVALID_QUANTITY',
               message: `Maximum ${MAX_QTY_PER_SKU} per item (${sku}).`, sku }
    }
  }
  return Array.from(map.entries()).map(([sku, quantity]) => ({ sku, quantity }))
}

/** Parse a KVRN_RESERVATION|CODE|sku error message from PL/pgSQL. */
export function parseDbErr(msg: string): ReservationErr {
  const m = msg.match(/KVRN_RESERVATION\|([^|]+)\|(.*)/)
  if (!m) return { ok: false, code: 'DB_ERROR', message: 'Reservation failed. Please try again.' }
  const raw  = m[1] as string
  const info = m[2]?.trim() ?? ''

  // Normalise DB codes to TypeScript union
  const codeMap: Record<string, ReservationErrCode> = {
    INVALID_SKU:          'INVALID_SKU',
    SKU_NOT_FOUND:        'INVALID_SKU',      // alias — keep union consistent
    INACTIVE_VARIANT:     'INACTIVE_VARIANT',
    OUT_OF_STOCK:         'OUT_OF_STOCK',
    INSUFFICIENT_STOCK:   'INSUFFICIENT_STOCK',
    DUPLICATE_SKU:        'DUPLICATE_SKU',
    INVALID_QUANTITY:     'INVALID_QUANTITY',
    INVALID_INPUT:        'INVALID_QUANTITY',
    INVARIANT_VIOLATION:  'DB_ERROR',
    ATTACH_FAILED:        'DB_ERROR',
  }
  const code = codeMap[raw] ?? 'DB_ERROR'
  // Never expose raw SKU in the customer-facing message.
  // The caller may use `sku` to look up display info from the cart.
  let message = 'An item in your bag is unavailable. Please try again.'
  if (code === 'OUT_OF_STOCK' || code === 'INSUFFICIENT_STOCK') {
    message = 'An item in your bag is sold out.'
  }
  if (code === 'INACTIVE_VARIANT')  message = 'An item in your bag is no longer available.'
  if (code === 'INVALID_SKU')       message = 'An item in your bag could not be found.'
  if (code === 'DUPLICATE_SKU')     message = 'Duplicate items in your bag.'
  if (code === 'INVALID_QUANTITY')  message = 'Invalid quantity for an item in your bag.'
  return { ok: false, code, message, sku: info || undefined }
}

// ── Injectable service factory ───────────────────────────────────────────────

export interface ReservationService {
  reserveInventory(items: LineItemInput[]): Promise<ReservationResult | ReservationErr>
  attachStripeSession(reservationId: string, sessionId: string, expiresAtUnix: number): Promise<void>
  failReservation(reservationId: string, reason: string): Promise<'released'|'already_released'|'not_found'>
  releaseReservationForEvent(sessionId: string, eventId: string, eventType: string, reason: string): Promise<{ result: string }>
  finalizePaidOrder(opts: FinalizePaidOrderOpts): Promise<FinalizePaidOrderResult>
  markAwaitingPayment(sessionId: string, eventId: string, eventType: string): Promise<string>
  releaseExpiredReservations(): Promise<number>
  webhookEventProcessed(eventId: string): Promise<boolean>
  saveReservationCheckoutDetails(reservationId: string, details: CheckoutDetails): Promise<boolean>
}

export interface FinalizePaidOrderOpts {
  stripeSessionId:       string
  reservationIdHint:     string | null
  stripePaymentIntent:   string
  stripeEventId:         string
  eventType:             string
  currency:              string
  amountTotal:           number
  customerEmail:         string | null
  customerName:          string | null
  customerPhone:         string | null
  shippingAddress:       Record<string, any> | null
}

export interface FinalizePaidOrderResult {
  outcome:         string
  orderId?:        string
  orderNumber?:    string
  alreadyProcessed: boolean
}

export interface CheckoutDetails {
  customerEmail:              string
  customerName:               string
  customerPhone:              string | null
  shippingAddress:            Record<string, string>
  shippingMethod:             'standard' | 'express'
  // Shipping snapshot: before discount, reduction, and final charged amount
  shippingBeforeDiscountCents: number
  shippingDiscountCents:       number
  shippingFinalCents:          number
  // Merchandise/order discount only (never shipping code)
  discountId?:                string | null
  discountCode?:              string | null
  discountType?:              string | null
  discountCents?:             number
}

export function createReservationService(sql: NeonQueryFunction<false, false>): ReservationService {
  return {

    async reserveInventory(items) {
      const aggregated = aggregateAndValidate(items)
      if (!Array.isArray(aggregated)) return aggregated

      if (aggregated.length === 0) {
        return { ok: false, code: 'EMPTY_CART', message: 'Cart is empty.' }
      }

      const expiresAt = new Date(Date.now() + PROVISIONAL_TTL_MINUTES * 60 * 1000)
      const itemsJson = JSON.stringify(aggregated)

      try {
        const rows = await sql`
          SELECT reserve_inventory(${itemsJson}::jsonb, ${expiresAt.toISOString()}::timestamptz) AS result
        `
        const r: any = (rows[0] as any).result
        const parsed = typeof r === 'string' ? JSON.parse(r) : r

        const snapshots: ReservationItemSnapshot[] = (parsed.items ?? []).map((i: any) => ({
          variantId:      i.variant_id,
          sku:            i.sku,
          productName:    i.product_name,
          size:           i.size,
          color:          i.color,
          unitPriceCents: Number(i.unit_price_cents),
          quantity:       Number(i.quantity),
        }))

        return {
          ok:            true,
          reservationId: parsed.reservation_id,
          expiresAt,
          items:         snapshots,
        }
      } catch (err: any) {
        const msg: string = err?.message ?? ''
        if (msg.includes('KVRN_RESERVATION|')) return parseDbErr(msg)
        console.error('reserveInventory DB error:', msg)
        return { ok: false, code: 'DB_ERROR', message: 'Reservation failed. Please try again.' }
      }
    },

    async attachStripeSession(reservationId, sessionId, expiresAtUnix) {
      await sql`
        SELECT attach_stripe_session(${reservationId}::uuid, ${sessionId}, ${expiresAtUnix}::bigint)
      `
    },

    async failReservation(reservationId, reason) {
      // Returns typed outcome — throws on real DB error
      const rows = await sql`SELECT release_reservation_by_id(${reservationId}::uuid, ${reason}) AS result`
      const result: string = (rows[0] as any).result
      return result as 'released' | 'already_released' | 'not_found'
    },

    async releaseReservationForEvent(sessionId, eventId, eventType, reason) {
      const rows = await sql`
        SELECT release_reservation_for_event(${sessionId}, ${eventId}, ${eventType}, ${reason}) AS result
      `
      return { result: (rows[0] as any).result }
    },

    async finalizePaidOrder(opts) {
      const {
        stripeSessionId, reservationIdHint, stripePaymentIntent,
        stripeEventId, eventType, currency, amountTotal,
        customerEmail, customerName, customerPhone, shippingAddress,
      } = opts

      const rows = await sql`
        SELECT finalize_paid_order(
          ${stripeSessionId},
          ${reservationIdHint ?? null}::uuid,
          ${stripePaymentIntent ?? null},
          ${stripeEventId},
          ${eventType},
          ${currency},
          ${amountTotal}::integer,
          ${customerEmail ?? null},
          ${customerName  ?? null},
          ${customerPhone ?? null},
          ${shippingAddress ? JSON.stringify(shippingAddress) : null}::jsonb
        ) AS result
      `
      const r: any = (rows[0] as any).result
      const p = typeof r === 'string' ? JSON.parse(r) : r
      return {
        outcome:          p.outcome,
        orderId:          p.order_id   ?? undefined,
        orderNumber:      p.order_number ?? undefined,
        alreadyProcessed: Boolean(p.already_processed),
      }
    },

    async markAwaitingPayment(sessionId, eventId, eventType) {
      const rows = await sql`SELECT mark_awaiting_payment(${sessionId}, ${eventId}, ${eventType}) AS result`
      return (rows[0] as any).result
    },

    async releaseExpiredReservations() {
      const rows = await sql`SELECT release_expired_reservations() AS released`
      return Number((rows[0] as any).released)
    },

    async webhookEventProcessed(eventId) {
      const rows = await sql`
        SELECT 1 FROM webhook_events WHERE stripe_event_id=${eventId} AND processed=true LIMIT 1
      `
      return rows.length > 0
    },

    async saveReservationCheckoutDetails(reservationId, details) {
      const { customerEmail, customerName, customerPhone, shippingAddress, shippingMethod,
              shippingBeforeDiscountCents, shippingDiscountCents, shippingFinalCents,
              discountId, discountCode, discountType, discountCents } = details
      const rows = await sql`
        SELECT save_reservation_checkout_details(
          ${reservationId}::uuid,
          ${customerEmail},
          ${customerName},
          ${customerPhone ?? null},
          ${JSON.stringify(shippingAddress)}::jsonb,
          ${shippingMethod},
          ${shippingBeforeDiscountCents ?? 0}::integer,
          ${shippingDiscountCents ?? 0}::integer,
          ${shippingFinalCents ?? 0}::integer,
          ${discountId ?? null}::uuid,
          ${discountCode ?? null},
          ${discountType ?? null},
          ${discountCents ?? 0}::integer
        ) AS result
      `
      return Boolean((rows[0] as any).result)
    },
  }
}

// ── Production singletons (use DATABASE_URL automatically) ───────────────────

let _svc: ReservationService | null = null

// Static production SQL import (Cloudflare Workers compatible)
import { sql as productionSql } from './db'

function getProductionService(): ReservationService {
  if (!_svc) {
    _svc = createReservationService(productionSql)
  }
  return _svc
}

export const reserveInventory       = (...a: Parameters<ReservationService['reserveInventory']>)       => getProductionService().reserveInventory(...a)
export const attachStripeSession    = (...a: Parameters<ReservationService['attachStripeSession']>)    => getProductionService().attachStripeSession(...a)
export const failReservation        = (...a: Parameters<ReservationService['failReservation']>)        => getProductionService().failReservation(...a)
export const releaseReservationForEvent = (...a: Parameters<ReservationService['releaseReservationForEvent']>) => getProductionService().releaseReservationForEvent(...a)
export const finalizePaidOrder      = (...a: Parameters<ReservationService['finalizePaidOrder']>)      => getProductionService().finalizePaidOrder(...a)
export const markAwaitingPayment    = (...a: Parameters<ReservationService['markAwaitingPayment']>)    => getProductionService().markAwaitingPayment(...a)
export const releaseExpiredReservations = (...a: Parameters<ReservationService['releaseExpiredReservations']>) => getProductionService().releaseExpiredReservations(...a)
export const webhookEventProcessed  = (...a: Parameters<ReservationService['webhookEventProcessed']>)  => getProductionService().webhookEventProcessed(...a)
export const saveReservationCheckoutDetails = (...a: Parameters<ReservationService['saveReservationCheckoutDetails']>) => getProductionService().saveReservationCheckoutDetails(...a)
