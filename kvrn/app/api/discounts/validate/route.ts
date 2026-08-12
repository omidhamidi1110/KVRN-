// POST /api/discounts/validate — Server-authoritative discount preview
// Validates a discount code against real product prices and cart context.
// NOT the final authority (checkout-session-handler revalidates at session creation),
// but prevents showing invalid codes as "applied" in the UI.
// Never trusts client-supplied discount amounts.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { calculateShippingCents, type ShippingMethod } from '@/lib/stripe'
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
  // Authoritative shipping cost for US; non-US uses 0 (Shippo rates not deterministic at preview time)
  const authShipping  = country === 'US' && ['standard','express'].includes(rawMethod)
    ? calculateShippingCents(rawMethod as ShippingMethod)
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
          SELECT price_cents FROM product_variants WHERE sku = ${item.sku} LIMIT 1
        `
        const price = (rows as any[])[0]?.price_cents
        if (price) subtotalCents += Number(price) * item.quantity
      }
    }
  } catch (err: any) {
    console.error('[discounts/validate] price lookup error:', err?.message?.slice(0, 60))
    return NextResponse.json({ valid: false, error: 'Could not validate code at this time.' }, { status: 500 })
  }

  // Check US free-shipping eligibility (blocks merchandise codes)
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
    shippingCents: authShipping,  // authoritative US shipping; 0 for non-US preview
  })

  // Override: if free shipping eligible and NOT a shipping discount → block
  if (freeShippingEligible && validation.discount.type !== 'shipping') {
    return NextResponse.json({
      valid: false,
      error: 'This order already qualifies for free shipping. Discounts cannot be combined.',
    })
  }

  if (priorityResult.blockedReason) {
    return NextResponse.json({ valid: false, error: priorityResult.blockedReason })
  }

  if (!priorityResult.applied) {
    return NextResponse.json({ valid: false, error: "That code isn't valid for this order." })
  }

  const a = priorityResult.applied
  const effectiveShipping = Math.max(0, authShipping - a.shippingAdjustmentCents)
  return NextResponse.json({
    valid:               true,
    code:                normalizeDiscountCode(rawCode),
    type:                a.type,
    discountCents:       a.amountCents,
    shippingAdjustmentCents: a.shippingAdjustmentCents,
    effectiveShippingCents:  effectiveShipping,
    displayAmount:       a.type === 'shipping'
      ? (a.shippingAdjustmentCents >= authShipping ? 'Free shipping'
         : `-$${(a.shippingAdjustmentCents/100).toFixed(2)} off shipping`)
      : `-$${(a.amountCents/100).toFixed(2)}`,
  })
}
