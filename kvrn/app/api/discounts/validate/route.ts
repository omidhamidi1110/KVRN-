// POST /api/discounts/validate — Server-authoritative discount preview
// Validates a discount code against real product prices and cart context.
// NOT the final authority (checkout-session-handler revalidates at session creation),
// but prevents showing invalid codes as "applied" in the UI.
// Never trusts client-supplied discount amounts.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { validateDiscount, applyDiscountPriority, normalizeDiscountCode } from '@/lib/discounts'
import { qualifiesForFreeShipping } from '@/lib/free-shipping'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ valid: false, error: 'Invalid request.' }, { status: 400 })
  }

  const rawCode       = body.code
  const country       = typeof body.country === 'string' ? body.country.toUpperCase() : 'US'
  const cartItems     = Array.isArray(body.items) ? body.items : []
  const rawMethod     = body.shippingMethod
  const rawShippingCents = body.shippingCents

  // PREVIEW ONLY. Final checkout/session independently re-fetches Shippo
  // and remains authoritative for the actual shipping charge.
  const previewShippingCents =
    country === 'US' &&
    ['standard','express'].includes(rawMethod) &&
    Number.isInteger(rawShippingCents) &&
    rawShippingCents >= 0 &&
    rawShippingCents <= 100000
      ? rawShippingCents
      : 0

  if (!rawCode || typeof rawCode !== 'string') {
    return NextResponse.json({ valid: false, error: "Enter a discount code." })
  }

  // Resolve authoritative subtotal from product_variants (never trust client prices)
  let subtotalCents = 0
  try {
    if (cartItems.length > 0) {
      for (const item of cartItems) {
        if (typeof item.sku !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1) continue
        const rows = await sql`
          SELECT p.price_cents
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          WHERE pv.sku = ${item.sku}
          LIMIT 1
        `
        const price = (rows as any[])[0]?.price_cents
        if (price === undefined || price === null) {
          return NextResponse.json(
            { valid: false, error: 'An item in your cart is no longer available.', reason: 'invalid_cart' },
            { status: 400 }
          )
        }
        subtotalCents += Number(price) * item.quantity
      }
    }
  } catch (err: any) {
    console.error('[discounts/validate] price lookup error:', err?.message?.slice(0, 60))
    return NextResponse.json({ valid: false, error: 'Could not validate code at this time.' }, { status: 500 })
  }

  // Automatic US free shipping is a store benefit and may stack with one merchandise promo.
  const freeShippingEligible = qualifiesForFreeShipping(country, subtotalCents)

  // Validate discount code
  const validation = await validateDiscount(rawCode, { subtotalCents, country })
  if (!validation.valid) {
    return NextResponse.json({ valid: false, error: validation.error })
  }

  // Apply priority rules
  const priorityResult = applyDiscountPriority({
    discount:      validation.discount,
    subtotalCents,
    country,
    shippingCents: previewShippingCents,  // preview only; checkout/session revalidates Shippo
  })

  if (priorityResult.blockedReason) {
    return NextResponse.json({ valid: false, error: priorityResult.blockedReason, reason: 'blocked' })
  }

  if (!priorityResult.applied) {
    return NextResponse.json({ valid: false, error: "That code isn't valid for this order.", reason: 'invalid' })
  }

  const a = priorityResult.applied
  const effectiveShipping = Math.max(0, previewShippingCents - a.shippingAdjustmentCents)
  return NextResponse.json({
    valid:               true,
    code:                normalizeDiscountCode(rawCode),
    type:                a.type,
    discountCents:       a.amountCents,
    shippingAdjustmentCents: a.shippingAdjustmentCents,
    effectiveShippingCents:  effectiveShipping,
    displayAmount:       a.type === 'shipping'
      ? (a.shippingAdjustmentCents >= previewShippingCents ? 'Free shipping'
         : `-$${(a.shippingAdjustmentCents/100).toFixed(2)} off shipping`)
      : `-$${(a.amountCents/100).toFixed(2)}`,
  })
}
