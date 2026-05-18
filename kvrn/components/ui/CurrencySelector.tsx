'use client'

import { useState, useRef, useEffect } from 'react'
import { useCurrency } from '@/context/CurrencyContext'
import { CURRENCIES, type CurrencyCode } from '@/lib/currency'
import { cn } from '@/lib/utils'

interface CurrencySelectorProps {
  className?: string
  align?:     'left' | 'right'
}

export function CurrencySelector({ className, align = 'right' }: CurrencySelectorProps) {
  const { currencyCode, setCurrency } = useCurrency()
  const [open, setOpen]               = useState(false)
  const ref                           = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const handleSelect = (code: CurrencyCode) => {
    setCurrency(code)
    setOpen(false)
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Currency: ${currencyCode}. Click to change.`}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-light tracking-widest text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
      >
        {currencyCode}
        <svg
          width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true"
          className={cn('transition-transform duration-200', open && 'rotate-180')}
        >
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div
          className={cn(
            'absolute top-full mt-2 z-[300]',
            'bg-kvrn-bg border border-kvrn-border py-1 min-w-[200px]',
            'max-h-[280px] overflow-y-auto scrollbar-thin',
            align === 'right' ? 'right-0' : 'left-0'
          )}
          role="listbox"
          aria-label="Select currency"
        >
          {CURRENCIES.map(c => (
            <button
              key={c.code}
              role="option"
              aria-selected={c.code === currencyCode}
              onClick={() => handleSelect(c.code)}
              className={cn(
                'w-full text-left px-4 py-2 text-[12px] font-light',
                'hover:bg-kvrn-bg-raised transition-colors duration-100',
                c.code === currencyCode
                  ? 'text-kvrn-text'
                  : 'text-kvrn-muted'
              )}
            >
              <span className="font-light">{c.code}</span>
              <span className="ml-2 text-kvrn-subtle">{c.symbol}</span>
              <span className="ml-2">{c.label.split(' — ')[1]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
