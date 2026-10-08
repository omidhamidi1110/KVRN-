// POST /api/discounts/validate — Server-authoritative discount preview
// Validates a discount code against real product prices and cart context.
// NOT the final authority (checkout-session-handler revalidates at session creation),
// but prevents showing invalid codes as "applied" in the UI.
// Never trusts client-supplied discount amounts.
import { type NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { validateDiscount, applyDiscountPriority, normalizeDiscountCode } from '@/lib/discounts'
import { qualifiesForFreeShipping } from '@/lib/free-shipping'
import { getSubtotalCentsForItems } from '@/lib/inventory'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'
import { readLimitedJson } from '@/lib/limited-json-request'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, { bucket: 'discount_preview', headers: req.headers, limit: 30, windowSeconds: 60 })
      if (!allowed) return NextResponse.json({ valid: false, error: 'Too many attempts.' }, { status: 429, headers: { 'Retry-After': '60' } })
    } catch {
      return NextResponse.json({ valid: false, error: 'Discount check temporarily unavailable.' }, { status: 503 })
    }
  }
  const read = await readLimitedJson(req, 8 * 1024)
  if (!read.ok) return NextResponse.json({ valid: false, error: read.reason === 'too_large' ? 'Request too large.' : 'Invalid request.' }, { status: read.status })
  const body: any = read.value
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ valid: false, error: 'Invalid request.' }, { status: 400 })
  const rawCode       = body.code
  const country       = typeof body.country === 'string' ? body.country.toUpperCase() : 'US'
  if (body.items !== undefined && !Array.isArray(body.items)) return NextResponse.json({ valid: false, error: 'Invalid cart.' }, { status: 400 })
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

  // One authoritative query. Reject the ENTIRE cart on malformed, inactive or
  // unknown lines; never silently drop bad items and show a false discount.
  if (cartItems.length > 20 || cartItems.some((i: any) => !i || typeof i.sku !== 'string'
    || i.sku.length < 1 || i.sku.length > 120 || !Number.isInteger(i.quantity)
    || i.quantity < 1 || i.quantity > 10)) {
    return NextResponse.json({ valid: false, error: 'Invalid cart.', reason: 'invalid_cart' }, { status: 400 })
  }
  let subtotalCents: number
  try {
    const authoritative = await getSubtotalCentsForItems(cartItems)
    if (authoritative === null) {
      return NextResponse.json({ valid: false, error: 'An item in your cart is no longer available.', reason: 'invalid_cart' }, { status: 400 })
    }
    subtotalCents = authoritative
  } catch {
    return NextResponse.json({ valid: false, error: 'Could not validate code at this time.' }, { status: 503 })
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
