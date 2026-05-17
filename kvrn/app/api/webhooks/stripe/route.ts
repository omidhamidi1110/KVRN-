import { NextRequest, NextResponse } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK HANDLER
//
// This endpoint receives webhooks from Stripe and processes them.
// Per V2 Blueprint: validates signature immediately, then processes async
// to avoid timeouts. In production, wire to Cloudflare Queues.
//
// Setup:
//  1. stripe.com/dashboard → Webhooks → Add endpoint
//  2. URL: https://kvrn.com/api/webhooks/stripe
//  3. Events to listen for:
//     - payment_intent.succeeded
//     - payment_intent.payment_failed
//     - charge.dispute.created
//  4. Copy signing secret → STRIPE_WEBHOOK_SECRET in env
// ─────────────────────────────────────────────────────────────────────────────

// Stripe requires the raw body for signature verification.
// This disables Next.js body parsing for this route.
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const body      = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'No signature.' }, { status: 400 })
  }

  // ─── Signature verification (uncomment when Stripe is connected) ──────────
  // import Stripe from 'stripe'
  // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  //
  // let event: Stripe.Event
  // try {
  //   event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)
  // } catch (err) {
  //   console.error('[webhook] Signature verification failed:', err)
  //   return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  // }
  //
  // // Return 200 immediately — process asynchronously
  // // (prevents Stripe from retrying if processing takes > 30s)
  // processWebhookEvent(event).catch((err) =>
  //   console.error('[webhook] Processing error:', err)
  // )
  //
  // return NextResponse.json({ received: true })

  // ─── MVP: Log and acknowledge ─────────────────────────────────────────────
  try {
    const payload = JSON.parse(body)
    console.log(`[webhook] Received: ${payload.type}`)

    // Route to handler
    switch (payload.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(payload.data.object)
        break
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(payload.data.object)
        break
      case 'charge.dispute.created':
        await handleDispute(payload.data.object)
        break
      default:
        console.log(`[webhook] Unhandled event type: ${payload.type}`)
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err) {
    console.error('[webhook] Parse error:', err)
    return NextResponse.json({ error: 'Parse error.' }, { status: 400 })
  }
}

// ─── EVENT HANDLERS ───────────────────────────────────────────────────────────

async function handlePaymentSuccess(paymentIntent: Record<string, unknown>) {
  const id = paymentIntent.id as string
  console.log(`[webhook] Payment succeeded: ${id}`)

  // TODO (wire these in order):
  // 1. Create order in Neon DB (with inventory lock — see V2 Blueprint)
  //    await createOrder(paymentIntent)
  // 2. Decrement inventory (SELECT FOR UPDATE to prevent overselling)
  //    await decrementInventory(lineItems)
  // 3. Send order confirmation email via Resend
  //    await sendOrderConfirmationEmail(order)
  // 4. Send SMS confirmation if customer opted in
  //    await sendOrderConfirmationSMS(order)
  // 5. Alert admin if any variant goes below low-stock threshold
  //    await checkLowStockAlerts(lineItems)
}

async function handlePaymentFailed(paymentIntent: Record<string, unknown>) {
  const id = paymentIntent.id as string
  console.log(`[webhook] Payment failed: ${id}`)

  // TODO:
  // 1. Log failed attempt in DB
  // 2. (Optional) Send customer email with retry link
  //    await sendPaymentFailedEmail(paymentIntent)
}

async function handleDispute(charge: Record<string, unknown>) {
  const id = charge.id as string
  console.log(`[webhook] Dispute created: ${id}`)

  // TODO:
  // 1. Alert admin immediately (email + potentially SMS)
  //    await alertAdminDispute(charge)
  // 2. Log in DB with all available evidence
  //    await logDispute(charge)
  // 3. Assemble evidence package (order data, shipping proof, IP logs)
  //    — Stripe gives 7 days to respond
}
