// lib/i18n/fx.ts — the configured exchange-rate setting used ONLY to show approximate prices.
//
// site_settings key `i18n.fx`:
//   { rates: { EUR: 0.92, GBP: 0.79, ... },   // units of currency per 1 USD
//     asOf: "2026-10-01",                      // the date those rates were taken (YYYY-MM-DD)
//     source: "ECB euro foreign exchange reference rates" }   // a human note of where they came from
//
// KVRN does not fetch rates from anywhere: an owner types them in (Admin > Content > Languages &
// currency) and the page says when they were last updated. A rate shown to a customer is an
// ESTIMATE — the card is always charged in USD (lib/i18n/currency-policy.ts).
//
// Freshness (so a forgotten rate cannot linger as a quiet price):
//   fresh    <= 7 days old   shown as an estimate
//   stale    8–30 days old   still shown as an estimate; Admin shows a warning
//   expired  > 30 days old   NOT used — the storefront falls back to USD only
//   missing  no setting / no rate for that currency — USD only

import { CURRENCY_CODES, type CurrencyCode } from '../currency'

export const FX_KEY = 'i18n.fx'
export const FX_STALE_AFTER_DAYS = 7
export const FX_EXPIRED_AFTER_DAYS = 30
const DAY_MS = 86_400_000

export interface FxConfig {
  rates: Partial<Record<Exclude<CurrencyCode, 'USD'>, number>>
  asOf: string
  source: string
}

export type FxStatus = 'fresh' | 'stale' | 'expired' | 'missing'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function validateFx(input: unknown, now: Date = new Date()): { ok: true; value: FxConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['rates: Enter the exchange rates.'] }
  const rates: FxConfig['rates'] = {}
  const rawRates = isObj(input.rates) ? input.rates : {}
  for (const [code, v] of Object.entries(rawRates)) {
    if (code === 'USD') { errors.push('rates.USD: USD is the base currency; leave it out.'); continue }
    if (!(CURRENCY_CODES as readonly string[]).includes(code)) { errors.push(`rates.${code}: Unknown currency.`); continue }
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 100_000) {
      errors.push(`rates.${code}: Enter a positive number (units of ${code} per 1 USD).`); continue
    }
    rates[code as keyof FxConfig['rates']] = Number(n.toPrecision(8))
  }
  const asOf = typeof input.asOf === 'string' ? input.asOf.trim() : ''
  if (!DATE_RE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    errors.push('asOf: Enter the date these rates were taken (YYYY-MM-DD).')
  } else if (Date.parse(`${asOf}T00:00:00Z`) > now.getTime() + DAY_MS) {
    errors.push('asOf: This date is in the future.')
  }
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!source) errors.push('source: Say where the rates came from.')
  else if (source.length > 120) errors.push('source: Keep it under 120 characters.')
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { rates, asOf, source } }
}

/** Lenient read of a stored setting: anything malformed is treated as "no rates" (USD only). */
export function parseFx(value: unknown, now: Date = new Date()): FxConfig | null {
  const v = validateFx(value, new Date(now.getTime() + 366 * DAY_MS))   // tolerate clock skew when READING
  return v.ok ? v.value : null
}

export function fxAgeDays(fx: Pick<FxConfig, 'asOf'> | null, now: Date = new Date()): number | null {
  if (!fx) return null
  const t = Date.parse(`${fx.asOf}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

export function fxStatus(fx: FxConfig | null, now: Date = new Date()): FxStatus {
  const age = fxAgeDays(fx, now)
  if (age === null || !fx || Object.keys(fx.rates).length === 0) return 'missing'
  if (age > FX_EXPIRED_AFTER_DAYS) return 'expired'
  if (age > FX_STALE_AFTER_DAYS) return 'stale'
  return 'fresh'
}

/**
 * The rate to display `code` with, or null when it must not be converted. USD is always 1.
 * An expired or missing rate returns null — the caller shows USD.
 */
export function usableRate(fx: FxConfig | null, code: CurrencyCode, now: Date = new Date()): number | null {
  if (code === 'USD') return 1
  const s = fxStatus(fx, now)
  if (s === 'missing' || s === 'expired') return null
  const r = fx?.rates[code as keyof FxConfig['rates']]
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null
}

/** Currencies a visitor may see prices in right now: USD plus every enabled currency with a usable rate. */
export function displayableCurrencies(fx: FxConfig | null, enabled: readonly CurrencyCode[], now: Date = new Date()): CurrencyCode[] {
  const out: CurrencyCode[] = ['USD']
  for (const c of enabled) if (c !== 'USD' && usableRate(fx, c, now) !== null && !out.includes(c)) out.push(c)
  return out
}
