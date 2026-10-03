// lib/payment-exceptions.ts — admin read/resolve access to payment_exceptions (migration 022).
//
// A payment exception is a Stripe payment KVRN received but could not safely turn into an
// order (stock gone after a late webhook, no matching reservation, unexpected reservation
// state). It has NO order, so it creates no revenue, COGS, fee or affiliate recognition.
// The only way to close one is resolve_payment_exception(), which requires a resolution and
// a note and writes admin_audit_logs in the same transaction.
//
// RESOLUTION PATH
//   refunded            issue the refund in the Stripe Dashboard (or API) FIRST, then mark it.
//   fulfilled_manually  the order was fulfilled outside KVRN's order system; note how.
//   dismissed           not a customer payment KVRN owes anything for; note why.

export type PaymentExceptionResolution = 'refunded' | 'fulfilled_manually' | 'dismissed'
export const PAYMENT_EXCEPTION_RESOLUTIONS: readonly PaymentExceptionResolution[] =
  ['refunded', 'fulfilled_manually', 'dismissed']

export type PaymentExceptionFilter = 'open' | 'resolved' | 'all'

type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>

export interface PaymentExceptionRow {
  id:                       string
  stripeCheckoutSessionId:  string
  stripePaymentIntentId:    string | null
  reservationId:            string | null
  reason:                   string
  status:                   'open' | 'resolved'
  resolution:               PaymentExceptionResolution | null
  resolutionNote:           string | null
  resolvedBy:               string | null
  resolvedAt:               string | null
  amountCents:              number
  currency:                 string
  customerEmail:            string | null
  customerName:             string | null
  shippingAddress:          unknown
  detail:                   unknown
  createdAt:                string
}

export type ResolveOutcome = 'resolved' | 'already_resolved' | 'conflict' | 'not_found'

export function createPaymentExceptionService(sql: SqlFn) {
  return {
    async list(filter: PaymentExceptionFilter = 'open', limit = 100): Promise<PaymentExceptionRow[]> {
      const lim = Math.min(Math.max(1, Math.trunc(limit) || 100), 500)
      const status = filter === 'all' ? null : filter
      const rows = await sql`
        SELECT id,
               stripe_checkout_session_id AS "stripeCheckoutSessionId",
               stripe_payment_intent_id   AS "stripePaymentIntentId",
               reservation_id             AS "reservationId",
               reason, status, resolution,
               resolution_note            AS "resolutionNote",
               resolved_by                AS "resolvedBy",
               resolved_at                AS "resolvedAt",
               amount_cents               AS "amountCents",
               currency,
               customer_email             AS "customerEmail",
               customer_name              AS "customerName",
               shipping_address           AS "shippingAddress",
               detail,
               created_at                 AS "createdAt"
        FROM payment_exceptions
        WHERE (${status}::text IS NULL OR status = ${status}::text)
        ORDER BY created_at DESC
        LIMIT ${lim}
      `
      return (rows as any[]).map(r => ({ ...r, amountCents: Number(r.amountCents) }))
    },

    async resolve(
      id: string, resolution: PaymentExceptionResolution, note: string, actorEmail: string,
    ): Promise<{ outcome: ResolveOutcome; resolution?: string }> {
      const rows = await sql`
        SELECT resolve_payment_exception(${id}::uuid, ${resolution}, ${note}, ${actorEmail}) AS result
      `
      const r: any = (rows[0] as any).result
      return typeof r === 'string' ? JSON.parse(r) : r
    },
  }
}
