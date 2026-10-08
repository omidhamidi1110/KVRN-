// lib/i18n/locales.ts — the storefront locale registry. PURE (safe in client and server bundles).
//
// One row per locale the storefront CAN serve. Whether a locale is actually offered to customers
// is decided by (a) its static dictionary being complete (lib/i18n/messages) and (b) the
// Admin-managed list in site_settings `i18n.config` (lib/i18n/config.ts).

export const LOCALE_CODES = ['en', 'es', 'fr', 'ar', 'zh', 'hi', 'pt', 'de', 'ja', 'ko'] as const
export type Locale = typeof LOCALE_CODES[number]

/** The source language: every translation is written against English. */
export const SOURCE_LOCALE: Locale = 'en'

export interface LocaleMeta {
  code: Locale
  /** English name (Admin and the second line of the language list). */
  label: string
  /** The language's own name (what the visitor recognises). */
  nativeLabel: string
  rtl: boolean
  /** BCP-47 tag for Intl formatting and `<html lang>`. */
  intl: string
  /**
   * Stripe-hosted Checkout `locale` value for this language, or null when Stripe Checkout does
   * not support it (checked against the installed SDK's types: stripe@16 Checkout.SessionCreateParams.Locale).
   */
  stripeLocale: string | null
}

export const LOCALES: Readonly<Record<Locale, LocaleMeta>> = {
  en: { code: 'en', label: 'English',    nativeLabel: 'English',    rtl: false, intl: 'en-US', stripeLocale: 'en' },
  es: { code: 'es', label: 'Spanish',    nativeLabel: 'Español',    rtl: false, intl: 'es',    stripeLocale: 'es' },
  fr: { code: 'fr', label: 'French',     nativeLabel: 'Français',   rtl: false, intl: 'fr',    stripeLocale: 'fr' },
  ar: { code: 'ar', label: 'Arabic',     nativeLabel: 'العربية',    rtl: true,  intl: 'ar',    stripeLocale: null },
  zh: { code: 'zh', label: 'Chinese',    nativeLabel: '中文',        rtl: false, intl: 'zh-CN', stripeLocale: 'zh' },
  hi: { code: 'hi', label: 'Hindi',      nativeLabel: 'हिन्दी',       rtl: false, intl: 'hi',    stripeLocale: null },
  pt: { code: 'pt', label: 'Portuguese', nativeLabel: 'Português',  rtl: false, intl: 'pt',    stripeLocale: 'pt' },
  de: { code: 'de', label: 'German',     nativeLabel: 'Deutsch',    rtl: false, intl: 'de',    stripeLocale: 'de' },
  ja: { code: 'ja', label: 'Japanese',   nativeLabel: '日本語',      rtl: false, intl: 'ja',    stripeLocale: 'ja' },
  ko: { code: 'ko', label: 'Korean',     nativeLabel: '한국어',      rtl: false, intl: 'ko',    stripeLocale: 'ko' },
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v)
}

export const dirOf = (l: Locale): 'ltr' | 'rtl' => (LOCALES[l].rtl ? 'rtl' : 'ltr')

/** Stripe-hosted Checkout `locale` for a KVRN locale; 'auto' (Stripe picks from the browser) when unsupported. */
export function toStripeLocale(l: Locale): string {
  return LOCALES[l].stripeLocale ?? 'auto'
}
