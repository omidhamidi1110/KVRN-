import { NextRequest, NextResponse } from 'next/server'
// calculateShippingCents / US_SHIPPING_OPTIONS no longer used — static fallback removed
import { applyFreeShippingToRates } from '@/lib/free-shipping'
import { getShippoRates } from '@/lib/shippo'
import { getProductShippingData, getSubtotalCentsForItems } from '@/lib/inventory'
import { isProviderException, recordProviderFailure } from '@/lib/owner-notifications'
import { parseShippingQuoteInput } from '@/lib/shipping-quote-input'
import { readLimitedJson } from '@/lib/limited-json-request'
import { sql } from '@/lib/db'
import { allowPublicApiRequest } from '@/lib/public-api-rate-limit'

// ─── POST /api/shipping-rates ──────────────────────────────────────────────────
// Returns available shipping options and costs.
// Accepts: { city, state, zip, country, items }
// Items contain only sku + quantity — prices are resolved server-side from Neon.
// Client-provided subtotals are NOT accepted or trusted.
// Returns unavailable:true if Shippo fails — no static fallback.
// Server-side only: SHIPPO_API_TOKEN never reaches the client.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Production rate-limit is fail-closed: never let an unauthenticated caller fan
  // out an unlimited number of requests to the external shipping provider.
  if (process.env.NODE_ENV === 'production') {
    try {
      const allowed = await allowPublicApiRequest(sql, {
        bucket: 'shipping_quote', headers: req.headers, limit: 30, windowSeconds: 60,
      })
      if (!allowed) return NextResponse.json({ success: false, error: 'Too many requests.' }, {
        status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
      })
    } catch {
      return NextResponse.json({ success: false, error: 'Shipping temporarily unavailable.' }, { status: 503 })
    }
  }

  const read = await readLimitedJson(req, 8192)
  if (!read.ok) return NextResponse.json({ success: false, error: read.reason === 'too_large' ? 'Request too large.' : 'Invalid request.' }, { status: read.status })
  const raw = read.value
  const parsed = parseShippingQuoteInput(raw)
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.reason }, { status: 400 })
  const { city, state, zip, country, items } = parsed.value

  try {
    // Unknown, inactive or unpriced SKUs must never trigger Shippo calls or
    // silently qualify for discounted/free shipping.
    let subtotalCents: number | null
    try {
      subtotalCents = items.length ? await getSubtotalCentsForItems(items) : 0
    } catch {
      return NextResponse.json({ success: true, data: { rates: [], unavailable: true } }, { status: 503 })
    }
    if (subtotalCents === null) return NextResponse.json({ success: false, error: 'Cart items are unavailable.' }, { status: 400 })

    // Attempt live Shippo rates when address is usable
    const apiToken   = process.env.SHIPPO_API_TOKEN ?? ''
    // city + zip + country required; state/province optional (international addresses may omit it)
    const hasAddress = city && zip && country
    const isUS       = country === 'US'
    const hasItems   = items.length > 0

    if (hasAddress && hasItems && apiToken) {
      try {
        const shippingDb  = await getProductShippingData()
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
          const qualifiedRates = applyFreeShippingToRates(rates, country, subtotalCents)
          return NextResponse.json({ success: true, data: { rates: qualifiedRates, source: 'shippo' } })
        }
      } catch (shippoErr: any) {
        console.error('[shipping-rates] Shippo unavailable:', shippoErr?.message?.slice(0, 80))
        if (isProviderException(shippoErr)) await recordProviderFailure('Shippo', 'shipping_rates_exception')
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
      await recordProviderFailure('Shippo', 'shipping_rates_missing_token')
      return NextResponse.json({ success: true, data: { rates: [], unavailable: true } })
    }

    // US with incomplete address — address still being entered; not a Shippo outage
    return NextResponse.json({ success: true, data: { rates: [], unavailable: false } })

  } catch (err: any) {
    console.error('[shipping-rates] Error:', err?.message)
    return NextResponse.json({ success: false, error: 'Failed to get shipping rates.' }, { status: 500 })
  }
}
