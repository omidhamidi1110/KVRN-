'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useCookiePrefs, type CookiePrefs } from '@/context/CookiePrefsContext'
import { cn } from '@/lib/utils'

// ─── Slide-up banner ─────────────────────────────────────────────────────────
export function CookieBanner() {
  const { showBanner, showPrefs, acceptAll, denyNonEssential, openPreferences } = useCookiePrefs()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    if (showBanner && !showPrefs) {
      t = setTimeout(() => setVisible(true), 60)
    } else {
      setVisible(false)
    }
    return () => clearTimeout(t)
  }, [showBanner, showPrefs])

  return (
    <>
      <CookiePrefsPanel />

      {/* Banner */}
      <div
        role="region"
        aria-label="Cookie consent"
        aria-live="polite"
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[480]',
          'bg-[#0E0E0E] border-t border-[#F0EDE8]/10',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          visible ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        <div className="container-kvrn py-5 md:py-6">
          {/* Mobile: stacked. Desktop: row */}
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-8">

            {/* Message */}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-light text-[#F0EDE8] leading-relaxed mb-1">
                We use cookies to improve your experience.
              </p>
              <p className="text-[12px] text-[#F0EDE8]/75 leading-relaxed">
                Essential cookies keep the site working. Optional cookies help us understand usage.{' '}
                <Link href="/privacy" className="text-[#F0EDE8]/65 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">
                  Privacy Policy
                </Link>
                {' '}·{' '}
                <Link href="/terms" className="text-[#F0EDE8]/65 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">
                  Terms
                </Link>
              </p>
            </div>

            {/* Buttons — stacked on mobile, row on md+ */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
              <button
                onClick={openPreferences}
                className="h-10 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/18 text-[#F0EDE8]/50 hover:border-[#F0EDE8]/40 hover:text-[#F0EDE8]/80 transition-colors"
              >
                Preferences
              </button>
              <button
                onClick={denyNonEssential}
                className="h-10 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/25 text-[#F0EDE8]/65 hover:border-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors"
              >
                Deny non-essential
              </button>
              <button
                onClick={acceptAll}
                className="h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors"
              >
                Accept cookies
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Preferences panel ─────────────────────────────────────────────────────────
function CookiePrefsPanel() {
  const { showPrefs, prefs, savePrefs, closePrefs, denyNonEssential, acceptAll } = useCookiePrefs()

  const [local, setLocal] = useState<CookiePrefs>({
    essential: true,
    personalization: false,
    analytics:       false,
    advertising:     false,
    doNotSell:       true,
  })

  // Sync when prefs load
  useEffect(() => {
    if (prefs) setLocal({ ...prefs, essential: true })
  }, [prefs, showPrefs])

  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    if (showPrefs) t = setTimeout(() => setVisible(true), 20)
    else setVisible(false)
    return () => clearTimeout(t)
  }, [showPrefs])

  const toggle = (key: keyof Omit<CookiePrefs, 'essential'>) => {
    setLocal(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const CATS: Array<{ key: keyof CookiePrefs; label: string; desc: string; locked?: true }> = [
    { key: 'essential',       label: 'Essential',       locked: true,
      desc: 'Required for cart, session, and security. Cannot be disabled.' },
    { key: 'personalization', label: 'Personalization',
      desc: 'Remembers language, currency, and display preferences across visits.' },
    { key: 'analytics',       label: 'Analytics',
      desc: 'Helps us understand site usage so we can improve it. No personal data sold.' },
    { key: 'advertising',     label: 'Targeted Advertising',
      desc: 'Used for ads on external platforms. KVRN does not currently run targeted ads.' },
    { key: 'doNotSell',       label: 'Do Not Sell or Share My Personal Information',
      desc: 'Opt out of the sale or sharing of your personal information with third parties.' },
  ]

  if (!showPrefs) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-[490] bg-black/65 backdrop-blur-[3px]',
          'transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={closePrefs}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cookie preferences"
        className={cn(
          // Mobile: bottom sheet slide up
          'fixed bottom-0 left-0 right-0 z-[500]',
          // Desktop: centred modal
          'md:bottom-auto md:top-1/2 md:left-1/2',
          'md:-translate-x-1/2 md:-translate-y-1/2',
          'md:w-[540px] md:max-w-[calc(100vw-32px)]',
          'bg-[#0E0E0E] flex flex-col',
          'max-h-[92svh] md:max-h-[85vh]',
          'transition-all duration-450 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          visible
            ? 'translate-y-0 opacity-100'
            : 'translate-y-6 opacity-0 md:translate-y-4'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[#F0EDE8]/10 flex-shrink-0">
          <h2 className="text-[14px] font-light tracking-[0.04em] text-[#F0EDE8]">Cookie preferences</h2>
          <button onClick={closePrefs} aria-label="Close"
            className="text-[#F0EDE8]/40 hover:text-[#F0EDE8] transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Description */}
        <div className="px-6 py-4 border-b border-[#F0EDE8]/8 flex-shrink-0">
          <p className="text-[12px] text-[#F0EDE8]/75 leading-relaxed">
            Choose which cookies you allow. Your preference is saved for 12 months.{' '}
            <Link href="/privacy" className="text-[#F0EDE8]/65 underline underline-offset-2 hover:text-[#F0EDE8]">
              Privacy Policy
            </Link>
          </p>
        </div>

        {/* Categories */}
        <div className="overflow-y-auto flex-1">
          {CATS.map((cat, i) => {
            const isOn = cat.locked ? true : !!local[cat.key]
            return (
              <div
                key={cat.key}
                className={cn(
                  'flex items-center gap-5 px-6 py-4',
                  i < CATS.length - 1 && 'border-b border-[#F0EDE8]/7'
                )}
              >
                {/* Text */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 mb-1">
                    <p className="text-[13px] font-light text-[#F0EDE8]">{cat.label}</p>
                    {cat.locked && (
                      <span className="text-[9px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/28 border border-[#F0EDE8]/14 px-1.5 py-0.5 rounded-[1px]">
                        Always on
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[#F0EDE8]/70 leading-relaxed">{cat.desc}</p>
                </div>

                {/* Toggle switch — OFF=left, ON=right */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label={cat.label}
                  disabled={cat.locked}
                  onClick={() => !cat.locked && toggle(cat.key as keyof Omit<CookiePrefs, 'essential'>)}
                  className={cn(
                    'flex-shrink-0 relative w-12 h-6 rounded-full',
                    'transition-colors duration-200',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F0EDE8]/40',
                    cat.locked
                      ? 'bg-[#F0EDE8]/35 cursor-not-allowed'
                      : isOn
                      ? 'bg-[#F0EDE8] cursor-pointer'
                      : 'bg-[#444] cursor-pointer hover:bg-[#F0EDE8]/22'
                  )}
                >
                  {/*
                    Circle position:
                    OFF → left  (translate-x-[2px])
                    ON  → right (translate-x-[20px])
                  */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute top-[3px] w-[18px] h-[18px] rounded-full',
                      'transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                      isOn
                        ? cn(
                            'translate-x-[20px]',
                            cat.locked ? 'bg-white' : 'bg-[#0E0E0E]'
                          )
                        : 'translate-x-[2px] bg-[#F0EDE8]/50'
                    )}
                  />
                </button>
              </div>
            )
          })}
        </div>

        {/* Actions */}
        <div className="px-6 py-5 border-t border-[#F0EDE8]/10 flex items-center justify-between gap-3 flex-shrink-0">
          <button
            onClick={denyNonEssential}
            className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/30 hover:text-[#F0EDE8]/65 transition-colors"
          >
            Deny all
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => acceptAll()}
              className="h-10 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/22 text-[#F0EDE8]/60 hover:border-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors"
            >
              Accept all
            </button>
            <button
              onClick={() => savePrefs({ ...local, essential: true })}
              className="h-10 px-5 text-[11px] font-light tracking-[0.1em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors"
            >
              Save preferences
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
