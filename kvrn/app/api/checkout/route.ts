import { NextRequest, NextResponse } from 'next/server'

// ─── Stripe Checkout Session creation ────────────────────────────────────────
// This endpoint creates a Stripe Payment Intent for use with Stripe Elements.
// Activate by:
// 1. npm install stripe
// 2. Set STRIPE_SECRET_KEY in .env.local
// 3. Uncomment the Stripe code below

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { items, email, shippingAddress, shippingMethod } = body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No items provided.' },
        { status: 400 }
      )
    }

    // ─── Calculate totals ───────────────────────────────────────────
    const subtotalPence = items.reduce(
      (sum: number, item: { price: number; quantity: number }) =>
        sum + item.price * item.quantity,
      0
    )

    const shippingPence =
      shippingAddress?.country === 'GB'
        ? shippingMethod === 'express' ? 999 : 499
        : shippingAddress?.country === 'US' || shippingAddress?.country === 'CA'
        ? 1999
        : 1499

    const totalPence = subtotalPence + shippingPence

    // ─── Create Stripe PaymentIntent ────────────────────────────────
    // TODO: Uncomment when ready to go live
    //
    // import Stripe from 'stripe'
    // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    //   apiVersion: '2024-06-20',
    // })
    //
    // const paymentIntent = await stripe.paymentIntents.create({
    //   amount: totalPence,
    //   currency: 'gbp',
    //   automatic_payment_methods: { enabled: true },
    //   metadata: {
    //     items:           JSON.stringify(items),
    //     shipping_method: shippingMethod,
    //     customer_email:  email,
    //   },
    // })
    //
    // return NextResponse.json({
    //   success:      true,
    //   clientSecret: paymentIntent.client_secret,
    //   totalPence,
    // })

    // ─── MVP: Return mock client secret ────────────────────────────
    return NextResponse.json({
      success:      true,
      clientSecret: 'pi_mock_secret_connect_stripe_to_activate',
      totalPence,
      subtotalPence,
      shippingPence,
      message:      'Stripe not yet connected. Set STRIPE_SECRET_KEY to activate.',
    })
  } catch (err) {
    console.error('[checkout] Error creating payment intent:', err)
    return NextResponse.json(
      { success: false, error: 'Failed to create checkout session.' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
}
