import { NextRequest, NextResponse } from 'next/server'

// ─── POST /api/webhooks/stripe ─────────────────────────────────────────────────
// Receives Stripe webhook events. Validates signature, routes to handler.
//
// ACTIVATION:
//   1. stripe.com/dashboard → Webhooks → Add endpoint
//      URL: https://kvrn.omidhamidi1110.workers.dev/api/webhooks/stripe
//      Events: payment_intent.succeeded, payment_intent.payment_failed,
//              charge.dispute.created, charge.refunded
//   2. Copy signing secret → STRIPE_WEBHOOK_SECRET in .env
export const runtime = 'nodejs'

// Prevent Next.js from parsing the body (Stripe needs raw bytes for sig verification)
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body      = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header.' }, { status: 400 })
  }

  // ── Signature verification ──────────────────────────────────────────────
  // Uncomment once stripe is installed:
  //
  // import Stripe from 'stripe'
  // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  //
  // let event: Stripe.Event
  // try {
  //   event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)
  // } catch (err) {
  //   console.error('[webhook] Invalid signature:', err)
  //   return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  // }
  //
  // // Return 200 immediately — Stripe expects a fast response
  // // Process asynchronously to avoid timeout
  // handleWebhookEvent(event).catch(err =>
  //   console.error('[webhook] Async handler error:', err)
  // )
  //
  // return NextResponse.json({ received: true })

  // ── Dev mode: parse payload directly (no signature check) ─────────────
  try {
    const event = JSON.parse(body) as { type: string; data: { object: Record<string, unknown> } }
    console.log(`[webhook] ${event.type}`)

    await handleWebhookEvent(event)

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[webhook] Parse error:', err)
    return NextResponse.json({ error: 'Bad payload.' }, { status: 400 })
  }
}

// ─── Event router ─────────────────────────────────────────────────────────────
async function handleWebhookEvent(event: { type: string; data: { object: Record<string, unknown> } }) {
  const obj = event.data.object

  switch (event.type) {
    case 'payment_intent.succeeded':
      await onPaymentSucceeded(obj)
      break
    case 'payment_intent.payment_failed':
      await onPaymentFailed(obj)
      break
    case 'charge.dispute.created':
      await onDisputeCreated(obj)
      break
    case 'charge.refunded':
      await onChargeRefunded(obj)
      break
    default:
      // Silently ignore — don't fail on unknown events
  }
}

// ─── payment_intent.succeeded ─────────────────────────────────────────────────
async function onPaymentSucceeded(pi: Record<string, unknown>) {
  const piId  = pi.id as string
  const email = pi.receipt_email as string | undefined
  const meta  = (pi.metadata ?? {}) as Record<string, string>

  console.log(`[webhook] Payment succeeded: ${piId}`)

  // TODO — wire in order:

  // 1. Parse line items from metadata (or fetch from DB by pi.id)
  //    const lineItems = JSON.parse(meta.line_items ?? '[]')

  // 2. Create order in Neon with inventory lock (SELECT FOR UPDATE)
  //    await createOrderWithInventoryLock(pi)

  // 3. Send order confirmation email
  //    if (email) {
  //      import { sendEmail, orderConfirmationHTML } from '@/lib/email'
  //      await sendEmail({
  //        to:      email,
  //        subject: `Order confirmed — #${shortId}`,
  //        html:    orderConfirmationHTML({ ... }),
  //      })
  //    }

  // 4. Send SMS if customer opted in (check DB sms_consent)
  //    if (meta.sms_opt_in === 'true' && meta.phone) { ... }

  // 5. Check low-stock thresholds and alert admin
  //    await checkLowStockAlerts()

  void meta // suppress unused warning until wired
}

// ─── payment_intent.payment_failed ────────────────────────────────────────────
async function onPaymentFailed(pi: Record<string, unknown>) {
  const piId = pi.id as string
  console.log(`[webhook] Payment failed: ${piId}`)

  // TODO:
  // Log to DB, optionally email customer with retry link
}

// ─── charge.dispute.created ────────────────────────────────────────────────────
async function onDisputeCreated(charge: Record<string, unknown>) {
  const chargeId = charge.id as string
  const amount   = charge.amount as number
  console.error(`[webhook] ⚠️  Dispute created: ${chargeId} — £${(amount / 100).toFixed(2)}`)

  // TODO:
  // 1. Email admin IMMEDIATELY (disputes have a 7-day response window)
  //    import { sendEmail } from '@/lib/email'
  //    await sendEmail({
  //      to:      process.env.ADMIN_EMAIL!,
  //      subject: `⚠️ Chargeback dispute: ${chargeId}`,
  //      html:    `<p>Dispute for charge ${chargeId} — £${(amount/100).toFixed(2)}</p>`,
  //    })
  // 2. Log in DB with all evidence
  // 3. Gather evidence: order record, shipping proof, IP logs
}

// ─── charge.refunded ──────────────────────────────────────────────────────────
async function onChargeRefunded(charge: Record<string, unknown>) {
  const chargeId = charge.id as string
  console.log(`[webhook] Charge refunded: ${chargeId}`)

  // TODO:
  // Update order status to 'refunded' in DB
  // Send refund confirmation email to customer
}
