'use client'

// Storefront language. The dictionaries live in lib/i18n/messages (one complete file per locale);
// the locale registry in lib/i18n/locales; the cookie / default-currency rules in
// lib/i18n/preferences. This file only wires them to React.
//
// FIRST RENDER: app/layout.tsx reads the visitor's cookies on the server and seeds this provider
// (`initialLocale`), so server HTML and the client's first render agree — no English flash.
// With no props (tests, previews) it renders English.

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { LOCALES, LOCALE_CODES, isLocale, dirOf, SOURCE_LOCALE, type Locale } from '@/lib/i18n/locales'
import { MESSAGES, EN, type Messages } from '@/lib/i18n/messages'
import { defaultI18nConfig, type I18nConfig } from '@/lib/i18n/config'
import {
  LOCALE_COOKIE, CURRENCY_COOKIE, LOCALE_STORAGE_KEY, CURRENCY_STORAGE_KEY,
  PREFERENCES_CHANGED_EVENT, applyLanguageChange, serializePreferenceCookie,
} from '@/lib/i18n/preferences'
import type { CurrencyCode } from '@/lib/currency'
import { useStorefrontSeed } from '@/context/StorefrontSeed'

export type { Locale }

export interface LangOption { code: Locale; label: string; nativeLabel: string; rtl?: boolean }

/** Every language the codebase has a dictionary for (the selector lists only the served ones). */
export const LANGUAGES: LangOption[] = LOCALE_CODES.map(c => {
  const m = LOCALES[c]
  return { code: c, label: m.label, nativeLabel: m.nativeLabel, ...(m.rtl ? { rtl: true } : {}) }
})

interface I18nCtx {
  locale:    Locale
  setLocale: (l: Locale) => void
  t:         Messages
  isRTL:     boolean
  dir:       'ltr' | 'rtl'
  /** The languages the visitor may choose from (enabled in Admin and fully translated). */
  languages: LangOption[]
}

const I18nContext = createContext<I18nCtx>({
  locale: 'en', setLocale: () => {}, t: EN, isRTL: false, dir: 'ltr', languages: LANGUAGES,
})

export interface PreferenceChange { locale?: Locale; currency?: CurrencyCode }

function writeCookie(name: string, value: string) {
  try {
    document.cookie = serializePreferenceCookie(name, value, { secure: window.location.protocol === 'https:' })
  } catch { /* cookies blocked: the choice still applies for this page view */ }
}
function writeStorage(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* storage blocked */ }
}

/** Persist a currency choice (cookie + localStorage) and tell the other provider. */
export function persistCurrency(currency: CurrencyCode) {
  writeCookie(CURRENCY_COOKIE, currency)
  writeStorage(CURRENCY_STORAGE_KEY, currency)
}

export function announcePreferences(change: PreferenceChange) {
  try { window.dispatchEvent(new CustomEvent<PreferenceChange>(PREFERENCES_CHANGED_EVENT, { detail: change })) } catch { /* ignore */ }
}

interface ProviderProps {
  children: React.ReactNode
  /** Server-resolved language (from the kvrn_locale cookie). */
  initialLocale?: Locale
  /** Whether the server saw a valid kvrn_locale cookie. false → migrate a legacy localStorage choice once. */
  hasLocaleCookie?: boolean
  /** Admin language / currency configuration. */
  config?: I18nConfig
  /** Languages enabled AND fully translated. */
  served?: Locale[]
  /** Currencies that can be shown right now (for applying a language's default currency). */
  displayable?: CurrencyCode[]
}

export function I18nProvider({
  children, initialLocale: pLocale, hasLocaleCookie: pHas, config: pConfig, served: pServed, displayable: pShown,
}: ProviderProps) {
  // Explicit props win; otherwise the values app/layout.tsx read on the server (StorefrontSeed).
  const seed = useStorefrontSeed()
  const initialLocale   = pLocale ?? seed?.locale ?? SOURCE_LOCALE
  const hasLocaleCookie = pHas ?? seed?.hasLocaleCookie ?? true
  const config          = pConfig ?? seed?.config
  const served          = pServed ?? seed?.served
  const displayable     = pShown ?? seed?.displayable
  const cfg = useMemo(() => config ?? defaultI18nConfig(), [config])
  const offered = useMemo<Locale[]>(() => served ?? [...LOCALE_CODES], [served])
  const shown  = useMemo<CurrencyCode[]>(() => displayable ?? ['USD'], [displayable])
  const [locale, setLocaleState] = useState<Locale>(isLocale(initialLocale) ? initialLocale : SOURCE_LOCALE)

  // A server refresh (after a switch, or another tab changed the cookie) is the source of truth.
  useEffect(() => { if (isLocale(initialLocale)) setLocaleState(initialLocale) }, [initialLocale])

  // Visitors who chose a language before the cookie existed: apply it once, then the cookie takes over.
  useEffect(() => {
    if (hasLocaleCookie) return
    let stored: string | null = null
    try { stored = window.localStorage.getItem(LOCALE_STORAGE_KEY) } catch { /* blocked */ }
    if (isLocale(stored) && stored !== SOURCE_LOCALE && offered.includes(stored)) {
      setLocaleState(stored)
      writeCookie(LOCALE_COOKIE, stored)
      applyToDocument(stored)
      announcePreferences({ locale: stored })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setLocale = useCallback((l: Locale) => {
    if (!isLocale(l) || !offered.includes(l)) return
    // Language and currency stay separate values, but choosing a language applies its default currency.
    const next = applyLanguageChange(l, cfg, shown)
    setLocaleState(l)
    writeStorage(LOCALE_STORAGE_KEY, l)
    writeCookie(LOCALE_COOKIE, l)
    persistCurrency(next.currency)
    applyToDocument(l)
    announcePreferences({ locale: l, currency: next.currency })
  }, [offered, cfg, shown])

  const languages = useMemo(() => LANGUAGES.filter(l => offered.includes(l.code)), [offered])
  const value = useMemo<I18nCtx>(() => ({
    locale, setLocale, t: MESSAGES[locale], isRTL: LOCALES[locale].rtl, dir: dirOf(locale), languages,
  }), [locale, setLocale, languages])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

function applyToDocument(l: Locale) {
  try {
    document.documentElement.dir  = dirOf(l)
    document.documentElement.lang = l
  } catch { /* no document */ }
}

export function useI18n() { return useContext(I18nContext) }

/**
 * Render a subtree in a specific language regardless of the visitor's: used where a block is shown
 * in English because it has no published translation, so its chrome (Home, Breadcrumb, buttons)
 * matches its text instead of mixing two languages. Switching the site language still works (the
 * parent's setLocale is passed through).
 */
export function LocaleScope({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const parent = useContext(I18nContext)
  const value = useMemo<I18nCtx>(() => ({
    ...parent, locale, t: MESSAGES[locale], isRTL: LOCALES[locale].rtl, dir: dirOf(locale),
  }), [parent, locale])
  if (parent.locale === locale) return <>{children}</>
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
