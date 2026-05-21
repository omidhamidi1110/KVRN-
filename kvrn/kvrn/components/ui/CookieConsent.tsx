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
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-8">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-light text-[#F0EDE8] leading-relaxed mb-1">
                We use cookies to improve your experience.
              </p>
              <p className="text-[12px] text-[#F0EDE8]/70 leading-relaxed">
                Essential cookies keep the site working. Optional cookies help us understand usage.{' '}
                <Link href="/privacy" className="text-[#F0EDE8]/80 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">Privacy Policy</Link>
                {' '}·{' '}
                <Link href="/terms" className="text-[#F0EDE8]/80 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">Terms</Link>
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
              <button onClick={openPreferences}
                className="h-10 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/20 text-[#F0EDE8]/60 hover:border-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors">
                Preferences
              </button>
              <button onClick={denyNonEssential}
                className="h-10 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/30 text-[#F0EDE8]/70 hover:border-[#F0EDE8]/60 hover:text-[#F0EDE8] transition-colors">
                Deny non-essential
              </button>
              <button onClick={acceptAll}
                className="h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors">
                Accept cookies
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Preferences panel — rebuilt clean ───────────────────────────────────────
function CookiePrefsPanel() {
  const { showPrefs, prefs, savePrefs, closePrefs, denyNonEssential } = useCookiePrefs()

  const [local, setLocal] = useState<Omit<CookiePrefs, 'essential'>>({
    personalization: false,
    analytics:       false,
    advertising:     false,
    doNotSell:       true,
  })

  // Sync when real prefs available
  useEffect(() => {
    if (prefs) {
      setLocal({
        personalization: prefs.personalization,
        analytics:       prefs.analytics,
        advertising:     prefs.advertising,
        doNotSell:       prefs.doNotSell,
      })
    }
  }, [prefs])

  const [show, setShow] = useState(false)
  useEffect(() => {
    if (showPrefs) setTimeout(() => setShow(true), 20)
    else setShow(false)
  }, [showPrefs])

  if (!showPrefs) return null

  const toggle = (key: keyof typeof local) => {
    setLocal(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSave = () => {
    savePrefs({ essential: true, ...local })
  }

  const CATEGORIES: Array<{
    key:     keyof typeof local | 'essential'
    label:   string
    desc:    string
    locked?: true
  }> = [
    {
      key:    'essential',
      locked: true,
      label:  'Essential',
      desc:   'Required for the site to work. Includes cart, session, and security. Cannot be disabled.',
    },
    {
      key:   'personalization',
      label: 'Personalization',
      desc:  'Remembers your language, currency, and preferences across visits.',
    },
    {
      key:   'analytics',
      label: 'Analytics',
      desc:  'Helps us understand how visitors use the site so we can improve it.',
    },
    {
      key:   'advertising',
      label: 'Targeted Advertising',
      desc:  'Used to show relevant ads on external platforms. KVRN does not currently run targeted ad campaigns.',
    },
    {
      key:   'doNotSell',
      label: 'Do Not Sell or Share My Personal Information',
      desc:  'Opt out of the sale or sharing of your personal information with third parties.',
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-[490] bg-black/60 transition-opacity duration-300',
          show ? 'opacity-100' : 'opacity-0'
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
          'fixed z-[500]',
          'bottom-0 left-0 right-0',                    // mobile: bottom sheet
          'md:bottom-auto md:top-1/2 md:left-1/2',      // desktop: centred
          'md:-translate-x-1/2 md:-translate-y-1/2',
          'md:w-[560px] md:max-w-[calc(100vw-32px)]',
          'bg-[#111111] flex flex-col max-h-[92svh] md:max-h-[85vh]',
          'transition-all duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          show ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/10 flex-shrink-0">
          <h2 className="text-[15px] font-light text-white tracking-wide">Cookie preferences</h2>
          <button onClick={closePrefs} aria-label="Close"
            className="w-8 h-8 flex items-center justify-center text-white/50 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Intro */}
        <div className="px-6 py-4 border-b border-white/10 flex-shrink-0">
          <p className="text-[13px] text-white/60 leading-relaxed">
            Choose which cookies you allow. Saved for 12 months.{' '}
            <Link href="/privacy" className="text-white/80 underline underline-offset-2 hover:text-white transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>

        {/* Category list */}
        <div className="overflow-y-auto flex-1">
          {CATEGORIES.map((cat, i) => {
            const isOn = cat.locked ? true : !!local[cat.key as keyof typeof local]

            return (
              <div
                key={cat.key}
                className={cn(
                  'flex items-start gap-4 px-6 py-5',
                  i < CATEGORIES.length - 1 ? 'border-b border-white/[0.07]' : ''
                )}
              >
                {/* Text */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="text-[13px] font-light text-white leading-snug">
                      {cat.label}
                    </span>
                    {cat.locked && (
                      <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-light tracking-[0.08em] uppercase border border-white/40 text-white/90">
                        Always on
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-white/60 leading-relaxed">{cat.desc}</p>
                </div>

                {/* Toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label={cat.label}
                  disabled={cat.locked}
                  onClick={() => !cat.locked && toggle(cat.key as keyof typeof local)}
                  className={cn(
                    // Oval track: 44px wide × 24px tall
                    'flex-shrink-0 relative rounded-full mt-1',
                    'w-[44px] h-[24px]',
                    'transition-colors duration-200',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40',
                    cat.locked
                      ? 'cursor-not-allowed opacity-70 bg-white/30'
                      : isOn
                      ? 'cursor-pointer bg-white'
                      : 'cursor-pointer bg-white/20 hover:bg-white/30'
                  )}
                >
                  {/*
                    Circle: 18×18px inside 24px tall track
                    Vertically centered: top = (24-18)/2 = 3px
                    OFF (left):  left = 3px
                    ON  (right): left = 44-18-3 = 23px  →  translateX(20px) from left=3
                  */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute top-[3px] left-[3px]',
                      'w-[18px] h-[18px] rounded-full',
                      'transition-all duration-200 ease-[cubic-bezier(0.34,1.4,0.64,1)]',
                      isOn
                        ? cn('translate-x-[20px]', cat.locked ? 'bg-[#111111]' : 'bg-[#111111]')
                        : 'translate-x-0 bg-white/60'
                    )}
                  />
                </button>
              </div>
            )
          })}
        </div>

        {/* Actions */}
        <div className="px-6 py-5 border-t border-white/10 flex items-center justify-between gap-3 flex-shrink-0">
          <button
            onClick={denyNonEssential}
            className="text-[11px] font-light tracking-[0.1em] uppercase text-white/40 hover:text-white/70 transition-colors"
          >
            Deny all
          </button>
          <button
            onClick={handleSave}
            className="h-10 px-7 text-[11px] font-light tracking-[0.1em] uppercase bg-white text-[#111111] hover:bg-white/90 transition-colors"
          >
            Save preferences
          </button>
        </div>
      </div>
    </>
  )
}
