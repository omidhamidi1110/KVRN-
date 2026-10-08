// lib/i18n/config.ts — the Admin-managed language / currency configuration.
//
// site_settings key `i18n.config`:
//   { enabledLocales: ["en","es",...],
//     defaultCurrencyByLocale: { en: "USD", es: "USD", ... },
//     enabledCurrencies: ["USD", ...] }
//
// RULES (enforced here, once, for the Admin API and for every reader):
//   * English is always enabled (it is the source language and the safe fallback).
//   * A locale whose static dictionary is incomplete CANNOT be enabled, and is never served even
//     if an old setting lists it (readers intersect with the ready list).
//   * Every enabled locale has a default currency, and that currency must be enabled.
//   * The shipped default changes nothing: all locales default to USD and only USD is enabled, so
//     choosing a language never changes the price currency until an owner configures it.
//
// PURE — no DB, no React. `loadI18nConfig(sql)` is the one server-side reader.

import { LOCALE_CODES, SOURCE_LOCALE, isLocale, type Locale } from './locales'
import { CURRENCY_CODES, DEFAULT_CURRENCY, isCurrencyCode, type CurrencyCode } from '../currency'
import { FX_KEY, parseFx, type FxConfig } from './fx'

export const I18N_CONFIG_KEY = 'i18n.config'

export interface I18nConfig {
  enabledLocales: Locale[]
  defaultCurrencyByLocale: Record<Locale, CurrencyCode>
  enabledCurrencies: CurrencyCode[]
}

export function defaultI18nConfig(): I18nConfig {
  return {
    enabledLocales: [...LOCALE_CODES],
    defaultCurrencyByLocale: Object.fromEntries(LOCALE_CODES.map(l => [l, DEFAULT_CURRENCY])) as Record<Locale, CurrencyCode>,
    enabledCurrencies: [DEFAULT_CURRENCY],
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function uniq<T>(xs: T[]): T[] { return xs.filter((x, i) => xs.indexOf(x) === i) }

/**
 * Lenient read of the stored setting (storefront side): anything malformed degrades to the
 * shipped default for that part. Never throws.
 */
export function parseI18nConfig(value: unknown, readyLocales: readonly Locale[] = LOCALE_CODES): I18nConfig {
  const d = defaultI18nConfig()
  if (!isObj(value)) return { ...d, enabledLocales: d.enabledLocales.filter(l => readyLocales.includes(l)) }

  const rawLocales = Array.isArray(value.enabledLocales) ? value.enabledLocales.filter(isLocale) : d.enabledLocales
  const enabledLocales = uniq([SOURCE_LOCALE, ...rawLocales]).filter(l => l === SOURCE_LOCALE || readyLocales.includes(l))

  const rawCurrencies = Array.isArray(value.enabledCurrencies) ? value.enabledCurrencies.filter(isCurrencyCode) : d.enabledCurrencies
  const enabledCurrencies = uniq<CurrencyCode>([DEFAULT_CURRENCY, ...rawCurrencies])

  const byLocale = isObj(value.defaultCurrencyByLocale) ? value.defaultCurrencyByLocale : {}
  const defaultCurrencyByLocale = { ...d.defaultCurrencyByLocale }
  for (const l of LOCALE_CODES) {
    const c = byLocale[l]
    defaultCurrencyByLocale[l] = isCurrencyCode(c) && enabledCurrencies.includes(c) ? c : DEFAULT_CURRENCY
  }
  return { enabledLocales, defaultCurrencyByLocale, enabledCurrencies }
}

/** Strict validation for the Admin save. Returns field-path messages ("path: message"). */
export function validateI18nConfig(
  input: unknown, readyLocales: readonly Locale[],
): { ok: true; value: I18nConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['enabledLocales: Choose the languages to offer.'] }

  const locales: Locale[] = []
  if (!Array.isArray(input.enabledLocales)) errors.push('enabledLocales: Choose the languages to offer.')
  else for (const l of input.enabledLocales) {
    if (!isLocale(l)) { errors.push(`enabledLocales: "${String(l).slice(0, 12)}" is not a known language.`); continue }
    if (l !== SOURCE_LOCALE && !readyLocales.includes(l)) errors.push(`enabledLocales.${l}: Not ready — some storefront wording is untranslated. Finish the translation first.`)
    if (!locales.includes(l)) locales.push(l)
  }
  if (!locales.includes(SOURCE_LOCALE)) errors.push('enabledLocales: English must stay enabled.')

  const currencies: CurrencyCode[] = []
  if (!Array.isArray(input.enabledCurrencies)) errors.push('enabledCurrencies: Choose the currencies to offer.')
  else for (const c of input.enabledCurrencies) {
    if (!isCurrencyCode(c)) { errors.push(`enabledCurrencies: "${String(c).slice(0, 12)}" is not a known currency.`); continue }
    if (!currencies.includes(c)) currencies.push(c)
  }
  if (!currencies.includes(DEFAULT_CURRENCY)) errors.push('enabledCurrencies: USD must stay enabled (it is what customers are charged in).')

  const byLocale = isObj(input.defaultCurrencyByLocale) ? input.defaultCurrencyByLocale : {}
  const defaults = {} as Record<Locale, CurrencyCode>
  for (const l of LOCALE_CODES) {
    const c = byLocale[l]
    // A disabled language is never served, so its stored default is tidied rather than rejected.
    if (!locales.includes(l)) { defaults[l] = isCurrencyCode(c) && currencies.includes(c) ? c : DEFAULT_CURRENCY; continue }
    if (!isCurrencyCode(c)) { errors.push(`defaultCurrencyByLocale.${l}: Choose a currency.`); defaults[l] = DEFAULT_CURRENCY; continue }
    if (!currencies.includes(c)) errors.push(`defaultCurrencyByLocale.${l}: ${c} is not an enabled currency.`)
    defaults[l] = c
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { enabledLocales: locales, defaultCurrencyByLocale: defaults, enabledCurrencies: currencies } }
}

export const ALL_CURRENCY_CODES = CURRENCY_CODES

type Sql = any

export interface StorefrontI18nSettings {
  config: I18nConfig
  fx: FxConfig | null
}

/**
 * Read `i18n.config` and `i18n.fx` in one query. NEVER throws: any failure (DB down, malformed
 * JSON) returns the shipped defaults — English / USD, no conversion — so a settings problem can
 * only ever make the site plainer, never break it.
 */
export async function loadStorefrontI18nSettings(
  sql: Sql, readyLocales: readonly Locale[] = LOCALE_CODES, now: Date = new Date(),
): Promise<StorefrontI18nSettings> {
  try {
    const rows = await sql`SELECT key, value FROM site_settings WHERE key IN (${I18N_CONFIG_KEY}, ${FX_KEY})` as Array<{ key: string; value: unknown }>
    const get = (k: string) => rows.find(r => r.key === k)?.value
    return { config: parseI18nConfig(get(I18N_CONFIG_KEY), readyLocales), fx: parseFx(get(FX_KEY), now) }
  } catch {
    const d = defaultI18nConfig()
    return { config: { ...d, enabledLocales: d.enabledLocales.filter(l => readyLocales.includes(l)) }, fx: null }
  }
}
