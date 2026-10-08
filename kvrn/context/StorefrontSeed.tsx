'use client'

// What app/layout.tsx read on the server (the visitor's kvrn_locale / kvrn_currency cookies, the Admin
// language + currency settings and the usable display rates), handed to the language and currency
// providers through context so the provider tree in the layout stays exactly
//   <I18nProvider> … <CurrencyProvider> …
// without per-provider props. Providers still accept the same values as explicit props (tests,
// previews); an explicit prop wins over the seed. With neither, they render English / USD.

import { createContext, useContext } from 'react'
import type { Locale } from '@/lib/i18n/locales'
import type { I18nConfig } from '@/lib/i18n/config'
import type { CurrencyCode } from '@/lib/currency'

export interface StorefrontSeed {
  locale: Locale
  hasLocaleCookie: boolean
  config: I18nConfig
  served: Locale[]
  /** Currencies that can be shown now (USD + those with a usable configured rate). */
  displayable: CurrencyCode[]
  currency: CurrencyCode
  hasCurrencyCookie: boolean
  rates: Partial<Record<CurrencyCode, number>>
  rateAsOf: string | null
  payable: CurrencyCode[]
}

const SeedContext = createContext<StorefrontSeed | null>(null)

export function StorefrontSeedProvider({ seed, children }: { seed: StorefrontSeed; children: React.ReactNode }) {
  return <SeedContext.Provider value={seed}>{children}</SeedContext.Provider>
}

export function useStorefrontSeed(): StorefrontSeed | null {
  return useContext(SeedContext)
}
