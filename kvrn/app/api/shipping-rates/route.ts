import { NextRequest, NextResponse } from 'next/server'
// calculateShippingCents / US_SHIPPING_OPTIONS no longer used — static fallback removed
import { applyFreeShippingToRates } from '@/lib/free-shipping'
import { getShippoRates } from '@/lib/shippo'
import { getProductShippingData, getSubtotalCentsForItems } from '@/lib/inventory'

// ─── POST /api/shipping-rates ──────────────────────────────────────────────────
// Returns available shipping options and costs.
// Accepts: { city, state, zip, country, items }
// Items contain only sku + quantity — prices are resolved server-side from Neon.
// Client-provided subtotals are NOT accepted or trusted.
// Returns unavailable:true if Shippo fails — no static fallback.
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
    // city + zip + country required; state/province optional (international addresses may omit it)
    const hasAddress = city && zip && country
    const isUS       = country === 'US'
    const hasItems   = items.length > 0

    if (hasAddress && hasItems && apiToken) {
      try {
        const shippingDb  = await getProductShippingData().catch(() => [])
        const shippoRates = await getShippoRates({ city, state, zip, country }, items, shippingDb, apiToken)

        if (!shippoRates) {
          // Shippo returned null without throwing — treat as unavailable
          return NextResponse.json({ success: true, data: { rates: [], unavailable: true } })
        }

        {
          const standardRate = {
            id:       'standard',
            label:    `${shippoRates.standard.label} — ${shippoRates.standard.estimate}`,
            cents:    shippoRates.standard.cents,
            minDays:  shippoRates.standard.minDays,
            maxDays:  shippoRates.standard.maxDays,
            provider: shippoRates.standard.provider,
            default:  true,
            source:   'shippo',
          }

          // Express: real Shippo rate when available.
          // US only: static fallback when Shippo returns none.
          // Non-US: never insert US domestic static rates — omit express entirely.
          const expressOpt = shippoRates.express
          const rates: typeof standardRate[] = [standardRate]

          if (expressOpt) {
            rates.push({
              id:       'express',
              label:    `${expressOpt.label} — ${expressOpt.estimate}`,
              cents:    expressOpt.cents,
              minDays:  expressOpt.minDays,
              maxDays:  expressOpt.maxDays,
              provider: expressOpt.provider,
              default:  false,
              source:   'shippo',
            })
          }
          // If Shippo returns no express rate, omit it — no static fallback

          // Apply free-shipping rule with server-authoritative subtotal.
          // subtotalCents=null → unknown SKU(s), do not apply rule (safe default).
          const qualifiedRates = subtotalCents !== null
            ? applyFreeShippingToRates(rates, country, subtotalCents)
            : rates
          return NextResponse.json({ success: true, data: { rates: qualifiedRates, source: 'shippo' } })
        }
      } catch (shippoErr: any) {
        console.error('[shipping-rates] Shippo unavailable:', shippoErr?.message?.slice(0, 80))
        // Fail closed: no static fallback. Customer sees unavailable state.
        return NextResponse.json({ success: true, data: { rates: [], unavailable: true } })
      }
    }

    // Distinguish: genuine provider failure vs incomplete address
    if (!isUS) {
      return NextResponse.json({
        success: true,
        data:    { rates: [], source: 'international_unavailable' },
      })
    }

    if (hasAddress && hasItems && !apiToken) {
      // Complete address + no Shippo token = provider unavailable (not address missing)
      return NextResponse.json({ success: true, data: { rates: [], unavailable: true } })
    }

    // US with incomplete address — address still being entered; not a Shippo outage
    return NextResponse.json({ success: true, data: { rates: [], unavailable: false } })

  } catch (err: any) {
    console.error('[shipping-rates] Error:', err?.message)
    return NextResponse.json({ success: false, error: 'Failed to get shipping rates.' }, { status: 500 })
  }
}
