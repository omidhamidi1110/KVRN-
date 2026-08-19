// lib/refunds.ts — refund recording
// Server-only. Thin wrapper over the idempotent record_order_refund SQL function.
//
// WHAT A REFUND DOES AND DOES NOT MEAN
// Recording a refund reduces recognised revenue. It deliberately does NOT assume:
//   * that Stripe returned its processing fee — fee_refunded_cents stays NULL unless
//     Stripe actually reports one on the refund's balance transaction
//   * that the product came back — no inventory movement is created, because KVRN has
//     no returns-received workflow yet. Restocking must be an explicit admin action.
//   * that outbound shipping cost was recovered — the label was already paid for
//
// Encoding any of those assumptions would silently corrupt both inventory and profit.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export interface RecordRefundInput {
  stripeRefundId:  string
  paymentIntentId: string
  chargeId?:       string | null
  amountCents:     number
  currency?:       string
  status:          'pending' | 'succeeded' | 'failed' | 'canceled'
  reason?:         string | null
  feeRefundedCents?: number | null
  refundedAt?:     string | null
}

export interface RecordRefundResult {
  outcome: 'recorded' | 'updated' | 'no_order' | 'ignored_zero_amount'
  orderId?: string
  refundedTotal?: number
  fullyRefunded?: boolean
}

/**
 * Record (or update) a refund. Safe to call repeatedly with the same refund id —
 * Stripe retries webhooks and the same event may arrive many times.
 */
export async function recordOrderRefund(
  sql: NeonQueryFunction<false, false>,
  input: RecordRefundInput,
): Promise<RecordRefundResult> {
  const rows = await sql`
    SELECT record_order_refund(
      ${input.stripeRefundId},
      ${input.paymentIntentId},
      ${input.chargeId ?? null},
      ${input.amountCents},
      ${input.currency ?? 'usd'},
      ${input.status},
      ${input.reason ?? null},
      ${input.feeRefundedCents ?? null},
      ${input.refundedAt ?? null}::timestamptz
    ) AS result
  `
  const result = (rows as any[])[0]?.result ?? {}
  return {
    outcome:       result.outcome ?? 'no_order',
    orderId:       result.order_id,
    refundedTotal: result.refunded_total,
    fullyRefunded: result.fully_refunded,
  }
}

/** Map a Stripe refund status onto the values allowed by the order_refunds CHECK. */
export function normalizeRefundStatus(raw: unknown): RecordRefundInput['status'] {
  const s = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (s === 'succeeded') return 'succeeded'
  if (s === 'failed')    return 'failed'
  if (s === 'canceled' || s === 'cancelled') return 'canceled'
  return 'pending'
}

/** Refunds recorded against an order, newest first. */
export async function listRefundsForOrder(
  sql: NeonQueryFunction<false, false>,
  orderId: string,
) {
  const rows = await sql`
    SELECT id, stripe_refund_id AS "stripeRefundId", amount_cents AS "amountCents",
           fee_refunded_cents AS "feeRefundedCents", status, reason,
           refunded_at AS "refundedAt", created_at AS "createdAt"
    FROM order_refunds
    WHERE order_id = ${orderId}::uuid
    ORDER BY created_at DESC
  `
  return (rows as any[]).map(r => ({
    id:               r.id,
    stripeRefundId:   r.stripeRefundId,
    amountCents:      Number(r.amountCents),
    feeRefundedCents: r.feeRefundedCents === null ? null : Number(r.feeRefundedCents),
    status:           r.status,
    reason:           r.reason,
    refundedAt:       r.refundedAt ? new Date(r.refundedAt).toISOString() : null,
    createdAt:        new Date(r.createdAt).toISOString(),
  }))
}
