'use client'

import { useState, useRef, useEffect } from 'react'
import { useCurrency } from '@/context/CurrencyContext'
import { CURRENCIES, type CurrencyCode } from '@/lib/currency'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  align?:     'left' | 'right'
  variant?:   'header' | 'drawer'  // header=compact, drawer=full label
}

export function CurrencySelector({ className, align = 'right', variant = 'header' }: Props) {
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

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Currency: ${currencyCode}`}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-light tracking-[0.1em] text-[#1A1A1A] hover:opacity-50 transition-opacity"
      >
        <span>{currencyCode}</span>
        <svg width="7" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true"
          className={cn('transition-transform duration-200', open && 'rotate-180')}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div
          role="listbox" aria-label="Select currency"
          className={cn(
            'absolute top-full mt-3 z-[350]',
            'bg-[#F9F8F6] border border-[#E8E5E0]',
            'py-1 min-w-[200px] max-h-[280px] overflow-y-auto shadow-lg',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {CURRENCIES.map(c => (
            <button
              key={c.code}
              role="option"
              aria-selected={c.code === currencyCode}
              onClick={() => { setCurrency(c.code); setOpen(false) }}
              className={cn(
                'w-full text-left px-4 py-2.5 flex items-center justify-between gap-3',
                'text-[12px] font-light transition-colors duration-100',
                'hover:bg-[#F3F0EB]',
                c.code === currencyCode
                  ? 'text-[#1A1A1A] bg-[#F3F0EB]'
                  : 'text-[#6B6B6B]'
              )}
            >
              <span className="font-light tracking-[0.06em]">{c.code}</span>
              <span className="text-[11px] text-[#9B9B9B]">{c.symbol} · {c.label.split(' — ')[1]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
