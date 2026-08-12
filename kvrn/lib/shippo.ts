// lib/shippo.ts — Shippo shipping rate integration for KVRN
// Server-only. Never import in client components.
// Supports both US domestic and international destinations.
// Requires SHIPPO_API_TOKEN (Cloudflare Worker secret).
// Requires SHIPPO_FROM_* env vars for ship-from address.
// Falls back gracefully to null on any error.
//
// LABEL PURCHASING NOTE:
// This module sends city/state/zip for rate estimation (state optional for international).
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
  weightOz: number
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

    const garmentWeightOz = (data?.garmentWeightLb ?? 2.4) * 16  // convert lb→oz for Shippo
    const pkgWeightOz     = pkg.weightOz                          // already in oz
    const baseHeightIn    = data?.heightIn                  ?? 3
    const lengthIn        = data?.lengthIn                  ?? 17
    const widthIn         = data?.widthIn                   ?? 14

    // Batch quantity into ceil(quantity / maxGarments) parcels.
    // Each parcel holds min(maxGarments, remaining) units.
    let remaining = item.quantity
    while (remaining > 0) {
      const units  = Math.min(pkg.maxGarments, remaining)
      remaining   -= units

      parcels.push({
        // One mailer per parcel regardless of unit count inside
        // Weight in oz: avoids lb decimal precision issues (Shippo max 4 decimal digits)
        weightOz: Math.round((garmentWeightOz * units + pkgWeightOz) * 10) / 10,
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
  // null means Shippo returned no real express service for this destination.
  // US callers may insert a static fallback; non-US callers must omit express entirely.
  express:  ShippoRate | null
}

// Substring keywords that identify international express/expedited services.
// Checked against servicelevel.token and servicelevel.name (case-insensitive).
const INTL_EXPRESS_KEYWORDS = [
  'priority', 'express', 'xpress', 'expedited', 'worldwide', 'saver', 'air',
] as const

function hasExpressKeyword(rate: any): boolean {
  const token = (rate.servicelevel?.token ?? '').toLowerCase()
  const name  = (rate.servicelevel?.name  ?? '').toLowerCase()
  return INTL_EXPRESS_KEYWORDS.some(kw => token.includes(kw) || name.includes(kw))
}

/**
 * Shared helper: convert a raw Shippo rate object to a typed ShippoRate.
 */
function toShippoRate(r: any, method: 'standard' | 'express'): ShippoRate {
  const cents       = Math.round(parseFloat(r.amount) * 100)
  const estDays     = r.estimated_days ?? (method === 'standard' ? 7 : 3)
  const minDays     = Math.max(estDays - 1, 1)
  const maxDays     = estDays + 1
  const provider    = r.provider ?? 'Carrier'
  const serviceName = r.servicelevel?.name ??
    (method === 'standard' ? 'Standard Shipping' : 'Express Shipping')
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

/**
 * Select standard and express rates from a list of raw Shippo rate objects.
 * Country-aware: US uses domestic token sets; international uses cheapest/faster logic.
 *
 * Exported for unit testing — not part of the public API surface.
 *
 * US domestic:
 *   Standard — prefers known ground tokens, else cheapest.
 *   Express  — prefers known express tokens, else null (caller may use static fallback).
 *
 * International:
 *   Standard — cheapest valid Shippo rate (no domestic token preference).
 *   Express  — cheapest real Shippo rate that is strictly faster by estimated_days;
 *             falls back to cheapest rate with an express keyword if no faster-by-days
 *             option exists; null if nothing qualifies. Never fabricated.
 */
export function pickRatesForDestination(
  rates:   any[],
  country: string
): { standard: ShippoRate | null; express: ShippoRate | null } {
  const valid = rates
    .filter((r: any) => r.amount && r.currency?.toLowerCase() === 'usd' && !r.hidden)
    .sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))

  if (valid.length === 0) return { standard: null, express: null }

  const isInternational = country.toUpperCase() !== 'US'

  if (isInternational) {
    // ── International: cheapest is standard; real-faster-or-keyword rate is express ──
    const standardRaw = valid[0]
    const stdDays     = standardRaw.estimated_days as number | null | undefined
    const others      = valid.filter((r: any) => r.object_id !== standardRaw.object_id)

    let expressRaw: any = null

    // Priority 1: a real Shippo rate with strictly fewer estimated_days than standard
    if (stdDays != null) {
      expressRaw = others.find(
        (r: any) => r.estimated_days != null && r.estimated_days < stdDays
      ) ?? null  // others already sorted cheapest-first → first match = cheapest faster
    }

    // Priority 2: a rate with an express/priority keyword (no fabrication)
    if (!expressRaw) {
      expressRaw = others.find(hasExpressKeyword) ?? null
    }

    return {
      standard: toShippoRate(standardRaw, 'standard'),
      express:  expressRaw ? toShippoRate(expressRaw, 'express') : null,
    }
  }

  // ── US domestic: existing token-based logic ────────────────────────────────
  const standardRaw =
    valid.find((r: any) => STANDARD_TOKENS.has(r.servicelevel?.token?.toLowerCase())) ??
    valid[0]

  // Only return a real Shippo express rate — never synthesise one.
  // null → US callers may insert the trusted static express fallback.
  const expressRaw =
    valid.find((r: any) =>
      EXPRESS_TOKENS.has(r.servicelevel?.token?.toLowerCase()) &&
      r.object_id !== standardRaw.object_id
    ) ?? null

  return {
    standard: toShippoRate(standardRaw, 'standard'),
    express:  expressRaw ? toShippoRate(expressRaw, 'express') : null,
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch real shipping rates from Shippo for domestic or international shipments.
 *
 * Returns `{ standard, express }` where express may be null when Shippo has no
 * real faster service for the destination. US callers may use the static express
 * fallback; non-US callers must NOT substitute US domestic static rates.
 * Returns null on any network/API error — callers fall back accordingly.
 *
 * For rate estimation, city/zip/country is sufficient; state is optional.
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
      weight:        String(p.weightOz),
      mass_unit:     'oz',
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

      // If no detail found, recursively summarise KEY/INDEX structure only — never values
      if (!detail && errBody && typeof errBody === 'object') {
        // Recursively build a key-structure string; depth-limited to 4 levels
        const summarise = (node: any, depth: number): string => {
          if (depth > 4) return '...'
          if (Array.isArray(node)) {
            return '[' + node.map((el, i) =>
              el !== null && typeof el === 'object'
                ? `${i}:{${summarise(el, depth + 1)}}`
                : String(i)
            ).join(',') + ']'
          }
          if (node !== null && typeof node === 'object') {
            return Object.keys(node).map(k => {
              const v = node[k]
              return (v !== null && typeof v === 'object')
                ? `${k}:{${summarise(v, depth + 1)}}`
                : k
            }).join(',')
          }
          return ''
        }
        structure = `structure=${summarise(errBody, 0)}`
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

  const { standard, express } = pickRatesForDestination(
    data?.rates ?? [], toAddress.country
  )
  if (!standard) {
    console.error(
      `[shippo] No usable standard rate returned; rates=${Array.isArray(data?.rates) ? data.rates.length : 0}`
    )
    return null
  }

  return { standard, express }
}
