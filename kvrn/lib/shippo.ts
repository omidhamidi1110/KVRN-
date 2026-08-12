// lib/shippo.ts — Shippo shipping rate integration for KVRN
// Server-only. Never import in client components.
// Requires SHIPPO_API_TOKEN (Cloudflare Worker secret).
// Requires SHIPPO_FROM_* env vars for ship-from address.
// Falls back gracefully to null on any error.
//
// LABEL PURCHASING NOTE:
// This module sends city/state/zip for rate estimation.
// When label purchasing is added in Admin, it must use the complete customer
// shipping address (street1, street2, city, state, zip, country, name) from
// the orders table — partial addresses cannot generate valid shipping labels.

import type { ProductShippingData } from './inventory'

const SHIPPO_API = 'https://api.goshippo.com'

// ── Package profiles ──────────────────────────────────────────────────────────
//
// A PackageProfile describes a physical shipping container.
// To add a new package type (e.g. a larger outer box):
//   1. Define a new PackageProfile constant below.
//   2. Update getPackageForProduct() to return it for the relevant product codes.
//   No other changes required — buildParcels() reads from these profiles.
//
// maxGarments: maximum number of garment units that physically fit in one parcel.
//   Increasing this causes buildParcels() to consolidate units automatically.
//   Currently 1: safe default until multi-garment fit is physically verified.

interface PackageProfile {
  name:        string
  weightOz:    number  // weight of the empty container (added once per physical parcel)
  maxGarments: number  // max garment units per parcel; increase when verified
}

const KVRN_POLY_MAILER: PackageProfile = {
  name:        'KVRN 17×14 Poly Mailer',
  weightOz:    0.3,  // weight of one empty mailer
  maxGarments: 1,    // one garment per mailer — not yet verified for more
}

function getPackageForProduct(_productCode: string): PackageProfile {
  // All current KVRN products ship in the 17×14 poly mailer.
  // Add cases here when new products require a different package type.
  return KVRN_POLY_MAILER
}

// ── SKU → product code ────────────────────────────────────────────────────────

const SKU_PREFIX_TO_CODE: Array<{ prefix: string; code: string }> = [
  { prefix: 'KVRN-D001-PKHH',  code: 'PKHH'  },
  { prefix: 'KVRN-D001-PKHSP', code: 'PKHSP' },
]

function productCodeForSku(sku: string): string | null {
  return SKU_PREFIX_TO_CODE.find(m => sku.startsWith(m.prefix))?.code ?? null
}

// ── Fallback data (used before migration 006 is applied) ─────────────────────
// Garment weights only — packaging weight is added per parcel at calculation time.
// Heights are estimates; update migration 006 once physically measured.

const FALLBACKS: Record<string, Omit<ProductShippingData, 'productCode'>> = {
  PKHH:  { garmentWeightLb: 2.4, lengthIn: 17, widthIn: 14, heightIn: 2 },
  PKHSP: { garmentWeightLb: 1.8, lengthIn: 17, widthIn: 14, heightIn: 2 },
}

// ── Parcel building ───────────────────────────────────────────────────────────

interface ParcelSpec {
  weightLb: number
  lengthIn: number
  widthIn:  number
  heightIn: number
}

/**
 * Build physical parcels for a cart order.
 *
 * Batching: items are consolidated per product type up to pkg.maxGarments per parcel.
 *   maxGarments = 1 (current): one parcel per garment unit — safe production default.
 *   maxGarments = N: ceil(quantity / N) parcels, each holding up to N units.
 *
 * Weight per parcel: (garmentWeight × unitsInParcel) + packageWeight.
 *   The mailer is counted once per physical parcel regardless of how many garments it holds.
 *
 * Height per parcel: heightIn × unitsInParcel (garments stacked).
 *
 * Mixed product types are never consolidated across item lines — each item line
 * batches independently, reflecting separate physical packages.
 */
function buildParcels(
  items:      Array<{ sku: string; quantity: number }>,
  shippingDb: ProductShippingData[]
): ParcelSpec[] {
  const dbByCode = Object.fromEntries(shippingDb.map(d => [d.productCode, d]))
  const parcels:  ParcelSpec[] = []

  for (const item of items) {
    const code = productCodeForSku(item.sku)
    const data = code ? (dbByCode[code] ?? FALLBACKS[code]) : null
    const pkg  = getPackageForProduct(code ?? '')

    const garmentWeightLb = data?.garmentWeightLb ?? 2.4
    const pkgWeightLb     = pkg.weightOz / 16
    const baseHeightIn    = data?.heightIn         ?? 3
    const lengthIn        = data?.lengthIn          ?? 17
    const widthIn         = data?.widthIn           ?? 14

    // Batch quantity into ceil(quantity / maxGarments) parcels.
    // Each parcel holds min(maxGarments, remaining) units.
    let remaining = item.quantity
    while (remaining > 0) {
      const units  = Math.min(pkg.maxGarments, remaining)
      remaining   -= units

      parcels.push({
        // One mailer per parcel regardless of unit count inside
        weightLb: Math.round((garmentWeightLb * units + pkgWeightLb) * 100000) / 100000,
        lengthIn,
        widthIn,
        heightIn: baseHeightIn * units,  // stacked height
      })
    }
  }

  return parcels
}

// ── Rate selection ────────────────────────────────────────────────────────────

const STANDARD_TOKENS = new Set([
  'usps_ground_advantage', 'usps_first', 'usps_select', 'usps_parcel_select_ground',
  'ups_ground', 'fedex_ground', 'fedex_home_delivery', 'dhl_ground',
])
const EXPRESS_TOKENS = new Set([
  'usps_priority', 'usps_priority_mail', 'usps_priority_express',
  'ups_second_day_air', 'ups_next_day_air', 'ups_three_day_select',
  'fedex_2_day', 'fedex_2_day_am', 'fedex_priority_overnight', 'fedex_standard_overnight',
])

export interface ShippoRate {
  method:       'standard' | 'express'
  cents:        number
  label:        string
  estimate:     string
  minDays:      number
  maxDays:      number
  stripeLabel:  string
  provider:     string
  serviceToken: string
}

export interface ShippoRates {
  standard: ShippoRate
  // null means Shippo returned no real express service for this shipment.
  // Callers must fall back to static express rate — never fabricate a carrier or price.
  express:  ShippoRate | null
}

function pickRates(rates: any[]): { standard: ShippoRate | null; express: ShippoRate | null } {
  const valid = rates
    .filter((r: any) => r.amount && r.currency?.toLowerCase() === 'usd' && !r.hidden)
    .sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))

  if (valid.length === 0) return { standard: null, express: null }

  const standardRaw =
    valid.find((r: any) => STANDARD_TOKENS.has(r.servicelevel?.token?.toLowerCase())) ??
    valid[0]

  // Only return a real Shippo express rate — never synthesise one
  const expressRaw =
    valid.find((r: any) =>
      EXPRESS_TOKENS.has(r.servicelevel?.token?.toLowerCase()) &&
      r.object_id !== standardRaw?.object_id
    ) ?? null  // null = no real express available; callers use static fallback

  const toRate = (r: any, method: 'standard' | 'express'): ShippoRate => {
    const cents       = Math.round(parseFloat(r.amount) * 100)
    const estDays     = r.estimated_days ?? (method === 'standard' ? 7 : 3)
    const minDays     = Math.max(estDays - 1, 1)
    const maxDays     = estDays + 1
    const provider    = r.provider ?? 'Carrier'
    const serviceName = r.servicelevel?.name ?? (method === 'standard' ? 'Standard Shipping' : 'Express Shipping')
    const estimate    = `${minDays}–${maxDays} business days`

    return {
      method,
      cents,
      label:        `${provider} ${serviceName}`,
      estimate,
      minDays,
      maxDays,
      stripeLabel:  `${provider} ${serviceName} (${estimate})`,
      provider,
      serviceToken: r.servicelevel?.token ?? '',
    }
  }

  return {
    standard: toRate(standardRaw, 'standard'),
    express:  expressRaw ? toRate(expressRaw, 'express') : null,
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch real shipping rates from Shippo for a US shipment.
 *
 * Returns `{ standard, express }` where express may be null if Shippo returned
 * no real express carrier — callers must use static express fallback in that case.
 * Returns null on any network/API error — callers fall back to static rates entirely.
 *
 * For rate estimation, city/state/zip is sufficient.
 * Full street address is required when purchasing labels — see LABEL PURCHASING NOTE.
 */
export async function getShippoRates(
  toAddress:  { city: string; state: string; zip: string; country: string },
  items:      Array<{ sku: string; quantity: number }>,
  shippingDb: ProductShippingData[],
  apiToken:   string
): Promise<ShippoRates | null> {
  const fromStreet1 = process.env.SHIPPO_FROM_STREET1
  const fromCity    = process.env.SHIPPO_FROM_CITY
  const fromState   = process.env.SHIPPO_FROM_STATE
  const fromZip     = process.env.SHIPPO_FROM_ZIP

  if (!fromStreet1 || !fromCity || !fromState || !fromZip) {
    console.error('[shippo] Missing required SHIPPO_FROM_* configuration')
    return null
  }
  if (!apiToken) {
    console.error('[shippo] Missing SHIPPO_API_TOKEN')
    return null
  }

  const parcels = buildParcels(items, shippingDb)
  if (parcels.length === 0) {
    console.error('[shippo] No parcels built from cart items')
    return null
  }

  const payload = {
    address_from: {
      name:    process.env.SHIPPO_FROM_NAME    ?? 'KVRN',
      street1: fromStreet1,
      ...(process.env.SHIPPO_FROM_STREET2?.trim()
        ? { street2: process.env.SHIPPO_FROM_STREET2.trim() }
        : {}),
      city:    fromCity,
      state:   fromState,
      zip:     fromZip,
      country: process.env.SHIPPO_FROM_COUNTRY ?? 'US',
      phone:   process.env.SHIPPO_FROM_PHONE   ?? '',
      email:   process.env.SHIPPO_FROM_EMAIL   ?? '',
    },
    address_to: {
      name:    'Customer',
      city:    toAddress.city,
      state:   toAddress.state,
      zip:     toAddress.zip,
      country: toAddress.country ?? 'US',
    },
    parcels: parcels.map(p => ({
      length:        String(p.lengthIn),
      width:         String(p.widthIn),
      height:        String(p.heightIn),
      distance_unit: 'in',
      weight:        String(p.weightLb),
      mass_unit:     'lb',
    })),
    async: false,
  }

  let res: Response
  try {
    res = await fetch(`${SHIPPO_API}/shipments/`, {
      method:  'POST',
      headers: {
        'Authorization': `ShippoToken ${apiToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (err: any) {
    console.error('[shippo] Network error:', err?.message?.slice(0, 80))
    return null
  }

  if (!res.ok) {
    let detail = ''
    let structure = ''
    try {
      const errBody: any = await res.json()
      // Safe detail extraction — known scalar error fields only
      const safeDetail =
        errBody?.detail ??
        errBody?.message ??
        errBody?.error ??
        errBody?.messages ??
        ''
      detail =
        typeof safeDetail === 'string'
          ? safeDetail
          : JSON.stringify(safeDetail)

      // If no detail found, log only key structure (never values)
      if (!detail && errBody && typeof errBody === 'object') {
        const topKeys = Object.keys(errBody)
        const nested = topKeys
          .filter(k => errBody[k] !== null && typeof errBody[k] === 'object' && !Array.isArray(errBody[k]))
          .map(k => `${k}:[${Object.keys(errBody[k]).join(',')}]`)
          .join('|')
        structure = `keys=${topKeys.join(',')}` + (nested ? `; nested=${nested}` : '')
      }
    } catch {
      detail = ''
    }
    const suffix = detail ? `; detail=${detail.slice(0, 300)}` : (structure ? `; ${structure.slice(0, 300)}` : '')
    console.error(`[shippo] API returned ${res.status}${suffix}`)
    return null
  }

  let data: any
  try {
    data = await res.json()
  } catch {
    console.error('[shippo] Could not parse Shippo response JSON')
    return null
  }

  const { standard, express } = pickRates(data?.rates ?? [])
  if (!standard) {
    console.error(
      `[shippo] No usable standard rate returned; rates=${Array.isArray(data?.rates) ? data.rates.length : 0}`
    )
    return null
  }

  return { standard, express }  // express may be null — callers use static fallback
}
