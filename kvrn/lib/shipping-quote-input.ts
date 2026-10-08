// Pure, server-side guard for the public shipping preview endpoint.
// Normal checkout uses the same 10-unit-per-line ceiling; this guard also caps
// total work before calling Shippo (international quotes can create one request/parcel).
export type ShippingQuoteInput = {
  city: string; state: string; zip: string; country: string
  items: Array<{ sku: string; quantity: number }>
}

type Parsed = { ok: true; value: ShippingQuoteInput } | { ok: false; reason: string }

export function parseShippingQuoteInput(raw: unknown): Parsed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'Invalid shipping request.' }
  const data = raw as Record<string, unknown>
  const field = (key: string, maxLength: number): string | null => {
    const v = data[key]
    return v === undefined || v === null ? '' : typeof v === 'string' && v.length <= maxLength ? v.trim() : null
  }
  const city = field('city', 100), state = field('state', 80), zip = field('zip', 24)
  const countryRaw = field('country', 2)
  if (city === null || state === null || zip === null || countryRaw === null) return { ok: false, reason: 'Invalid address.' }
  const country = (countryRaw || 'US').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, reason: 'Invalid country.' }
  if (data.items !== undefined && !Array.isArray(data.items)) return { ok: false, reason: 'Invalid items.' }
  const items = (data.items ?? []) as unknown[]
  if (items.length > 20) return { ok: false, reason: 'Too many items.' }
  let units = 0
  const result: ShippingQuoteInput['items'] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'Invalid item.' }
    const { sku, quantity } = item as Record<string, unknown>
    if (typeof sku !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(sku)
      || !Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 10
      || seen.has(sku)) return { ok: false, reason: 'Invalid SKU or quantity.' }
    seen.add(sku)
    units += quantity as number
    if (units > 30) return { ok: false, reason: 'Too many units.' }
    result.push({ sku, quantity: quantity as number })
  }
  return { ok: true, value: { city, state, zip, country, items: result } }
}
