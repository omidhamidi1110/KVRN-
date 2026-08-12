import { NextRequest, NextResponse } from 'next/server'
import { calculateShippingCents, US_SHIPPING_OPTIONS, type ShippingMethod } from '@/lib/stripe'
import { applyFreeShippingToRates } from '@/lib/free-shipping'
import { getShippoRates } from '@/lib/shippo'
import { getProductShippingData, getSubtotalCentsForItems } from '@/lib/inventory'

// ─── POST /api/shipping-rates ──────────────────────────────────────────────────
// Returns available shipping options and costs.
// Accepts: { city, state, zip, country, items }
// Items contain only sku + quantity — prices are resolved server-side from Neon.
// Client-provided subtotals are NOT accepted or trusted.
// Falls back to flat rates if Shippo unavailable.
// Server-side only: SHIPPO_API_TOKEN never reaches the client.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const city    = body.city    ?? ''
    const state   = body.state   ?? ''
    const zip     = body.zip     ?? ''
    const country = (body.country ?? 'US').toUpperCase()
    const items: Array<{ sku: string; quantity: number }> =
      Array.isArray(body.items) ? body.items : []

    // ── Server-authoritative subtotal ─────────────────────────────────────────
    // Prices resolved from Neon products table — never trusted from client.
    // Returns null if any SKU is unknown/inactive; treat as "do not apply rule."
    const subtotalCents = items.length > 0
      ? await getSubtotalCentsForItems(items).catch(() => null)
      : 0

    // Attempt live Shippo rates when address is usable
    const apiToken   = process.env.SHIPPO_API_TOKEN ?? ''
    const hasAddress = city && state && zip && country === 'US'
    const hasItems   = items.length > 0

    if (hasAddress && hasItems && apiToken) {
      try {
        const shippingDb  = await getProductShippingData().catch(() => [])
        const shippoRates = await getShippoRates({ city, state, zip, country }, items, shippingDb, apiToken)

        if (shippoRates) {
          // Express: use real Shippo rate if available, else static (never fabricated)
          const expressOpt  = shippoRates.express
          const expressRate = expressOpt
            ? {
                id:       'express',
                label:    `${expressOpt.label} — ${expressOpt.estimate}`,
                cents:    expressOpt.cents,
                minDays:  expressOpt.minDays,
                maxDays:  expressOpt.maxDays,
                provider: expressOpt.provider,
                default:  false,
                source:   'shippo',
              }
            : {
                id:       'express',
                label:    US_SHIPPING_OPTIONS['express'].label + ' — ' + US_SHIPPING_OPTIONS['express'].estimate,
                cents:    calculateShippingCents('express'),
                minDays:  US_SHIPPING_OPTIONS['express'].minDays,
                maxDays:  US_SHIPPING_OPTIONS['express'].maxDays,
                provider: 'Carrier',
                default:  false,
                source:   'static',
              }

          const rates = [
            {
              id:       'standard',
              label:    `${shippoRates.standard.label} — ${shippoRates.standard.estimate}`,
              cents:    shippoRates.standard.cents,
              minDays:  shippoRates.standard.minDays,
              maxDays:  shippoRates.standard.maxDays,
              provider: shippoRates.standard.provider,
              default:  true,
              source:   'shippo',
            },
            expressRate,
          ]

          // Apply free-shipping rule with server-authoritative subtotal.
          // subtotalCents=null means unknown SKU(s) → do not apply rule (safe default).
          const qualifiedRates = subtotalCents !== null
            ? applyFreeShippingToRates(rates, country, subtotalCents)
            : rates
          return NextResponse.json({ success: true, data: { rates: qualifiedRates, source: 'shippo' } })
        }
      } catch (shippoErr: any) {
        console.error('[shipping-rates] Shippo error:', shippoErr?.message?.slice(0, 80))
        // Fall through to static rates
      }
    }

    // ── Static fallback ────────────────────────────────────────────────────────
    const staticMethods: ShippingMethod[] = ['standard', 'express']
    const staticRates = staticMethods.map(method => ({
      id:       method,
      label:    US_SHIPPING_OPTIONS[method].label + ' — ' + US_SHIPPING_OPTIONS[method].estimate,
      cents:    calculateShippingCents(method),
      minDays:  US_SHIPPING_OPTIONS[method].minDays,
      maxDays:  US_SHIPPING_OPTIONS[method].maxDays,
      provider: 'Carrier',
      default:  method === 'standard',
      source:   'static',
    }))

    const qualifiedStaticRates = subtotalCents !== null
      ? applyFreeShippingToRates(staticRates, country, subtotalCents)
      : staticRates
    return NextResponse.json({ success: true, data: { rates: qualifiedStaticRates, source: 'static' } })

  } catch (err: any) {
    console.error('[shipping-rates] Error:', err?.message)
    return NextResponse.json({ success: false, error: 'Failed to get shipping rates.' }, { status: 500 })
  }
}
