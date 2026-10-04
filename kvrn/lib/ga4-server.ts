// lib/ga4-server.ts — CANONICAL server-side GA4 purchase (Measurement Protocol).
//
// Sent from the Stripe webhook, from the finalized order — never from browser-supplied values and
// never from the browser at all (the success page sends NO GA purchase, so a duplicate is impossible).
//
// SAFETY CONTRACT (the order is already committed when this runs):
//   * It NEVER throws and NEVER blocks the webhook for longer than GA_SERVER_TIMEOUT_MS: the order
//     read, the payload build and the network call are raced against one hard timer, the fetch is
//     aborted on timeout, and a late rejection is swallowed.
//   * Missing / malformed GA configuration, missing client id, a non-USD or unpaid order, a DB
//     error, a network error, a non-2xx answer and a garbage response body are all just a logged,
//     non-PII "skipped". Stripe's retry semantics never depend on GA.
//   * GA4_MEASUREMENT_PROTOCOL_SECRET is read here only (server). It is never logged, never put in
//     a payload, never returned to a client. (The Measurement Protocol itself takes it as a query
//     parameter of the request to Google; that URL is never logged.)
//
// DELIVERY + DEDUPLICATION (this send is retried by design, so it must be idempotent):
//   1. The webhook calls this for 'order_created', 'already_processed' and 'already_had_order' —
//      every Stripe delivery that resolves to a paid, finalized order — so a first send that
//      timed out or failed HEALS on Stripe's retry/replay (same outcomes as the first-party
//      purchase_completed healing). It is never called for an unpaid/unfinalized order (no order id),
//      and buildGaPurchaseBody independently refuses anything whose payment_status is not 'paid'.
//   2. transaction_id is ALWAYS the canonical KVRN order number (never invented, never random per
//      attempt), so every attempt for one order carries the identical id and Google dedupes a
//      repeat of an already-received purchase.
//   3. The browser sends no purchase.
//   There is deliberately no ledger / migration: if Google already received the purchase, the
//   repeat is the same transaction_id and is collapsed by GA; if it did not, the repeat delivers it.
//
// PII: the payload is built only from catalog identifiers, product names, quantities, amounts and
// the order number. No name, email, phone, address, payment data, notes, discount code or user_id.

import type { NeonQueryFunction } from '@neondatabase/serverless'
import { withAnalyticsTimeout, ANALYTICS_TIMEOUT } from './funnel-analytics'
import {
  GA_CURRENCY, GA_MEASUREMENT_ID_RE, gaMoney, gaClientId, gaSessionId, readPublicGaMeasurementId,
  buildGaItem, safeLabel, allocateDiscountAcrossLines, gaNetUnitPrice, type GaItem, type GaAdminStatus,
} from './ga-common'

type Sql = NeonQueryFunction<false, false>

/** Measurement Protocol API secrets are short base64url-ish strings. Server-only: never logged, never sent to the browser. */
const GA_API_SECRET_RE = /^[A-Za-z0-9_-]{8,128}$/

/** Hard bound for the whole GA purchase send (order read + build + network). Same bound as the funnel writes. */
export const GA_SERVER_TIMEOUT_MS = 2500
export const GA_MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect'
const MAX_ITEMS = 50

export type GaConfig =
  | { ok: true; measurementId: string; apiSecret: string }
  | { ok: false; reason: 'missing' | 'malformed' }

/** Env -> validated config. Never returns the raw values on failure and never logs them. */
export function resolveGaConfig(env: Record<string, string | undefined> = process.env): GaConfig {
  const id = env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim()
  const secret = env.GA4_MEASUREMENT_PROTOCOL_SECRET?.trim()
  if (!id || !secret) return { ok: false, reason: 'missing' }
  if (!GA_MEASUREMENT_ID_RE.test(id) || !GA_API_SECRET_RE.test(secret)) return { ok: false, reason: 'malformed' }
  return { ok: true, measurementId: id, apiSecret: secret }
}

/** For the admin page: configuration STATE only. Never returns or logs the secret. */
export function describeGaConfig(env: Record<string, string | undefined> = process.env): GaAdminStatus {
  const id = env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim()
  const secret = env.GA4_MEASUREMENT_PROTOCOL_SECRET?.trim()
  const clientState = !id ? 'unset' : GA_MEASUREMENT_ID_RE.test(id) ? 'ok' : 'malformed'
  const secretState = !secret ? 'unset' : GA_API_SECRET_RE.test(secret) ? 'ok' : 'malformed'
  // The id shown here is produced by the SAME reader the browser config route uses
  // (readPublicGaMeasurementId), from the same RUNTIME variable — so the admin status and what a
  // consenting browser can actually initialise can never disagree.
  return { measurementId: clientState === 'ok' ? readPublicGaMeasurementId(env) : null, clientState, secretState }
}

export interface GaOrderRow {
  order_number: string | null
  currency: string | null
  payment_status: string | null
  subtotal_cents: number | null
  discount_cents: number | null
  shipping_cents: number | null
  tax_cents: number | null
  total_cents: number | null
}
export interface GaOrderItemRow {
  slug: string | null
  sku: string | null
  product_name: string | null
  quantity: number | null
  unit_price_cents: number | null
}

export interface GaPurchaseBody {
  client_id: string
  events: Array<{
    name: 'purchase'
    params: {
      session_id?: string
      engagement_time_msec: number
      transaction_id: string
      currency: 'USD'
      value: number
      shipping: number
      tax: number
      items: GaItem[]
    }
  }>
}

/**
 * How the item `price` fields were produced:
 *   'unit_price'          no merchandise discount: the order line's unit price is already the net price.
 *   'discount_allocated'  merchandise discount spread across lines (deterministic, integer cents).
 *   'omitted'             figures were inconsistent/unknown: item prices are left out (never fabricated);
 *                         the event `value` (canonical total - shipping - tax) is still sent.
 */
export type GaItemPricing = 'unit_price' | 'discount_allocated' | 'omitted'
export type BuildResult =
  | { ok: true; body: GaPurchaseBody; itemPricing: GaItemPricing; omitReason?: string }
  | { ok: false; reason: string }

const TXN_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Item prices that are consistent with the event `value`.
 *
 * AUDIT FACT (migrations 002/019/022 finalize_paid_order): order_items.unit_price_cents is the
 * PRE-discount reservation snapshot; the merchandise discount lives only on the order
 * (orders.discount_cents) and  total = max(0, subtotal - discount) + shipping + tax.
 * So sending unit_price_cents as the GA item price while `value` is net of the discount would make
 * item revenue exceed purchase revenue. Here the order's merchandise discount is allocated across
 * the lines (allocateDiscountAcrossLines) so  sum(price x quantity) == value  (to a rounding sliver
 * for fractional per-unit prices). A shipping-only discount is NOT a merchandise discount
 * (discount_cents stays 0; it is already inside shipping_cents), so it never reduces item revenue.
 *
 * Anything that does not reconcile exactly in integer cents yields NO item prices (never a guess).
 */
function priceItems(a: { order: GaOrderRow; items: GaOrderItemRow[]; valueCents: number }): {
  items: GaItem[]; pricing: GaItemPricing; omitReason?: string
} {
  const base = a.items.slice(0, MAX_ITEMS).map(i => ({
    row: i,
    item: buildGaItem({ slug: i.slug ?? i.sku, name: i.product_name, sku: i.sku, priceCents: null, quantity: Number(i.quantity) }),
  }))
  const items = base.filter(b => b.item !== null)
  const omit = (reason: string) => ({ items: items.map(b => b.item as GaItem), pricing: 'omitted' as const, omitReason: reason })

  const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (a.items.length > MAX_ITEMS) return omit('too_many_items')
  if (items.length !== a.items.length) return omit('item_invalid')
  if (!items.every(b => isInt(b.row.unit_price_cents))) return omit('item_price_unknown')
  if (!isInt(a.order.subtotal_cents) || !isInt(a.order.discount_cents)) return omit('order_discount_unknown')

  const gross = items.map(b => (b.row.unit_price_cents as number) * Number(b.row.quantity))
  const sum = gross.reduce((x, y) => x + y, 0)
  if (!Number.isSafeInteger(sum) || sum !== a.order.subtotal_cents) return omit('lines_do_not_sum_to_subtotal')
  if (a.order.discount_cents > a.order.subtotal_cents) return omit('discount_exceeds_subtotal')
  const merchNet = a.order.subtotal_cents - a.order.discount_cents
  if (merchNet !== a.valueCents) return omit('value_mismatch')

  const net = allocateDiscountAcrossLines(gross, a.order.discount_cents)
  if (!net) return omit('allocation_failed')
  const out: GaItem[] = []
  for (let i = 0; i < items.length; i++) {
    const price = gaNetUnitPrice(net[i], Number(items[i].row.quantity))
    if (price === null) return omit('price_invalid')
    out.push({ ...(items[i].item as GaItem), price })
  }
  return { items: out, pricing: a.order.discount_cents === 0 ? 'unit_price' : 'discount_allocated' }
}

/**
 * Pure. Canonical order -> Measurement Protocol body.
 *   value    = total_cents - shipping_cents - tax_cents  (GA4 convention: merchandise revenue net of
 *              discounts; shipping and tax are reported in their own parameters, not inside value)
 *   shipping = shipping_cents, tax = tax_cents, all converted from integer cents ONLY by gaMoney().
 * Anything invalid (currency, an unknown amount, no items) is refused rather than guessed or zeroed.
 */
export function buildGaPurchaseBody(a: {
  orderId: string
  order: GaOrderRow
  items: GaOrderItemRow[]
  clientId: unknown
  sessionId?: unknown
}): BuildResult {
  const clientId = gaClientId(a.clientId)
  if (!clientId) return { ok: false, reason: 'no_client_id' }
  const o = a.order
  if (o.payment_status !== 'paid') return { ok: false, reason: 'not_paid' }
  if ((o.currency ?? '').toLowerCase() !== 'usd') return { ok: false, reason: 'currency' }

  const total = o.total_cents, ship = o.shipping_cents, tax = o.tax_cents
  if (![total, ship, tax].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
    return { ok: false, reason: 'amount_unknown' }
  }
  const valueCents = (total as number) - (ship as number) - (tax as number)
  const value = gaMoney(valueCents)
  const shipping = gaMoney(ship), taxAmt = gaMoney(tax)
  if (value === null || shipping === null || taxAmt === null) return { ok: false, reason: 'amount_invalid' }

  const priced = priceItems({ order: o, items: a.items, valueCents })
  const items = priced.items
  if (!items.length) return { ok: false, reason: 'no_items' }

  // The canonical KVRN order number is the GA transaction_id; fall back to the order uuid.
  const txn = o.order_number && TXN_RE.test(o.order_number) ? o.order_number : (TXN_RE.test(a.orderId) ? a.orderId : null)
  if (!txn) return { ok: false, reason: 'no_transaction_id' }

  const sessionId = gaSessionId(a.sessionId)
  return {
    ok: true,
    body: {
      client_id: clientId,
      events: [{
        name: 'purchase',
        params: {
          ...(sessionId ? { session_id: sessionId } : {}),
          engagement_time_msec: 100,
          transaction_id: txn,
          currency: GA_CURRENCY,
          value, shipping, tax: taxAmt,
          items,
        },
      }],
    },
    itemPricing: priced.pricing,
    ...(priced.omitReason ? { omitReason: priced.omitReason } : {}),
  }
}

export type GaSendOutcome = 'sent' | 'skipped' | 'error' | 'timeout'

/**
 * Read the finalized order, build the canonical body and POST it. Resolves (never rejects, never
 * hangs past the bound) with what happened. `fetchImpl`, `env` and `timeoutMs` are injectable for tests.
 */
export async function tryRecordGaPurchase(
  sql: Sql,
  a: {
    orderId: string
    gaClientId?: unknown
    gaSessionId?: unknown
    env?: Record<string, string | undefined>
    fetchImpl?: typeof fetch
    timeoutMs?: number
  },
): Promise<GaSendOutcome> {
  const timeoutMs = a.timeoutMs ?? GA_SERVER_TIMEOUT_MS
  try {
    const cfg = resolveGaConfig(a.env ?? process.env)
    if (!cfg.ok) {
      console.error(`[ga4] purchase skipped (non-fatal): GA4 server configuration ${cfg.reason}`)
      return 'skipped'
    }
    // No consented GA client id => this visitor was not running GA (declined / DNT / GPC / blocked).
    if (!gaClientId(a.gaClientId)) {
      console.log('[ga4] purchase skipped: no GA client id for this order (no analytics consent or GA not running)')
      return 'skipped'
    }

    const controller = new AbortController()
    const doFetch = a.fetchImpl ?? fetch
    const work = (async (): Promise<GaSendOutcome> => {
      const [orderRows, itemRows] = await Promise.all([
        sql`SELECT order_number, currency, payment_status, subtotal_cents, discount_cents,
                   shipping_cents, tax_cents, total_cents
            FROM orders WHERE id = ${a.orderId}::uuid` as unknown as Promise<GaOrderRow[]>,
        sql`SELECT p.slug AS slug, oi.sku AS sku, oi.product_name AS product_name,
                   oi.quantity AS quantity, oi.unit_price_cents AS unit_price_cents
            FROM order_items oi
            LEFT JOIN product_variants v ON v.id = oi.variant_id
            LEFT JOIN products p ON p.id = v.product_id
            WHERE oi.order_id = ${a.orderId}::uuid
            ORDER BY oi.created_at, oi.id` as unknown as Promise<GaOrderItemRow[]>,
      ])
      if (!orderRows[0]) { console.error('[ga4] purchase skipped (non-fatal): order not found'); return 'skipped' }
      const built = buildGaPurchaseBody({
        orderId: a.orderId, order: orderRows[0], items: itemRows,
        clientId: a.gaClientId, sessionId: a.gaSessionId,
      })
      if (!built.ok) { console.error(`[ga4] purchase skipped (non-fatal): ${built.reason}`); return 'skipped' }
      if (built.itemPricing === 'omitted') console.error(`[ga4] purchase item prices omitted (non-fatal): ${built.omitReason}`)

      const url = `${GA_MP_ENDPOINT}?measurement_id=${encodeURIComponent(cfg.measurementId)}&api_secret=${encodeURIComponent(cfg.apiSecret)}`
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
        signal: controller.signal,
      })
      // The Measurement Protocol answers 2xx (normally 204, empty) for anything it receives. The
      // body is deliberately never read or parsed: a malformed response cannot affect anything.
      const status = Number((res as any)?.status)
      if (status >= 200 && status < 300) return 'sent'
      console.error(`[ga4] purchase not accepted (non-fatal): HTTP ${Number.isFinite(status) ? status : 'unknown'}`)
      return 'error'
    })()

    const r = await withAnalyticsTimeout(work, timeoutMs)
    if (r === ANALYTICS_TIMEOUT) {
      try { controller.abort() } catch { /* ignore */ }
      console.error(`[ga4] purchase skipped (non-fatal): timed out after ${timeoutMs}ms`)
      return 'timeout'
    }
    return r
  } catch (e: any) {
    // Message only, truncated, and never anything that could contain the request URL.
    const msg = safeLabel(String(e?.name ?? 'Error'), 40) ?? 'Error'
    console.error(`[ga4] purchase skipped (non-fatal): ${msg}`)
    return 'error'
  }
}
