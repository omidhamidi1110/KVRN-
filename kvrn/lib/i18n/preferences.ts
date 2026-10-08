// lib/i18n/preferences.ts — the visitor's language + currency choice. PURE.
//
// WHERE IT LIVES
//   Two first-party cookies, readable by the server so the very first HTML already has the right
//   `<html lang dir>`, text and prices (no English flash, no USD→EUR flash):
//     kvrn_locale    one of the 10 locale codes
//     kvrn_currency  one of the currency codes
//   Both are SameSite=Lax, Secure on https, one year, path=/, NOT HttpOnly (the client switcher
//   writes them), and carry no personal data. localStorage mirrors them for visitors who chose
//   before the cookies existed (migrated once on their next visit).
//
// LANGUAGE AND CURRENCY STAY SEPARATE
//   Choosing a language applies that language's configured default currency (applyLanguageChange).
//   The currency selector then overrides it, independently. Choosing a language again re-applies
//   the new language's default.

import { isLocale, SOURCE_LOCALE, type Locale } from './locales'
import { isCurrencyCode, DEFAULT_CURRENCY, type CurrencyCode } from '../currency'
import type { I18nConfig } from './config'

export const LOCALE_COOKIE = 'kvrn_locale'
export const CURRENCY_COOKIE = 'kvrn_currency'
export const LOCALE_STORAGE_KEY = 'kvrn_locale'
export const CURRENCY_STORAGE_KEY = 'kvrn_currency'
export const PREFERENCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export interface Preferences { locale: Locale; currency: CurrencyCode }

export interface ResolveInput {
  localeCookie?: string | null
  currencyCookie?: string | null
  config: I18nConfig
  /** Locales whose static dictionary is complete. Only these may be served. */
  readyLocales: readonly Locale[]
  /** Currencies that may be shown right now (USD + enabled currencies with a usable rate). */
  displayable: readonly CurrencyCode[]
}

export function servedLocales(config: I18nConfig, readyLocales: readonly Locale[]): Locale[] {
  return config.enabledLocales.filter(l => l === SOURCE_LOCALE || readyLocales.includes(l))
}

/** The default currency for a locale, if it can be shown; USD otherwise. */
export function defaultCurrencyFor(locale: Locale, config: I18nConfig, displayable: readonly CurrencyCode[]): CurrencyCode {
  const c = config.defaultCurrencyByLocale[locale]
  return c && displayable.includes(c) ? c : DEFAULT_CURRENCY
}

/**
 * Turn raw cookie values into a safe preference. Every input is untrusted: an unknown, disabled
 * or unready locale falls back to English; a currency that is unknown, not enabled or without a
 * usable rate falls back to the locale's default (and then USD). Never throws.
 */
export function resolvePreferences(i: ResolveInput): Preferences & { localeFromCookie: boolean; currencyFromCookie: boolean } {
  const served = servedLocales(i.config, i.readyLocales)
  const lc = i.localeCookie ?? null
  const localeOk = isLocale(lc) && served.includes(lc)
  const locale: Locale = localeOk ? (lc as Locale) : SOURCE_LOCALE

  const cc = i.currencyCookie ?? null
  const currencyOk = isCurrencyCode(cc) && i.displayable.includes(cc)
  const currency: CurrencyCode = currencyOk ? (cc as CurrencyCode) : defaultCurrencyFor(locale, i.config, i.displayable)
  return { locale, currency, localeFromCookie: localeOk, currencyFromCookie: currencyOk }
}

/** The result of the visitor choosing a language: that language, and its default currency. */
export function applyLanguageChange(
  next: Locale, config: I18nConfig, displayable: readonly CurrencyCode[],
): Preferences {
  return { locale: next, currency: defaultCurrencyFor(next, config, displayable) }
}

/** The result of the visitor choosing a currency: only the currency changes. */
export function applyCurrencyChange(
  current: Preferences, next: CurrencyCode, displayable: readonly CurrencyCode[],
): Preferences {
  return displayable.includes(next) ? { ...current, currency: next } : current
}

/** Pull one cookie out of a `Cookie:` request header (no decoding surprises: our values are [A-Za-z]). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim()
      return /^[A-Za-z0-9_-]{1,12}$/.test(v) ? v : null
    }
  }
  return null
}

/** `document.cookie` assignment string for one preference. */
export function serializePreferenceCookie(name: string, value: string, opts: { secure: boolean }): string {
  if (name !== LOCALE_COOKIE && name !== CURRENCY_COOKIE) throw new Error('Unknown preference cookie.')
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(value)) throw new Error('Invalid preference value.')
  return `${name}=${value}; Path=/; Max-Age=${PREFERENCE_MAX_AGE_SECONDS}; SameSite=Lax${opts.secure ? '; Secure' : ''}`
}

/** Event the providers use to stay in step (and the layout uses to refresh server-rendered data). */
export const PREFERENCES_CHANGED_EVENT = 'kvrn-preferences-changed'
