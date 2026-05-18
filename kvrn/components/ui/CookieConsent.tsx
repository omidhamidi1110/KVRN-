'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useCookiePrefs, type CookiePrefs } from '@/context/CookiePrefsContext'
import { cn } from '@/lib/utils'

// ─── Banner (bottom slide-up) ─────────────────────────────────────────────────
export function CookieBanner() {
  const { showBanner, showPrefs, acceptAll, denyNonEssential, openPreferences } = useCookiePrefs()

  const visible = showBanner && !showPrefs

  return (
    <>
      {/* Backdrop for prefs panel */}
      <CookiePrefsPanel />

      {/* Slide-up banner */}
      <div
        role="region"
        aria-label="Cookie consent"
        aria-live="polite"
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[480]',
          'bg-[#F9F8F6] border-t border-[#E8E5E0]',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          visible ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        <div className="container-kvrn py-5">
          <div className="flex flex-col md:flex-row md:items-center gap-5 md:gap-8">
            {/* Text */}
            <div className="flex-1 space-y-1.5">
              <p className="text-[13px] font-light text-[#1A1A1A]">
                We use cookies to improve your experience.
              </p>
              <p className="text-[12px] text-[#6B6B6B] leading-relaxed">
                Essential cookies keep the site working. Optional cookies help us understand usage.{' '}
                <Link href="/privacy" className="text-[#1A1A1A] underline underline-offset-2 hover:opacity-60 transition-opacity">
                  Privacy Policy
                </Link>{' '}·{' '}
                <Link href="/terms" className="text-[#1A1A1A] underline underline-offset-2 hover:opacity-60 transition-opacity">
                  Terms
                </Link>
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 flex-shrink-0">
              <button
                onClick={openPreferences}
                className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors"
              >
                Preferences
              </button>
              <button
                onClick={denyNonEssential}
                className="h-9 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#C8C4BF] text-[#6B6B6B] hover:border-[#1A1A1A] hover:text-[#1A1A1A] transition-colors"
              >
                Deny non-essential
              </button>
              <button
                onClick={acceptAll}
                className="h-9 px-5 text-[11px] font-light tracking-[0.1em] uppercase bg-[#1A1A1A] text-white hover:bg-[#333] transition-colors"
              >
                Accept all
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Preferences panel ────────────────────────────────────────────────────────
function CookiePrefsPanel() {
  const { showPrefs, prefs, savePrefs, closePrefs, denyNonEssential } = useCookiePrefs()

  const [local, setLocal] = useState<CookiePrefs>({
    essential:       true,
    personalization: prefs?.personalization ?? false,
    analytics:       prefs?.analytics       ?? false,
    advertising:     prefs?.advertising     ?? false,
    doNotSell:       prefs?.doNotSell       ?? true,
  })

  // Sync when prefs load
  const handleToggle = (key: keyof CookiePrefs) => {
    if (key === 'essential') return
    setLocal(prev => ({ ...prev, [key]: !prev[key] }))
  }

  if (!showPrefs) return null

  const CATEGORIES: Array<{
    key:       keyof CookiePrefs
    label:     string
    desc:      string
    required?: boolean
  }> = [
    {
      key: 'essential', label: 'Essential', required: true,
      desc: 'Required for the site to function. Cannot be disabled. Includes cart, session, and security.',
    },
    {
      key: 'personalization', label: 'Personalization',
      desc: 'Remembers your language, currency, and preferences across visits.',
    },
    {
      key: 'analytics', label: 'Analytics',
      desc: 'Helps us understand how visitors use the site so we can improve it. No personal data sold.',
    },
    {
      key: 'advertising', label: 'Targeted Advertising',
      desc: 'Used to show relevant ads on other platforms. KVRN currently does not run targeted ads.',
    },
    {
      key: 'doNotSell', label: 'Do Not Sell or Share My Personal Information',
      desc: 'Opt out of the sale or sharing of your personal information with third parties.',
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[490] bg-black/40 backdrop-blur-[2px]"
        onClick={closePrefs}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cookie preferences"
        className={cn(
          'fixed z-[500] bottom-0 left-0 right-0 md:bottom-auto md:top-1/2 md:-translate-y-1/2',
          'md:left-1/2 md:-translate-x-1/2 md:w-[600px] md:max-w-[calc(100vw-32px)]',
          'bg-[#F9F8F6] max-h-[90svh] flex flex-col',
          'shadow-2xl'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[#E8E5E0] flex-shrink-0">
          <h2 className="text-[15px] font-light tracking-wide">Cookie preferences</h2>
          <button onClick={closePrefs} aria-label="Close" className="text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Description */}
        <div className="px-6 py-4 border-b border-[#E8E5E0] flex-shrink-0">
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Choose which cookies you allow. Your choice is saved for 12 months.
            Essential cookies cannot be disabled.{' '}
            <Link href="/privacy" className="text-[#1A1A1A] underline underline-offset-2">Privacy Policy</Link>
          </p>
        </div>

        {/* Categories */}
        <div className="overflow-y-auto flex-1 px-6 py-2">
          {CATEGORIES.map((cat) => (
            <div key={cat.key} className="flex items-start gap-5 py-4 border-b border-[#E8E5E0] last:border-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-[13px] font-light text-[#1A1A1A]">{cat.label}</p>
                  {cat.required && (
                    <span className="text-[10px] font-light tracking-[0.08em] uppercase text-[#9B9B9B] border border-[#E8E5E0] px-1.5 py-0.5">
                      Always on
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-[#6B6B6B] leading-relaxed">{cat.desc}</p>
              </div>

              {/* Toggle */}
              <button
                role="switch"
                aria-checked={local[cat.key] === true}
                aria-label={`${cat.label}: ${local[cat.key] ? 'on' : 'off'}`}
                disabled={cat.required}
                onClick={() => handleToggle(cat.key)}
                className={cn(
                  'relative w-10 h-5 flex-shrink-0 mt-0.5 rounded-full transition-colors duration-200',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                  cat.required
                    ? 'bg-[#C8C4BF] cursor-not-allowed'
                    : local[cat.key]
                    ? 'bg-[#1A1A1A] cursor-pointer'
                    : 'bg-[#D5D1CB] cursor-pointer'
                )}
              >
                <span
                  className={cn(
                    'absolute top-[3px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200',
                    local[cat.key] ? 'translate-x-[22px]' : 'translate-x-[3px]'
                  )}
                />
              </button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="px-6 py-5 border-t border-[#E8E5E0] flex items-center justify-between gap-3 flex-shrink-0">
          <button
            onClick={denyNonEssential}
            className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors"
          >
            Deny all
          </button>
          <button
            onClick={() => savePrefs({ ...local, essential: true })}
            className="h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase bg-[#1A1A1A] text-white hover:bg-[#333] transition-colors"
          >
            Save preferences
          </button>
        </div>
      </div>
    </>
  )
}
