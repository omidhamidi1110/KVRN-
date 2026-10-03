import { type NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/stripe-client'
import {
  finalizePaidOrder,
  releaseReservationForEvent,
  markAwaitingPayment,
} from '@/lib/reservations'
import { sql } from '@/lib/db'
import { processPendingTransactionalEmails } from '@/lib/transactional-email'
import { releaseDiscountClaim } from '@/lib/discounts'
import { getEmailProvider } from '@/lib/resend-adapter'
import { recordOrderRefund, normalizeRefundStatus } from '@/lib/refunds'
import { createDisputesService } from '@/lib/disputes'
import { createAffiliatesService } from '@/lib/affiliates'
import { reconcileStripeFeeForOrder } from '@/lib/stripe-fees'
import { getStripe } from '@/lib/stripe-client'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[WEBHOOK] STRIPE_WEBHOOK_SECRET not set.')
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 500 })
  }

  const rawBody    = await req.text()
  const sigHeader  = req.headers.get('stripe-signature') ?? ''
  if (!sigHeader) return NextResponse.json({ error: 'Missing Stripe-Signature.' }, { status: 400 })

  let event: Awaited<ReturnType<typeof verifyWebhookSignature>>
  try {
    event = await verifyWebhookSignature(rawBody, sigHeader, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  }

  const session = event.data.object as any

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        if (session.payment_status === 'paid') {
          await handlePaid(session, event.id, event.type)
        } else {
          const res = await markAwaitingPayment(session.id, event.id, event.type)
          if (res === 'already_processed') {
            return NextResponse.json({ received: true, idempotent: true })
          }
        }
        break
      }

      case 'checkout.session.async_payment_succeeded':
        await handlePaid(session, event.id, event.type)
        break

      case 'checkout.session.async_payment_failed':
        await releaseReservationForEvent(session.id, event.id, event.type, 'async_payment_failed')
        await releaseDiscountClaimForSession(session)
        break

      case 'checkout.session.expired':
        await releaseReservationForEvent(session.id, event.id, event.type, 'session_expired')
        await releaseDiscountClaimForSession(session)
        break

      // ── Refunds ────────────────────────────────────────────────────────────
      // charge.refunded fires for the charge as a whole; refund.* fire per refund
      // object. All three routes converge on the same idempotent SQL function, so
      // overlapping deliveries of the same refund cannot double-count.
      case 'charge.refunded': {
        await handleChargeRefunded(session)
        break
      }

      case 'refund.created':
      case 'refund.updated':
      case 'charge.refund.updated': {
        await handleRefundObject(session)
        break
      }

      // ── Disputes / chargebacks ─────────────────────────────────────────────
      // All dispute events converge on one idempotent, staleness-guarded SQL
      // function. Redelivery is absorbed by the UNIQUE event id; genuinely
      // out-of-order delivery is rejected by Stripe's own event timestamp.
      // A late lost -> won transition is explicitly allowed.
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        await handleDispute(session, event.id, event.type, event.created)
        break
      }

      default:
        return NextResponse.json({ received: true, handled: false })
    }
    return NextResponse.json({ received: true, handled: true })

  } catch (err: any) {
    console.error(`[WEBHOOK] Error [${event.type}] ${event.id}:`, err?.message)
    return NextResponse.json({ error: 'Processing error.' }, { status: 500 })
  }
}

async function handlePaid(session: any, eventId: string, eventType: string) {
  const shippingDetails =
    session.collected_information?.shipping_details ??
    session.shipping_details ??
    null
  const sa           = shippingDetails?.address
  const recipientName = shippingDetails?.name ?? session.customer_details?.name ?? null

  const addr = sa ? {
    line1:       sa.line1,
    line2:       sa.line2  ?? null,
    city:        sa.city,
    state:       sa.state,
    postal_code: sa.postal_code,
    country:     sa.country,
  } : null

  const result = await finalizePaidOrder({
    stripeSessionId:     session.id,
    reservationIdHint:   session.metadata?.reservation_id ?? null,
    stripePaymentIntent: session.payment_intent ?? '',
    stripeEventId:       eventId,
    eventType,
    currency:            session.currency ?? 'usd',
    amountTotal:         session.amount_total ?? 0,
    customerEmail:       session.customer_details?.email ?? null,
    customerName:        recipientName,
    customerPhone:       session.customer_details?.phone ?? null,
    shippingAddress:     addr,
  })

  // 022: money was taken but KVRN could not safely create the order. A durable
  // payment_exceptions row already exists (admin-visible, requires resolution); this
  // line makes it loud in the logs too. No PII: ids and amounts only. Returning
  // normally is deliberate — the exception row, not a Stripe retry, is the record.
  if (result.paymentExceptionId) {
    console.error('[WEBHOOK][PAYMENT_EXCEPTION]', JSON.stringify({
      exceptionId: result.paymentExceptionId,
      reason:      result.reason ?? result.outcome,
      sessionId:   session.id,
      eventId,
      amountTotal: session.amount_total ?? null,
      duplicate:   result.alreadyProcessed || undefined,
    }))
  }
  if (result.outcome === 'order_created' && result.recovered) {
    console.error('[WEBHOOK][LATE_PAYMENT_RECOVERED]', JSON.stringify({
      orderNumber: result.orderNumber, sessionId: session.id, eventId,
    }))
  }

  // Attempt to send outbox email — non-fatal: provider failure must NOT affect order
  if (result.outcome === 'order_created') {
    try {
      const provider = getEmailProvider()
      await processPendingTransactionalEmails({ sql, provider, limit: 1 })
    } catch (emailErr: any) {
      // Log without PII — order remains paid regardless
      console.error('[WEBHOOK] Email send failed (non-fatal):', emailErr?.message?.slice(0, 100))
    }

    // Opportunistic Stripe fee capture. Usually not settled yet, in which case the
    // five-minute cron reconciles it later. Never allowed to affect the paid order.
    if (result.orderId) {
      await tryEnrichStripeFee(result.orderId)
      // Affiliate attribution is resolved once, immutably, at finalization.
      await tryResolveAffiliateAttribution(result.orderId, session.client_reference_id ?? null)
    }
  }
}

async function releaseDiscountClaimForSession(session: any) {
  // Read reservation_id from session metadata, release any active discount claim
  const reservationId = session.metadata?.reservation_id
  if (!reservationId) return
  try {
    await releaseDiscountClaim(reservationId)
  } catch (err: any) {
    console.error('[WEBHOOK] releaseDiscountClaim error (non-fatal):', err?.message?.slice(0, 60))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REFUND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * charge.refunded — the charge object carries a `refunds` list.
 *
 * Each entry is recorded individually so partial refunds are preserved as
 * separate rows rather than collapsed into one running total.
 *
 * ── FAILURE BEHAVIOUR ──────────────────────────────────────────────────────
 *
 * Failures THROW so the top-level handler returns a non-2xx and Stripe retries.
 * order_refunds is authoritative for revenue reduction, return/refund allocation,
 * dispute refund offsets and affiliate commission reversals — acknowledging a 200
 * while a refund went unpersisted would corrupt all four.
 *
 * PARTIAL-SUCCESS RETRY IS SAFE. Persistence is idempotent by Stripe refund id:
 * record_order_refund inserts ON CONFLICT (stripe_refund_id) DO NOTHING and
 * otherwise updates in place. If refund A commits and refund B throws, the retry
 * finds A already present (returns 'updated', no duplicate row) and gives B
 * another chance to persist.
 *
 * A refund whose payment intent matches no KVRN order returns 'no_order'. That is
 * intentionally unsupported rather than transient, so it is acknowledged — a
 * retry could never succeed.
 */
async function handleChargeRefunded(charge: any) {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id
  if (!paymentIntentId) {
    console.log('[WEBHOOK] charge.refunded without a payment intent — acknowledged')
    return
  }

  const refunds: any[] = charge.refunds?.data ?? []
  if (refunds.length === 0) return

  for (const refund of refunds) {
    if (!refund?.id) continue
    const result = await recordOrderRefund(sql, {
      stripeRefundId:   refund.id,
      paymentIntentId,
      chargeId:         charge.id ?? null,
      amountCents:      Number(refund.amount ?? 0),
      currency:         refund.currency ?? 'usd',
      status:           normalizeRefundStatus(refund.status),
      reason:           refund.reason ?? null,
      // Stripe reports a returned processing fee only sometimes.
      // Absent => NULL => "unknown", never assumed to be zero.
      feeRefundedCents: null,
      refundedAt:       refund.created
        ? new Date(refund.created * 1000).toISOString()
        : null,
    })

    if (result.outcome === 'no_order') {
      console.log('[WEBHOOK] refund has no matching KVRN order — acknowledged')
      continue
    }
    console.log(`[WEBHOOK] refund ${result.outcome}`)

    // Reverse affiliate commission for the merchandise actually refunded.
    // Propagates on failure for the same reason the refund does.
    const refundRow = await sql`
      SELECT id FROM order_refunds WHERE stripe_refund_id = ${refund.id} LIMIT 1
    `
    const rid = (refundRow as any[])[0]?.id
    if (rid) await applyAffiliateRefundEffect(rid)
  }
}

/**
 * refund.created / refund.updated — a single refund object.
 *
 * Same reliability contract as handleChargeRefunded: transient failures throw so
 * Stripe retries, a missing order is acknowledged, and persistence is idempotent
 * by Stripe refund id.
 */
async function handleRefundObject(refund: any) {
  const paymentIntentId = typeof refund.payment_intent === 'string'
    ? refund.payment_intent
    : refund.payment_intent?.id
  if (!paymentIntentId || !refund.id) {
    console.log('[WEBHOOK] refund event missing identifiers — acknowledged')
    return
  }

  const result = await recordOrderRefund(sql, {
    stripeRefundId:   refund.id,
    paymentIntentId,
    chargeId:         typeof refund.charge === 'string'
      ? refund.charge
      : refund.charge?.id ?? null,
    amountCents:      Number(refund.amount ?? 0),
    currency:         refund.currency ?? 'usd',
    status:           normalizeRefundStatus(refund.status),
    reason:           refund.reason ?? null,
    feeRefundedCents: null,
    refundedAt:       refund.created
      ? new Date(refund.created * 1000).toISOString()
      : null,
  })

  if (result.outcome === 'no_order') {
    console.log('[WEBHOOK] refund has no matching KVRN order — acknowledged')
    return
  }
  console.log(`[WEBHOOK] refund ${result.outcome}`)

  const refundRow = await sql`
    SELECT id FROM order_refunds WHERE stripe_refund_id = ${refund.id} LIMIT 1
  `
  const rid = (refundRow as any[])[0]?.id
  if (rid) await applyAffiliateRefundEffect(rid)
}

/**
 * Resolve affiliate attribution for a newly created paid order.
 *
 * NON-FATAL BY DESIGN. Attribution is an accounting enrichment; failing to
 * resolve it must never fail a customer's paid order. It is idempotent
 * (order_id is UNIQUE and rows are insert-only), so a later replay or an admin
 * backfill can resolve it without risk of a second attribution.
 *
 * Deliberately different from refunds and disputes, which DO propagate: those
 * remove money that has already moved, so losing one would corrupt the books.
 * An unattributed order merely lacks a commission until it is backfilled.
 */
async function tryResolveAffiliateAttribution(orderId: string, sessionId: string | null) {
  try {
    const rows = await sql`SELECT resolve_order_affiliate_attribution(
      ${orderId}::uuid, ${sessionId}, 'system@kvrn.internal'
    ) AS result`
    const outcome = (rows as any[])[0]?.result?.outcome
    if (outcome === 'attributed') console.log('[WEBHOOK] affiliate attribution resolved')
  } catch (err: any) {
    console.error('[WEBHOOK] affiliate attribution skipped (non-fatal):',
      err?.message?.slice(0, 100))
  }
}

/**
 * Apply an affiliate commission reversal for a refund.
 *
 * PROPAGATES ON FAILURE, matching the reliability standard the refund itself
 * uses: this reverses money already recorded as owed. Idempotent through the
 * UNIQUE (commission_id, source_refund_id) index, so a Stripe retry is safe.
 *
 * An unresolved component breakdown is NOT a failure — the SQL flags the
 * commission incomplete and returns cleanly, because unknown is never zero.
 */
async function applyAffiliateRefundEffect(refundId: string) {
  const service = createAffiliatesService(sql)
  const result = await sql`SELECT apply_affiliate_refund_reversal(
    ${refundId}::uuid, 'system@kvrn.internal'
  ) AS result`
  const outcome = (result as any[])[0]?.result?.outcome
  if (outcome) console.log(`[WEBHOOK] affiliate refund effect: ${outcome}`)
}

/**
 * Apply affiliate effects for every dispute ledger row not yet consumed.
 *
 * Driven by 018's APPEND-ONLY order_dispute_financial_adjustments, never by the
 * mutable dispute status. A partial dispute with no deterministic merchandise
 * split returns incomplete_pending_reconciliation and writes no adjustment.
 */
async function applyAffiliateDisputeEffects(stripeDisputeId: string) {
  // DISPUTE-CENTRIC, deliberately. 018 writes a financial-adjustment row only
  // when its gross revenue delta is non-zero, but a dispute can still change the
  // merchandise a commission is exposed to when that delta is zero — for example
  // when an earlier shipping-only refund already offsets the disputed amount.
  // Driving this from those rows missed real exposure entirely.
  //
  // Syncing from the dispute's CURRENT state is also naturally idempotent: the
  // claim is a target, so a redelivered webhook books nothing.
  const rows = await sql`
    SELECT id FROM order_disputes WHERE stripe_dispute_id = ${stripeDisputeId}
  `
  for (const r of rows as any[]) {
    const res = await sql`SELECT sync_affiliate_dispute_state(
      ${r.id}::uuid, NULL, 'system@kvrn.internal', NULL, NULL
    ) AS result`
    const outcome = (res as any[])[0]?.result?.outcome
    if (outcome) console.log(`[WEBHOOK] affiliate dispute sync: ${outcome}`)
  }
}

/**
 * Opportunistic Stripe fee capture immediately after an order is created.
 *
 * NON-FATAL BY DESIGN, unlike refunds and disputes. The fee is usually not
 * settled this early, in which case this is a no-op and the five-minute cron
 * picks it up later. A missing fee makes an order "partially reconciled" rather
 * than wrong, so it must never fail a successful paid order.
 */
async function tryEnrichStripeFee(orderId: string) {
  try {
    const stripe = getStripe()
    const result = await reconcileStripeFeeForOrder({ sql, stripe, orderId })
    if (result.outcome === 'enriched') {
      console.log('[WEBHOOK] Stripe fee reconciled at order creation')
    }
  } catch (err: any) {
    console.error('[WEBHOOK] Fee enrichment skipped (non-fatal):', err?.message?.slice(0, 80))
  }
}

/**
 * Record a dispute event and any authoritative Stripe money movement.
 *
 * Two separate concerns, deliberately kept apart:
 *   1. STATE — recorded via upsert_order_dispute with a staleness guard
 *   2. MONEY — read from Stripe balance transactions and stored verbatim
 *
 * Cash effects are NEVER inferred from status. Whether a dispute fee is retained
 * on a win varies by region and contract, so if Stripe reports a balance
 * transaction, Stripe is authoritative and it is stored as-is.
 *
 * ── FAILURE BEHAVIOUR ──────────────────────────────────────────────────────
 *
 * Failures here THROW so the top-level handler returns a non-2xx and Stripe
 * retries. Acknowledging a 200 while authoritative dispute accounting was not
 * persisted would silently lose a chargeback.
 *
 * Retrying is safe because both writes are idempotent:
 *   - order_dispute_events.stripe_event_id is UNIQUE, so a replayed event is a
 *     harmless no-op that reports 'duplicate_event'
 *   - dispute_balance_transactions.stripe_balance_transaction_id is UNIQUE, so a
 *     transaction that failed on the first attempt still gets another chance
 *     while one that succeeded is not double-counted
 *
 * The partial-success case therefore self-heals: state committed, balance
 * transaction failed, Stripe retries, state is a duplicate no-op and the missing
 * balance transaction is inserted.
 *
 * An event for an order KVRN does not have is NOT a failure — it is acknowledged
 * so Stripe stops retrying something that will never succeed.
 */
async function handleDispute(
  dispute: any,
  eventId: string,
  eventType: string,
  eventCreated: number,
) {
  if (!dispute?.id) {
    console.log('[WEBHOOK] dispute event without an id — acknowledged, nothing to do')
    return
  }

  const paymentIntentId = typeof dispute.payment_intent === 'string'
    ? dispute.payment_intent
    : dispute.payment_intent?.id ?? null
  const chargeId = typeof dispute.charge === 'string'
    ? dispute.charge
    : dispute.charge?.id ?? null

  const service = createDisputesService(sql)

  // 1. STATE — a failure must reach Stripe as a retryable error.
  const result = await service.upsertFromStripe({
    stripeDisputeId:  dispute.id,
    stripeChargeId:   chargeId,
    paymentIntentId,
    amountCents:      Number(dispute.amount ?? 0),
    currency:         dispute.currency ?? 'usd',
    stripeStatus:     String(dispute.status ?? 'needs_response'),
    stripeEventId:    eventId,
    stripeEventType:  eventType,
    // Stripe's own event time decides staleness, not arrival order.
    stripeEventCreatedAt: new Date((eventCreated ?? 0) * 1000).toISOString(),
    openedAt: dispute.created ? new Date(dispute.created * 1000).toISOString() : null,
    payload: { status: dispute.status, reason: dispute.reason },
  })

  // No matching KVRN order: intentionally unsupported, not a transient fault.
  // Acknowledge so Stripe does not retry forever.
  if (result?.outcome === 'no_order') {
    console.log('[WEBHOOK] dispute has no matching KVRN order — acknowledged')
    return
  }

  // ── Equal timestamp with a conflicting outcome ───────────────────────────
  //
  // Two distinct events share event.created and imply different states. Webhook
  // delivery order is not an authoritative tie-break, so instead of applying
  // whichever arrived last we read the CURRENT Stripe Dispute object and apply
  // that. Whichever tied event arrives second lands here, and both orderings
  // resolve to the same Stripe truth.
  //
  // A failure to reach Stripe THROWS: guessing a state would be worse than a
  // retry, and the event is already recorded for audit.
  if (result?.outcome === 'needs_reconciliation') {
    console.log('[WEBHOOK] dispute same-timestamp conflict — reconciling against Stripe')
    const stripe = getStripe()
    // balance_transactions is returned on the Dispute object by default and is
    // NOT an expandable field (only charge and payment_intent are). Requesting
    // its expansion would make this reconciliation path fail permanently on an
    // invalid-expansion error.
    const authoritative: any = await stripe.disputes.retrieve(dispute.id)

    const authPi = typeof authoritative.payment_intent === 'string'
      ? authoritative.payment_intent
      : authoritative.payment_intent?.id ?? paymentIntentId
    const authCharge = typeof authoritative.charge === 'string'
      ? authoritative.charge
      : authoritative.charge?.id ?? chargeId

    const reconciled = await service.reconcileFromStripe({
      stripeDisputeId: dispute.id,
      stripeStatus:    String(authoritative.status ?? dispute.status),
      amountCents:     Number(authoritative.amount ?? dispute.amount ?? 0),
      stripeChargeId:  authCharge,
      paymentIntentId: authPi,
      eventCreatedAt:  new Date((eventCreated ?? 0) * 1000).toISOString(),
      triggerEventId:  eventId,
    })
    console.log(`[WEBHOOK] dispute ${reconciled?.outcome ?? 'unknown'}`)

    // Record money from the authoritative object rather than the stale event.
    await recordDisputeBalanceTransactions(service, dispute.id,
      authoritative.balance_transactions ?? [])
    await applyAffiliateDisputeEffects(dispute.id)
    return
  }

  console.log(`[WEBHOOK] dispute ${result?.outcome ?? 'unknown'}`)

  // 2. MONEY — authoritative, and equally non-negotiable.
  await recordDisputeBalanceTransactions(service, dispute.id,
    dispute.balance_transactions ?? [])

  // 3. Affiliate effects, derived from 018's append-only ledger rows.
  await applyAffiliateDisputeEffects(dispute.id)
}

/**
 * Persist Stripe balance transactions for a dispute.
 *
 * Each is consumed exactly once thanks to the UNIQUE balance transaction id, so
 * a retry after a partial failure re-attempts only what did not land. Failures
 * propagate so Stripe retries rather than losing the money record.
 */
async function recordDisputeBalanceTransactions(
  service: ReturnType<typeof createDisputesService>,
  stripeDisputeId: string,
  txns: any[],
) {
  for (const bt of txns ?? []) {
    if (!bt?.id) continue
    await service.recordBalanceTransaction({
      stripeDisputeId,
      balanceTransactionId: bt.id,
      amountCents:          Number(bt.amount ?? 0),
      feeCents:             Number(bt.fee ?? 0),
      netCents:             Number(bt.net ?? 0),
      currency:             bt.currency ?? 'usd',
      reportingCategory:    bt.reporting_category ?? null,
      stripeCreatedAt:      bt.created ? new Date(bt.created * 1000).toISOString() : null,
    })
  }
}
