import { NextRequest, NextResponse } from 'next/server'
import { calculateShipping } from '@/lib/stripe'

// ─── POST /api/checkout ────────────────────────────────────────────────────────
// Creates a Stripe PaymentIntent and returns the client_secret.
// The client uses the client_secret with Stripe Elements to confirm payment.
//
// ACTIVATION:
//   npm install stripe
//   Set STRIPE_SECRET_KEY in .env.local
//   Uncomment the Stripe block below
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      items,
      email,
      shippingAddress,
      shippingMethod = 'standard',
    } = body

    // ── Validate ───────────────────────────────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: false, error: 'No items in cart.' }, { status: 400 })
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Invalid email.' }, { status: 400 })
    }

    // ── Calculate totals ───────────────────────────────────────────────────
    const subtotalPence = (items as Array<{ price: number; quantity: number }>)
      .reduce((sum, item) => sum + item.price * item.quantity, 0)

    const shippingPence = calculateShipping(
      shippingAddress?.country ?? 'GB',
      shippingMethod
    )

    const totalPence = subtotalPence + shippingPence

    // ── Stripe PaymentIntent ───────────────────────────────────────────────
    // Uncomment once stripe is installed:
    //
    // import Stripe from 'stripe'
    // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })
    //
    // const paymentIntent = await stripe.paymentIntents.create({
    //   amount:   totalPence,
    //   currency: 'gbp',
    //   automatic_payment_methods: { enabled: true },
    //   receipt_email: email,
    //   metadata: {
    //     customer_email:   email,
    //     shipping_method:  shippingMethod,
    //     shipping_country: shippingAddress?.country ?? 'GB',
    //     item_count:       String(items.length),
    //     subtotal_pence:   String(subtotalPence),
    //     shipping_pence:   String(shippingPence),
    //   },
    //   shipping: shippingAddress ? {
    //     name:    `${shippingAddress.firstName} ${shippingAddress.lastName}`,
    //     address: {
    //       line1:       shippingAddress.address1,
    //       line2:       shippingAddress.address2 || undefined,
    //       city:        shippingAddress.city,
    //       postal_code: shippingAddress.postcode,
    //       country:     shippingAddress.country,
    //     },
    //   } : undefined,
    // })
    //
    // return NextResponse.json({
    //   success:        true,
    //   clientSecret:   paymentIntent.client_secret,
    //   paymentIntentId:paymentIntent.id,
    //   totalPence,
    //   subtotalPence,
    //   shippingPence,
    // })

    // ── Stub response (dev mode) ───────────────────────────────────────────
    return NextResponse.json({
      success:        true,
      clientSecret:   'pi_test_placeholder_connect_stripe_to_activate',
      paymentIntentId:'pi_test_placeholder',
      totalPence,
      subtotalPence,
      shippingPence,
      dev:            true,
      message:        'Set STRIPE_SECRET_KEY to enable real payments.',
    })
  } catch (err) {
    console.error('[checkout] Error:', err)
    return NextResponse.json({ success: false, error: 'Failed to create payment intent.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
