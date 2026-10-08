// lib/i18n/server.ts — server-side read of the visitor's language + currency, and the
// Admin-managed settings behind them. Used by app/layout.tsx so the FIRST HTML already has the
// right <html lang dir>, text and prices.
//
// Never throws and never makes a page slower than a short, bounded wait: if the settings cannot
// be read in time the storefront renders English / USD (the shipped defaults) — a settings
// problem can only make the site plainer, not break it.

import { LOCALE_CODES, dirOf, type Locale } from './locales'
import { readyLocales } from './messages'
import {
  loadStorefrontI18nSettings, defaultI18nConfig, type I18nConfig, type StorefrontI18nSettings,
} from './config'
import { usableRate, type FxConfig } from './fx'
import { resolvePreferences, LOCALE_COOKIE, CURRENCY_COOKIE } from './preferences'
import { payableCurrencies } from './currency-policy'
import { CURRENCY_CODES, type CurrencyCode } from '../currency'
import { isFeatureEnabled } from '../feature-flags'

/** Everything the client providers are seeded with (serialisable). */
export interface StorefrontI18n {
  locale: Locale
  dir: 'ltr' | 'rtl'
  currency: CurrencyCode
  /** Whether each cookie was present and valid (a legacy visitor with only localStorage is migrated once). */
  hasLocaleCookie: boolean
  hasCurrencyCookie: boolean
  config: I18nConfig
  /** Locales whose static dictionary is complete AND enabled. */
  served: Locale[]
  /** Usable display rates (units per 1 USD); USD is implicit. Only fresh/stale, never expired. */
  rates: Partial<Record<CurrencyCode, number>>
  rateAsOf: string | null
  /** What the card can actually be charged in (today always ['USD']). */
  payable: CurrencyCode[]
}

const SETTINGS_TTL_MS = 30_000
const SETTINGS_TIMEOUT_MS = 800
let cache: { at: number; value: StorefrontI18nSettings } | null = null

export function __resetI18nSettingsCache() { cache = null }

function fallbackSettings(): StorefrontI18nSettings {
  const d = defaultI18nConfig()
  const ready = readyLocales()
  return { config: { ...d, enabledLocales: d.enabledLocales.filter(l => ready.includes(l)) }, fx: null }
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<T>(res => { timer = setTimeout(() => res(onTimeout()), ms) })])
  } finally { if (timer) clearTimeout(timer) }
}

export async function loadSettingsCached(sql: any, now: Date = new Date()): Promise<StorefrontI18nSettings> {
  if (cache && now.getTime() - cache.at < SETTINGS_TTL_MS) return cache.value
  const ready = readyLocales()
  let timedOut = false
  const value = await withTimeout(
    loadStorefrontI18nSettings(sql, ready, now),
    SETTINGS_TIMEOUT_MS,
    () => { timedOut = true; return fallbackSettings() },
  )
  // A timeout result is not cached as authoritative for long: retry on the next request.
  if (!timedOut) cache = { at: now.getTime(), value }
  return value
}

/** Display rates that may be used right now (expired/missing rates are dropped). */
export function displayRates(fx: FxConfig | null, enabled: readonly CurrencyCode[], now: Date): Partial<Record<CurrencyCode, number>> {
  const out: Partial<Record<CurrencyCode, number>> = {}
  for (const c of enabled) {
    if (c === 'USD') continue
    const r = usableRate(fx, c, now)
    if (r !== null) out[c] = r
  }
  return out
}

/** Pure assembly of the seed from raw cookies + settings (the unit-tested core). */
export function buildStorefrontI18n(input: {
  localeCookie: string | null; currencyCookie: string | null
  settings: StorefrontI18nSettings; now: Date; multiCurrencyFlag: boolean
}): StorefrontI18n {
  const { settings, now } = input
  const ready = readyLocales()
  const rates = displayRates(settings.fx, settings.config.enabledCurrencies, now)
  const displayable = ['USD' as CurrencyCode, ...(Object.keys(rates) as CurrencyCode[])]
  const prefs = resolvePreferences({
    localeCookie: input.localeCookie, currencyCookie: input.currencyCookie,
    config: settings.config, readyLocales: ready, displayable,
  })
  const served = LOCALE_CODES.filter(l => settings.config.enabledLocales.includes(l) && (l === 'en' || ready.includes(l)))
  return {
    locale: prefs.locale, dir: dirOf(prefs.locale), currency: prefs.currency,
    hasLocaleCookie: prefs.localeFromCookie, hasCurrencyCookie: prefs.currencyFromCookie,
    config: settings.config, served, rates,
    rateAsOf: Object.keys(rates).length ? (settings.fx?.asOf ?? null) : null,
    payable: payableCurrencies({ flagOn: input.multiCurrencyFlag, enabledCurrencies: settings.config.enabledCurrencies }),
  }
}

async function readCookies(): Promise<{ locale: string | null; currency: string | null }> {
  try {
    const { cookies } = await import('next/headers')
    const jar = await cookies()
    return { locale: jar.get(LOCALE_COOKIE)?.value ?? null, currency: jar.get(CURRENCY_COOKIE)?.value ?? null }
  } catch {
    // Outside a request (tests, static generation): no preference — English / USD.
    return { locale: null, currency: null }
  }
}

/** The request's language + currency. Reading cookies makes the caller dynamic (the layout already is). */
export async function getStorefrontI18n(sql: any): Promise<StorefrontI18n> {
  const [jar, settings] = await Promise.all([readCookies(), loadSettingsCached(sql)])
  return buildStorefrontI18n({
    localeCookie: jar.locale, currencyCookie: jar.currency, settings, now: new Date(),
    multiCurrencyFlag: isFeatureEnabled('MULTI_CURRENCY_CHECKOUT'),
  })
}

/** Locale only (for pages that localise text but not prices). */
export async function getRequestLocale(sql: any): Promise<Locale> {
  return (await getStorefrontI18n(sql)).locale
}

export const ALL_CURRENCIES = CURRENCY_CODES
