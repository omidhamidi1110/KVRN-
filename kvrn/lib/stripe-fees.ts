// lib/stripe-fees.ts — actual Stripe processing fee reconciliation
// Server-only.
//
// WHY THIS IS NOT DONE INSIDE finalize_paid_order:
// Stripe does not attach a balance_transaction to a charge until the charge settles.
// At checkout.session.completed the fee is frequently not yet available. Blocking or
// failing order creation to wait for it would be unacceptable, so fee capture is a
// SEPARATE, RETRYABLE, IDEMPOTENT enrichment step.
//
// The fee is ALWAYS the real number from Stripe's balance transaction. It is never
// estimated from a percentage. Until it is retrieved, orders.stripe_fee_cents stays
// NULL and the financial layer reports the order as "partially reconciled" rather
// than inventing a plausible-looking profit figure.

import type { NeonQueryFunction } from '@neondatabase/serverless'

export interface FeeEnrichmentResult {
  outcome:
    | 'enriched'        // fee retrieved and stored
    | 'already_known'   // another attempt won the race; nothing to do
    | 'not_settled'     // balance transaction not available yet — retry later
    | 'no_payment_intent'
    | 'error'
  feeCents?: number
  message?:  string
}

/**
 * Retrieve and store the actual Stripe fee for one order.
 *
 * Stripe path: PaymentIntent -> latest_charge -> balance_transaction -> fee
 *
 * IDEMPOTENCY: the UPDATE carries `AND stripe_fee_cents IS NULL`, so a duplicate or
 * concurrent run can never overwrite or double-apply a fee. A retry after success is
 * a no-op that reports 'already_known'.
 */
export async function reconcileStripeFeeForOrder(opts: {
  sql:      NeonQueryFunction<false, false>
  stripe:   any
  orderId:  string
}): Promise<FeeEnrichmentResult> {
  const { sql, stripe, orderId } = opts

  const rows = await sql`
    SELECT id, stripe_payment_intent_id AS "paymentIntentId", stripe_fee_cents AS "feeCents"
    FROM orders WHERE id = ${orderId}::uuid
  `
  const order = (rows as any[])[0]
  if (!order) return { outcome: 'error', message: 'Order not found.' }
  if (order.feeCents !== null && order.feeCents !== undefined) {
    return { outcome: 'already_known', feeCents: Number(order.feeCents) }
  }
  if (!order.paymentIntentId) {
    return { outcome: 'no_payment_intent' }
  }

  let chargeId: string | null = null
  let balanceTxnId: string | null = null
  let feeCents: number | null = null

  try {
    const pi = await stripe.paymentIntents.retrieve(order.paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    })

    const charge = pi?.latest_charge
    if (charge && typeof charge === 'object') {
      chargeId = charge.id ?? null
      const bt = charge.balance_transaction
      if (bt && typeof bt === 'object' && typeof bt.fee === 'number') {
        balanceTxnId = bt.id ?? null
        feeCents     = bt.fee
      }
    }
  } catch (err: any) {
    const message = String(err?.message ?? '').slice(0, 200)
    await sql`
      UPDATE orders
      SET stripe_fee_attempts   = stripe_fee_attempts + 1,
          stripe_fee_last_error = ${message},
          updated_at            = NOW()
      WHERE id = ${orderId}::uuid AND stripe_fee_cents IS NULL
    `
    return { outcome: 'error', message }
  }

  // Charge exists but has not settled into a balance transaction yet.
  if (feeCents === null) {
    await sql`
      UPDATE orders
      SET stripe_charge_id      = COALESCE(${chargeId}, stripe_charge_id),
          stripe_fee_attempts   = stripe_fee_attempts + 1,
          stripe_fee_last_error = NULL,
          updated_at            = NOW()
      WHERE id = ${orderId}::uuid AND stripe_fee_cents IS NULL
    `
    return { outcome: 'not_settled' }
  }

  // Idempotent write: only the first successful reconciliation takes effect.
  const updated = await sql`
    UPDATE orders
    SET stripe_fee_cents              = ${feeCents},
        stripe_fee_source             = 'stripe_api',
        stripe_charge_id              = COALESCE(${chargeId}, stripe_charge_id),
        stripe_balance_transaction_id = ${balanceTxnId},
        stripe_fee_reconciled_at      = NOW(),
        stripe_fee_last_error         = NULL,
        updated_at                    = NOW()
    WHERE id = ${orderId}::uuid AND stripe_fee_cents IS NULL
    RETURNING id
  `

  if ((updated as any[]).length === 0) {
    return { outcome: 'already_known', feeCents }
  }
  return { outcome: 'enriched', feeCents }
}

/**
 * Batch reconciliation for the cron job.
 *
 * Only considers orders paid more than `minAgeMinutes` ago, because a just-created
 * charge is almost never settled. Attempts are capped so a permanently broken order
 * cannot be retried forever every five minutes.
 */
export async function reconcilePendingStripeFees(opts: {
  sql:            NeonQueryFunction<false, false>
  stripe:         any
  limit?:         number
  minAgeMinutes?: number
  maxAttempts?:   number
}): Promise<{ processed: number; enriched: number; notSettled: number; failed: number }> {
  const { sql, stripe } = opts
  const limit         = opts.limit         ?? 20
  const minAgeMinutes = opts.minAgeMinutes ?? 10
  const maxAttempts   = opts.maxAttempts   ?? 12

  const rows = await sql`
    SELECT id FROM orders
    WHERE stripe_fee_cents IS NULL
      AND paid_at IS NOT NULL
      AND paid_at < NOW() - (${minAgeMinutes}::text || ' minutes')::interval
      AND stripe_payment_intent_id IS NOT NULL
      AND stripe_fee_attempts < ${maxAttempts}
    ORDER BY paid_at ASC
    LIMIT ${limit}
  `

  let enriched = 0, notSettled = 0, failed = 0
  for (const row of rows as any[]) {
    try {
      const result = await reconcileStripeFeeForOrder({ sql, stripe, orderId: row.id })
      if (result.outcome === 'enriched')          enriched++
      else if (result.outcome === 'not_settled')  notSettled++
      else if (result.outcome === 'error')        failed++
    } catch {
      failed++
    }
  }

  return { processed: (rows as any[]).length, enriched, notSettled, failed }
}
