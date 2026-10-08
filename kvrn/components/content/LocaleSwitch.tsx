'use client'

// Picks the server-rendered variant that matches the visitor's storefront language.
// The storefront language is seeded by app/layout.tsx from the kvrn_locale cookie (so the first
// paint already has it), and the server renders one variant per language that has PUBLISHED
// translations; this component shows the right one. A language without a published variant shows
// English, marked lang="en" (and with a short notice) so an English fallback is never presented as
// a translation. Its chrome is rendered in English too (LocaleScope), so the block never mixes two
// languages.

import type { ReactNode } from 'react'
import { useI18n, LocaleScope } from '@/context/I18nContext'
import { LOCALES, isLocale, SOURCE_LOCALE } from '@/lib/i18n/locales'
import { fillMessages } from '@/lib/i18n/messages'

export function LocaleSwitch({ variants }: { variants: Record<string, ReactNode> }) {
  const { locale, t: dict } = useI18n()
  const key = variants[locale] !== undefined ? locale : SOURCE_LOCALE
  const rtl = isLocale(key) ? LOCALES[key].rtl : false
  const fellBack = key !== locale
  const t = fillMessages(dict)
  return (
    <div lang={key} dir={rtl ? 'rtl' : undefined} style={{ display: 'contents' }}>
      <LocaleScope locale={isLocale(key) ? key : SOURCE_LOCALE}>{variants[key]}</LocaleScope>
      {fellBack && (
        <p lang={locale} role="note" className="container-kvrn max-w-3xl py-6 text-[12px] text-kvrn-muted" style={{ margin: '0 auto' }}>
          {t['content.englishOnly']}
        </p>
      )}
    </div>
  )
}
