'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import {
  type CurrencyCode,
  type Currency,
  getCurrency,
  formatPrice as fmtPrice,
  readStoredCurrency,
  storeCurrency,
  DEFAULT_CURRENCY,
} from '@/lib/currency'

interface CurrencyContextValue {
  currencyCode:  CurrencyCode
  currency:      Currency
  setCurrency:   (code: CurrencyCode) => void
  formatPrice:   (usdCents: number) => string
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [code, setCode] = useState<CurrencyCode>(DEFAULT_CURRENCY)

  // Hydrate from localStorage after mount
  useEffect(() => {
    setCode(readStoredCurrency())
  }, [])

  const setCurrency = useCallback((c: CurrencyCode) => {
    setCode(c)
    storeCurrency(c)
  }, [])

  const currency = getCurrency(code)

  const formatPrice = useCallback(
    (usdCents: number) => fmtPrice(usdCents, currency),
    [currency]
  )

  return (
    <CurrencyContext.Provider value={{ currencyCode: code, currency, setCurrency, formatPrice }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used inside CurrencyProvider')
  return ctx
}
