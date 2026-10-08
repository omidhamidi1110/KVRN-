'use client'

// Storefront display currency.
//
// Prices are USD cents and are CHARGED in USD. A non-USD selection is an ESTIMATE built from a
// dated, Admin-configured rate (site_settings `i18n.fx`) handed in by app/layout.tsx; there are no
// built-in rates. With no usable rate for a currency it is not offered, and the price is USD.
// See lib/i18n/currency-policy.ts for what can be charged (today: USD only).
//
// FIRST RENDER: the layout reads the kvrn_currency cookie on the server and seeds this provider,
// so there is no USD → EUR flash after hydration. With no props it renders USD.

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import {
  type CurrencyCode,
  type Currency,
  CURRENCIES,
  getCurrency,
  isCurrencyCode,
  formatPrice as fmtPrice,
  readStoredCurrency,
  DEFAULT_CURRENCY,
} from '@/lib/currency'
import { PREFERENCES_CHANGED_EVENT } from '@/lib/i18n/preferences'
import { persistCurrency, announcePreferences, type PreferenceChange } from '@/context/I18nContext'
import { useStorefrontSeed } from '@/context/StorefrontSeed'

interface CurrencyContextValue {
  /** The selected (and displayed) currency. */
  currencyCode:  CurrencyCode
  currency:      Currency
  setCurrency:   (code: CurrencyCode) => void
  /** USD cents → display string. Non-USD results carry a leading "≈" (an estimate). */
  formatPrice:   (usdCents: number) => string
  /** Currencies the visitor can choose now (USD plus those with a usable configured rate). */
  available:     Currency[]
  /** True when the shown amounts are converted estimates, not the USD price. */
  isEstimate:    boolean
  /** Date of the rates used, when estimating. */
  rateAsOf:      string | null
  /** What the card is charged in. Always an element of `payable`. */
  chargedIn:     CurrencyCode
  payable:       CurrencyCode[]
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

interface ProviderProps {
  children: React.ReactNode
  initialCurrency?: CurrencyCode
  hasCurrencyCookie?: boolean
  /** Usable display rates (units per 1 USD), already filtered for freshness on the server. */
  rates?: Partial<Record<CurrencyCode, number>>
  rateAsOf?: string | null
  payable?: CurrencyCode[]
}

const NO_RATES: Partial<Record<CurrencyCode, number>> = {}
const ONLY_USD: CurrencyCode[] = ['USD']

export function CurrencyProvider({
  children, initialCurrency: pCurrency, hasCurrencyCookie: pHas, rates: pRates, rateAsOf: pAsOf, payable: pPayable,
}: ProviderProps) {
  // Explicit props win; otherwise the values app/layout.tsx read on the server (StorefrontSeed).
  const seed = useStorefrontSeed()
  const initialCurrency   = pCurrency ?? seed?.currency ?? DEFAULT_CURRENCY
  const hasCurrencyCookie = pHas ?? seed?.hasCurrencyCookie ?? true
  const rates             = pRates ?? seed?.rates ?? NO_RATES
  const rateAsOf          = pAsOf !== undefined ? pAsOf : (seed?.rateAsOf ?? null)
  const payable           = pPayable ?? seed?.payable ?? ONLY_USD
  const availableCodes = useMemo<CurrencyCode[]>(
    () => ['USD', ...(Object.keys(rates) as CurrencyCode[]).filter(c => c !== 'USD' && isCurrencyCode(c))], [rates])
  const safeInitial = availableCodes.includes(initialCurrency) ? initialCurrency : DEFAULT_CURRENCY
  const [code, setCode] = useState<CurrencyCode>(safeInitial)

  // A server refresh is the source of truth for the cookie's value.
  useEffect(() => { setCode(availableCodes.includes(initialCurrency) ? initialCurrency : DEFAULT_CURRENCY) }, [initialCurrency, availableCodes])

  // A visitor who chose before the cookie existed: apply their old localStorage choice once.
  useEffect(() => {
    if (hasCurrencyCookie) return
    const stored = readStoredCurrency()
    if (stored !== DEFAULT_CURRENCY && availableCodes.includes(stored)) {
      setCode(stored)
      persistCurrency(stored)
      announcePreferences({ currency: stored })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The language switcher applies the new language's default currency by announcing it here.
  useEffect(() => {
    const h = (e: Event) => {
      const c = (e as CustomEvent<PreferenceChange>).detail?.currency
      if (c && availableCodes.includes(c)) setCode(c)
    }
    window.addEventListener(PREFERENCES_CHANGED_EVENT, h)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, h)
  }, [availableCodes])

  const setCurrency = useCallback((c: CurrencyCode) => {
    if (!availableCodes.includes(c)) return          // never select a currency we cannot show
    setCode(c)
    persistCurrency(c)
    announcePreferences({ currency: c })
  }, [availableCodes])

  const currency = getCurrency(code)
  const rate = code === 'USD' ? undefined : rates[code]
  const isEstimate = code !== 'USD' && typeof rate === 'number'

  const formatPrice = useCallback(
    (usdCents: number) => isEstimate
      ? `≈ ${fmtPrice(usdCents, currency, rate)}`
      : fmtPrice(usdCents, getCurrency('USD')),
    [isEstimate, currency, rate]
  )

  const available = useMemo(() => CURRENCIES.filter(c => availableCodes.includes(c.code)), [availableCodes])
  const value = useMemo<CurrencyContextValue>(() => ({
    currencyCode: code, currency, setCurrency, formatPrice, available, isEstimate,
    rateAsOf: isEstimate ? rateAsOf : null, chargedIn: 'USD', payable,
  }), [code, currency, setCurrency, formatPrice, available, isEstimate, rateAsOf, payable])

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
}

// Outside a provider (previews, isolated renders) prices are plain USD: the only currency that
// needs no rate. This never invents a conversion.
const USD_ONLY: CurrencyContextValue = {
  currencyCode: 'USD', currency: getCurrency('USD'), setCurrency: () => {},
  formatPrice: (cents: number) => fmtPrice(cents, getCurrency('USD')),
  available: CURRENCIES.filter(c => c.code === 'USD'), isEstimate: false, rateAsOf: null,
  chargedIn: 'USD', payable: ['USD'],
}

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext) ?? USD_ONLY
}
