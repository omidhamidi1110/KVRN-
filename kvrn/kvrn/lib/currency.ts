// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY UTILITIES
//
// Prices are stored internally as USD cents (integers).
// All display prices are converted via formatPrice() using the active currency.
// Exchange rates are approximations — actual rates applied at Stripe checkout.
// ─────────────────────────────────────────────────────────────────────────────

export type CurrencyCode =
  | 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD'
  | 'AED' | 'JPY' | 'CNY' | 'MXN' | 'SAR'

export interface Currency {
  code:      CurrencyCode
  label:     string
  symbol:    string
  rate:      number   // Exchange rate vs USD
  decimals:  number   // Number of decimal places to show
  locale:    string   // Intl.NumberFormat locale
}

export const CURRENCIES: Currency[] = [
  { code: 'USD', label: 'USD — US Dollar',        symbol: '$',  rate: 1,      decimals: 0, locale: 'en-US' },
  { code: 'EUR', label: 'EUR — Euro',              symbol: '€',  rate: 0.93,   decimals: 0, locale: 'de-DE' },
  { code: 'GBP', label: 'GBP — British Pound',    symbol: '£',  rate: 0.79,   decimals: 0, locale: 'en-GB' },
  { code: 'CAD', label: 'CAD — Canadian Dollar',  symbol: 'CA$',rate: 1.38,   decimals: 0, locale: 'en-CA' },
  { code: 'AUD', label: 'AUD — Australian Dollar',symbol: 'A$', rate: 1.55,   decimals: 0, locale: 'en-AU' },
  { code: 'AED', label: 'AED — UAE Dirham',       symbol: 'AED',rate: 3.67,   decimals: 0, locale: 'ar-AE' },
  { code: 'JPY', label: 'JPY — Japanese Yen',     symbol: '¥',  rate: 157,    decimals: 0, locale: 'ja-JP' },
  { code: 'CNY', label: 'CNY — Chinese Yuan',     symbol: '¥',  rate: 7.25,   decimals: 0, locale: 'zh-CN' },
  { code: 'MXN', label: 'MXN — Mexican Peso',     symbol: 'MX$',rate: 17.5,   decimals: 0, locale: 'es-MX' },
  { code: 'SAR', label: 'SAR — Saudi Riyal',      symbol: 'SAR',rate: 3.75,   decimals: 0, locale: 'ar-SA' },
]

export const DEFAULT_CURRENCY: CurrencyCode = 'USD'
export const FREE_SHIPPING_THRESHOLD_CENTS = 15000 // $150 USD

export function getCurrency(code: CurrencyCode): Currency {
  return CURRENCIES.find(c => c.code === code) ?? CURRENCIES[0]
}

/**
 * Format a USD-cent price into display string for the given currency.
 * usdCents: e.g. 24000 = $240
 */
export function formatPrice(usdCents: number, currency: Currency): string {
  const amount = (usdCents / 100) * currency.rate

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
 * Returns the free-shipping threshold for a given currency.
 */
export function freeShippingThreshold(currency: Currency): string {
  return formatPrice(FREE_SHIPPING_THRESHOLD_CENTS, currency)
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

const CURRENCY_STORAGE_KEY = 'kvrn_currency'

export function readStoredCurrency(): CurrencyCode {
  if (typeof window === 'undefined') return DEFAULT_CURRENCY
  const stored = localStorage.getItem(CURRENCY_STORAGE_KEY) as CurrencyCode | null
  if (stored && CURRENCIES.some(c => c.code === stored)) return stored
  return DEFAULT_CURRENCY
}

export function storeCurrency(code: CurrencyCode): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CURRENCY_STORAGE_KEY, code)
}
