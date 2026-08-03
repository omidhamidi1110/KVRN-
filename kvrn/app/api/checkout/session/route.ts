import { type NextRequest, NextResponse } from 'next/server'
import { validateLineItem } from '@/lib/inventory'
import Stripe from 'stripe'

export const dynamic = 'force-dynamic'

const ENABLED  = process.env.ENABLE_STRIPE_TEST_CHECKOUT === 'true'
const SECRET   = process.env.STRIPE_SECRET_KEY ?? ''
const SITE_URL = process.env.SITE_URL ?? 'http://localhost:3000'

export async function POST(req: NextRequest) {
  if (!ENABLED) {
    return NextResponse.json({ error: 'Checkout is not enabled.' }, { status: 503 })
  }
  if (!SECRET.startsWith('sk_test_')) {
    console.error('Live Stripe key rejected — this phase is test-mode only.')
    return NextResponse.json({ error: 'Stripe configuration error.' }, { status: 500 })
  }

  const stripe = new Stripe(SECRET, { apiVersion: '2024-06-20' })

  let items: { sku: string; quantity: number }[]
  try {
    const body = await req.json()
    items = body.items
    if (!Array.isArray(items) || items.length === 0) throw new Error()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  for (const { sku, quantity } of items) {
    const v = await validateLineItem(sku, quantity)
    if (!v.ok) {
      return NextResponse.json({ error: v.message, code: v.error, sku }, { status: 400 })
    }
    lineItems.push({
      price_data: {
        currency:    'usd',
        unit_amount: v.variant.price_cents,
        product_data: {
          name: `${v.variant.product_name} — ${v.variant.size}`,
          metadata: { sku, variant_id: v.variant.id },
        },
      },
      quantity,
    })
  }

  // NOTE: No inventory reservation in this phase.
  // NEXT PHASE REQUIRED: reserve inventory here, release on checkout.session.expired webhook.
  try {
    const session = await stripe.checkout.sessions.create({
      mode:       'payment',
      line_items: lineItems,
      success_url: `${SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/cart`,
      shipping_address_collection: {
        allowed_countries: ['US','CA','GB','AU','NZ','DE','FR','ES','IT','NL','SE','NO','DK'],
      },
      metadata: { skus: items.map(i=>i.sku).join(','), phase: 'test-no-reservation' },
    })
    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('Stripe error:', err.message)
    return NextResponse.json({ error: 'Checkout session failed.' }, { status: 500 })
  }
}
