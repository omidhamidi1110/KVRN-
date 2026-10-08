'use client'

import { useState, useRef, useEffect } from 'react'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n } from '@/context/I18nContext'
import { format } from '@/lib/i18n/messages'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  align?:     'left' | 'right'
  inDrawer?:  boolean
}

export function CurrencySelector({ className, align = 'right', inDrawer = false }: Props) {
  const { currencyCode, setCurrency, available } = useCurrency()
  const { t }                         = useI18n()
  const [open, setOpen]               = useState(false)
  const ref                           = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Inline drawer style — grid of codes
  if (inDrawer) {
    return (
      <div className={cn('space-y-1', className)}>
        <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{t['nav.currency']}</p>
        <div className="flex flex-wrap gap-1.5">
          {available.map(c => (
            <button
              key={c.code}
              onClick={() => setCurrency(c.code)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-light border transition-all duration-150',
                c.code === currencyCode
                  ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                  : 'border-[#E8E5E0] text-[#1A1A1A] hover:border-[#1A1A1A]'
              )}
            >
              {c.code}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={format(t['nav.currencyIs'], { code: currencyCode })}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-light tracking-[0.1em] hover:opacity-50 transition-opacity"
      >
        <span>{currencyCode}</span>
        <svg width="7" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true"
          className={cn('transition-transform duration-200', open && 'rotate-180')}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div
          role="listbox" aria-label={t['nav.selectCurrency']}
          className={cn(
            'absolute top-full mt-3 z-[350]',
            'bg-[#F9F8F6] border border-[#1A1A1A]/10',
            'py-1 min-w-[220px] max-h-[300px] overflow-y-auto shadow-xl',
            align === 'right' ? 'end-0' : 'start-0'
          )}
        >
          {available.map(c => (
            <button
              key={c.code}
              role="option"
              aria-selected={c.code === currencyCode}
              onClick={() => { setCurrency(c.code); setOpen(false) }}
              className={cn(
                'w-full text-start px-4 py-2.5 flex items-center gap-3',
                'transition-colors duration-100',
                'hover:bg-[#F3F0EB]',
                c.code === currencyCode ? 'bg-[#F3F0EB]' : ''
              )}
            >
              {/* Code — always high contrast */}
              <span className="text-[13px] font-light text-[#1A1A1A] w-10 flex-shrink-0">{c.code}</span>
              {/* Symbol */}
              <span className="text-[12px] text-[#6B6B6B] w-6 flex-shrink-0">{c.symbol}</span>
              {/* Currency name */}
              <span className="text-[12px] text-[#6B6B6B] truncate">{c.label.split(' — ')[1]}</span>
            </button>
          ))}
          {/* Always say what the card is charged in; with only USD on offer, say that too. */}
          <p className="px-4 pt-2 pb-2 text-[11px] leading-snug text-[#6B6B6B] border-t border-[#E8E5E0] mt-1">
            {available.length > 1 ? t['currency.approxNote'] : t['currency.usdOnly']}
          </p>
        </div>
      )}
    </div>
  )
}
