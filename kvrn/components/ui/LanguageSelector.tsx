'use client'

import { useState, useRef, useEffect } from 'react'
import { useI18n, LANGUAGES, type Locale } from '@/context/I18nContext'
import { cn } from '@/lib/utils'

interface Props { className?: string; align?: 'left' | 'right' }

export function LanguageSelector({ className, align = 'right' }: Props) {
  const { locale, setLocale } = useI18n()
  const [open, setOpen]       = useState(false)
  const ref                   = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const current = LANGUAGES.find(l => l.code === locale) ?? LANGUAGES[0]

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`Language: ${current.label}`}
        className="flex items-center gap-1 text-[11px] font-light tracking-[0.1em] text-[#1A1A1A] hover:opacity-50 transition-opacity"
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
            'bg-[#F9F8F6] border border-[#E8E5E0]',
            'py-1 min-w-[180px] max-h-[300px] overflow-y-auto shadow-lg',
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
                'w-full text-left px-4 py-2.5 flex items-center justify-between gap-3',
                'text-[12px] font-light transition-colors duration-100',
                'hover:bg-[#F3F0EB]',
                l.code === locale
                  ? 'text-[#1A1A1A] bg-[#F3F0EB]'
                  : 'text-[#6B6B6B]'
              )}
            >
              <span>{l.nativeLabel}</span>
              <span className="text-[10px] text-[#9B9B9B] tracking-wide">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
