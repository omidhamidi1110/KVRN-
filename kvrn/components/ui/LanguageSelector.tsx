'use client'

import { useState, useRef, useEffect } from 'react'
import { useI18n, LANGUAGES, type Locale } from '@/context/I18nContext'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  align?:     'left' | 'right'
  inDrawer?:  boolean  // renders inline list style, no dropdown
}

export function LanguageSelector({ className, align = 'right', inDrawer = false }: Props) {
  const { locale, setLocale } = useI18n()
  const [open, setOpen]       = useState(false)
  const ref                   = useRef<HTMLDivElement>(null)
  const current = LANGUAGES.find(l => l.code === locale) ?? LANGUAGES[0]

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Inline drawer style — horizontal pill list
  if (inDrawer) {
    return (
      <div className={cn('space-y-1', className)}>
        <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">Language</p>
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map(l => (
            <button
              key={l.code}
              onClick={() => setLocale(l.code as Locale)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-light border transition-all duration-150',
                l.code === locale
                  ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                  : 'border-[#E8E5E0] text-[#1A1A1A] hover:border-[#1A1A1A]'
              )}
            >
              {l.nativeLabel}
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
        aria-expanded={open}
        aria-label={`Language: ${current.label}`}
        className="flex items-center gap-1 text-[11px] font-light tracking-[0.1em] hover:opacity-50 transition-opacity"
      >
        <span>{current.nativeLabel}</span>
        <svg width="7" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true"
          className={cn('transition-transform duration-200', open && 'rotate-180')}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div
          role="listbox" aria-label="Select language"
          className={cn(
            'absolute top-full mt-3 z-[350]',
            'bg-[#F9F8F6] border border-[#1A1A1A]/10',
            'py-1 min-w-[200px] max-h-[320px] overflow-y-auto shadow-xl',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {LANGUAGES.map(l => (
            <button
              key={l.code}
              role="option"
              aria-selected={l.code === locale}
              onClick={() => { setLocale(l.code as Locale); setOpen(false) }}
              className={cn(
                'w-full text-left px-4 py-2.5 flex items-center justify-between gap-4',
                'transition-colors duration-100',
                'hover:bg-[#F3F0EB]',
                l.code === locale
                  ? 'bg-[#F3F0EB]'
                  : ''
              )}
            >
              {/* Native label — always high contrast */}
              <span className="text-[13px] font-light text-[#1A1A1A]">{l.nativeLabel}</span>
              {/* English label — readable secondary */}
              <span className="text-[11px] text-[#6B6B6B] tracking-wide flex-shrink-0">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
