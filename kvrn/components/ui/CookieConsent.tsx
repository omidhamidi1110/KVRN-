'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useCookiePrefs, type CookiePrefs } from '@/context/CookiePrefsContext'
import { cn } from '@/lib/utils'

// ─── Slide-up banner ─────────────────────────────────────────────────────────
export function CookieBanner() {
  const {
    showBanner, showPrefs,
    acceptAll, denyNonEssential, openPreferences,
  } = useCookiePrefs()

  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    if (showBanner) {
      const t = setTimeout(() => setAnimate(true), 50)
      return () => clearTimeout(t)
    } else {
      setAnimate(false)
    }
  }, [showBanner])

  const visible = showBanner && !showPrefs

  return (
    <>
      <CookiePrefsPanel />

      <div
        role="region"
        aria-label="Cookie consent"
        aria-live="polite"
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[480]',
          'bg-[#0E0E0E] border-t border-[#F0EDE8]/10',
          'transition-transform duration-500 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          (visible && animate) ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        <div className="container-kvrn py-5 md:py-6">
          <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-8">
            {/* Message */}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-light text-[#F0EDE8] leading-relaxed">
                We use cookies to improve your experience.
              </p>
              <p className="text-[12px] text-[#F0EDE8]/50 mt-1 leading-relaxed">
                Essential cookies keep the site working. Optional cookies help us understand usage and improve the site.{' '}
                <Link href="/privacy" className="text-[#F0EDE8]/70 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">
                  Privacy Policy
                </Link>
                {' '}·{' '}
                <Link href="/terms" className="text-[#F0EDE8]/70 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">
                  Terms
                </Link>
              </p>
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              <button
                onClick={openPreferences}
                className="h-9 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/20 text-[#F0EDE8]/60 hover:border-[#F0EDE8]/50 hover:text-[#F0EDE8] transition-colors"
              >
                Preferences
              </button>
              <button
                onClick={denyNonEssential}
                className="h-9 px-4 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/30 text-[#F0EDE8]/70 hover:border-[#F0EDE8]/60 hover:text-[#F0EDE8] transition-colors"
              >
                Deny non-essential
              </button>
              <button
                onClick={acceptAll}
                className="h-9 px-5 text-[11px] font-light tracking-[0.1em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors"
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

// ─── Preferences panel (dark, slides from bottom on mobile / centered on desktop) ─
function CookiePrefsPanel() {
  const { showPrefs, prefs, savePrefs, closePrefs, denyNonEssential, acceptAll } = useCookiePrefs()

  const [local, setLocal] = useState<CookiePrefs>(() => ({
    essential:       true,
    personalization: prefs?.personalization ?? false,
    analytics:       prefs?.analytics       ?? false,
    advertising:     prefs?.advertising     ?? false,
    doNotSell:       prefs?.doNotSell       ?? true,
  }))

  // Sync when real prefs load
  useEffect(() => {
    if (prefs) {
      setLocal({ ...prefs, essential: true })
    }
  }, [prefs])

  const [animate, setAnimate] = useState(false)
  useEffect(() => {
    if (showPrefs) {
      const t = setTimeout(() => setAnimate(true), 20)
      return () => clearTimeout(t)
    } else {
      setAnimate(false)
    }
  }, [showPrefs])

  if (!showPrefs) return null

  const toggle = (key: keyof Omit<CookiePrefs, 'essential'>) => {
    setLocal(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const CATS: Array<{
    key:   keyof CookiePrefs
    label: string
    desc:  string
    locked?: boolean
  }> = [
    {
      key: 'essential', label: 'Essential', locked: true,
      desc: 'Required for the site to function. Includes cart, session, and security. Cannot be disabled.',
    },
    {
      key: 'personalization', label: 'Personalization',
      desc: 'Remembers your language, currency, and display preferences across visits.',
    },
    {
      key: 'analytics', label: 'Analytics',
      desc: 'Helps us understand how visitors navigate the site so we can improve it. No personal data sold.',
    },
    {
      key: 'advertising', label: 'Targeted Advertising',
      desc: 'Used to show relevant ads on external platforms. KVRN does not currently run targeted ad campaigns.',
    },
    {
      key: 'doNotSell', label: 'Do Not Sell or Share My Personal Information',
      desc: 'Opt out of the sale or sharing of your personal information with third parties for advertising.',
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-[490] bg-black/60 backdrop-blur-[3px]',
          'transition-opacity duration-300',
          animate ? 'opacity-100' : 'opacity-0'
        )}
        onClick={closePrefs}
        aria-hidden="true"
      />

      {/* Panel — slides up on mobile, centred modal on desktop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cookie preferences"
        className={cn(
          // Mobile: bottom sheet
          'fixed bottom-0 left-0 right-0 z-[500]',
          // Desktop: centered modal
          'md:bottom-auto md:top-1/2 md:left-1/2',
          'md:-translate-x-1/2 md:-translate-y-1/2',
          'md:w-[560px] md:max-w-[calc(100vw-32px)]',
          // Shared
          'bg-[#0E0E0E] flex flex-col max-h-[92svh] md:max-h-[85vh]',
          'transition-all duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          animate
            ? 'translate-y-0 opacity-100'
            : 'translate-y-8 opacity-0 md:translate-y-4'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[#F0EDE8]/10 flex-shrink-0">
          <h2 className="text-[14px] font-light tracking-[0.06em] text-[#F0EDE8]">
            Cookie preferences
          </h2>
          <button
            onClick={closePrefs}
            aria-label="Close cookie preferences"
            className="text-[#F0EDE8]/40 hover:text-[#F0EDE8] transition-colors p-1"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Intro */}
        <div className="px-6 py-4 border-b border-[#F0EDE8]/10 flex-shrink-0">
          <p className="text-[12px] text-[#F0EDE8]/50 leading-relaxed">
            Choose which types of cookies you allow. Your preference is saved for 12 months.{' '}
            <Link href="/privacy" className="text-[#F0EDE8]/70 underline underline-offset-2 hover:text-[#F0EDE8] transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>

        {/* Categories */}
        <div className="overflow-y-auto flex-1">
          {CATS.map((cat, i) => (
            <div
              key={cat.key}
              className={cn(
                'flex items-start gap-4 px-6 py-4',
                i < CATS.length - 1 && 'border-b border-[#F0EDE8]/8'
              )}
            >
              <div className="flex-1 min-w-0 pr-2">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-[13px] font-light text-[#F0EDE8]">{cat.label}</p>
                  {cat.locked && (
                    <span className="text-[9px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/30 border border-[#F0EDE8]/15 px-1.5 py-0.5">
                      Always on
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#F0EDE8]/40 leading-relaxed">{cat.desc}</p>
              </div>

              {/* Toggle switch */}
              {/* Toggle switch — circle LEFT=off, RIGHT=on */}
              <button
                role="switch"
                aria-checked={cat.locked ? true : !!local[cat.key]}
                aria-label={cat.label}
                disabled={cat.locked}
                onClick={() => !cat.locked && toggle(cat.key as keyof Omit<CookiePrefs, 'essential'>)}
                className={cn(
                  'relative flex-shrink-0 w-11 h-6 rounded-full',
                  'transition-colors duration-200',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F0EDE8]/50',
                  cat.locked
                    ? 'bg-[#F0EDE8]/40 cursor-not-allowed'
                    : (local[cat.key]
                      ? 'bg-[#F0EDE8] cursor-pointer'
                      : 'bg-[#F0EDE8]/15 cursor-pointer hover:bg-[#F0EDE8]/25')
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-[3px] w-[18px] h-[18px] rounded-full shadow-sm',
                    'transition-transform duration-200 ease-in-out',
                    cat.locked
                      ? 'bg-white translate-x-[22px]'       // locked = always ON = right
                      : (local[cat.key]
                        ? 'bg-[#0E0E0E] translate-x-[22px]' // ON  = right
                        : 'bg-[#F0EDE8]/60 translate-x-[3px]') // OFF = left
                  )}
                />
              </button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="px-6 py-5 border-t border-[#F0EDE8]/10 flex items-center justify-between gap-3 flex-shrink-0">
          <button
            onClick={denyNonEssential}
            className="text-[11px] font-light tracking-[0.1em] uppercase text-[#F0EDE8]/35 hover:text-[#F0EDE8]/70 transition-colors"
          >
            Deny all
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => acceptAll()}
              className="h-10 px-5 text-[11px] font-light tracking-[0.1em] uppercase border border-[#F0EDE8]/30 text-[#F0EDE8]/70 hover:border-[#F0EDE8]/60 hover:text-[#F0EDE8] transition-colors"
            >
              Accept all
            </button>
            <button
              onClick={() => savePrefs({ ...local, essential: true })}
              className="h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors"
            >
              Save preferences
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
