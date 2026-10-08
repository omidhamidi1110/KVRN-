// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY UTILITIES (display metadata + formatting only)
//
// Prices are stored internally as USD cents (integers) and CHARGED in USD.
//
// This module deliberately holds NO exchange rates. The previous version shipped approximate
// constants (EUR 0.93, JPY 157, ...) that quietly became "the price" a visitor saw. A rate is
// now an explicit, Admin-configured, dated setting (site_settings `i18n.fx`, see lib/i18n/fx.ts)
// and is passed in by the caller. With no rate, a non-USD currency is formatted as USD — never
// guessed. Whether a currency may actually be CHARGED is a separate question answered by
// lib/i18n/currency-policy.ts; being formattable by Intl proves nothing about that.
// ─────────────────────────────────────────────────────────────────────────────

import { FREE_SHIPPING_THRESHOLD_CENTS as USD_FREE_SHIPPING_THRESHOLD_CENTS } from './free-shipping'

export type CurrencyCode =
  | 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD'
  | 'AED' | 'JPY' | 'CNY' | 'MXN' | 'SAR'

export interface Currency {
  code:      CurrencyCode
  label:     string
  symbol:    string
  decimals:  number   // Number of decimal places to show
  locale:    string   // Intl.NumberFormat locale
}

export const CURRENCIES: Currency[] = [
  { code: 'USD', label: 'USD — US Dollar',        symbol: '$',  decimals: 0, locale: 'en-US' },
  { code: 'EUR', label: 'EUR — Euro',              symbol: '€',  decimals: 0, locale: 'de-DE' },
  { code: 'GBP', label: 'GBP — British Pound',    symbol: '£',  decimals: 0, locale: 'en-GB' },
  { code: 'CAD', label: 'CAD — Canadian Dollar',  symbol: 'CA$',decimals: 0, locale: 'en-CA' },
  { code: 'AUD', label: 'AUD — Australian Dollar',symbol: 'A$', decimals: 0, locale: 'en-AU' },
  { code: 'AED', label: 'AED — UAE Dirham',       symbol: 'AED',decimals: 0, locale: 'ar-AE' },
  { code: 'JPY', label: 'JPY — Japanese Yen',     symbol: '¥',  decimals: 0, locale: 'ja-JP' },
  { code: 'CNY', label: 'CNY — Chinese Yuan',     symbol: '¥',  decimals: 0, locale: 'zh-CN' },
  { code: 'MXN', label: 'MXN — Mexican Peso',     symbol: 'MX$',decimals: 0, locale: 'es-MX' },
  { code: 'SAR', label: 'SAR — Saudi Riyal',      symbol: 'SAR',decimals: 0, locale: 'ar-SA' },
]

export const CURRENCY_CODES: readonly CurrencyCode[] = CURRENCIES.map(c => c.code)

export const DEFAULT_CURRENCY: CurrencyCode = 'USD'

/**
 * The ONE free-shipping business rule: $150.00 USD (lib/free-shipping.ts is the source). It is
 * never defined per currency — a non-USD display shows an estimate of this same USD threshold.
 */
export const FREE_SHIPPING_THRESHOLD_CENTS = USD_FREE_SHIPPING_THRESHOLD_CENTS

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === 'string' && (CURRENCY_CODES as readonly string[]).includes(v)
}

export function getCurrency(code: CurrencyCode): Currency {
  return CURRENCIES.find(c => c.code === code) ?? CURRENCIES[0]
}

/** Format a major-unit amount (e.g. 240 = $240) in a currency's style. */
export function formatAmount(amount: number, currency: Currency): string {
  // JPY and similar — no decimal needed
  if (currency.decimals === 0) {
    const rounded = Math.round(amount)
    return `${currency.symbol}${rounded.toLocaleString(currency.locale)}`
  }

  return new Intl.NumberFormat(currency.locale, {
    style:    'currency',
    currency: currency.code,
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  }).format(amount)
}

/**
 * Format a USD-cent price for display in `currency`.
 *
 *   usdCents  e.g. 24000 = $240
 *   rate      units of `currency` per 1 USD, from the configured FX setting. Required for any
 *             non-USD currency: without it the price is shown in USD (a price is never invented).
 *
 * USD output is exactly what the storefront has always rendered ("$240").
 */
export function formatPrice(usdCents: number, currency: Currency, rate?: number): string {
  if (currency.code === 'USD' || !(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) {
    // A real USD amount is never silently rounded: $79.50 stays "$79.50" (whole dollars stay "$80").
    if (Number.isFinite(usdCents) && usdCents % 100 !== 0) {
      return `$${(usdCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }
    return formatAmount(usdCents / 100, CURRENCIES[0])
  }
  return formatAmount((usdCents / 100) * rate, currency)
}

/** Free-shipping threshold, shown in USD (the rule's own currency). */
export function freeShippingThreshold(currency: Currency, rate?: number): string {
  return formatPrice(FREE_SHIPPING_THRESHOLD_CENTS, currency, rate)
}

/**
 * Returns cents remaining until free shipping.
 * cartUsdCents: current cart value in USD cents.
 */
export function centsToFreeShipping(cartUsdCents: number): number {
  return Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - cartUsdCents)
}

/**
 * Returns 0–100 progress toward free shipping.
 */
export function shippingProgressPct(cartUsdCents: number): number {
  return Math.min(100, (cartUsdCents / FREE_SHIPPING_THRESHOLD_CENTS) * 100)
}

// ── Browser persistence ─────────────────────────────────────────────────────────
// The currency choice lives in a first-party cookie (read by the server so the first paint
// already shows the right currency) mirrored into localStorage. See lib/i18n/preferences.ts.

const CURRENCY_STORAGE_KEY = 'kvrn_currency'

export function readStoredCurrency(): CurrencyCode {
  if (typeof window === 'undefined') return DEFAULT_CURRENCY
  try {
    const stored = localStorage.getItem(CURRENCY_STORAGE_KEY)
    if (isCurrencyCode(stored)) return stored
  } catch { /* storage blocked */ }
  return DEFAULT_CURRENCY
}

export function storeCurrency(code: CurrencyCode): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(CURRENCY_STORAGE_KEY, code) } catch { /* storage blocked */ }
}
