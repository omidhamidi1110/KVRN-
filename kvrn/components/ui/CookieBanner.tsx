'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

const CONSENT_KEY    = 'kvrn_cookie_consent'
const CONSENT_EXPIRY = 365 * 24 * 60 * 60 * 1000 // 1 year in ms

type ConsentState = 'granted' | 'denied' | null

function readConsent(): ConsentState {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(CONSENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: ConsentState; ts: number }
    // Expire after 1 year
    if (Date.now() - parsed.ts > CONSENT_EXPIRY) {
      localStorage.removeItem(CONSENT_KEY)
      return null
    }
    return parsed.state
  } catch {
    return null
  }
}

function writeConsent(state: ConsentState) {
  if (typeof window === 'undefined') return
  localStorage.setItem(CONSENT_KEY, JSON.stringify({ state, ts: Date.now() }))
}

function applyConsent(state: ConsentState) {
  if (typeof window === 'undefined' || !window.gtag) return
  window.gtag('consent', 'update', {
    analytics_storage:   state === 'granted' ? 'granted' : 'denied',
    ad_storage:          'denied', // KVRN never runs ads — always denied
    functionality_storage: 'granted',
  })
}

export function CookieBanner() {
  const [visible, setVisible]     = useState(false)
  const [animate, setAnimate]     = useState(false)

  useEffect(() => {
    const existing = readConsent()
    if (existing !== null) {
      applyConsent(existing)
      return
    }
    // Delay appearance by 1.5s so it doesn't distract from LCP
    const t = setTimeout(() => {
      setVisible(true)
      requestAnimationFrame(() => setAnimate(true))
    }, 1500)
    return () => clearTimeout(t)
  }, [])

  const handleGrant = () => {
    writeConsent('granted')
    applyConsent('granted')
    dismiss()
  }

  const handleDeny = () => {
    writeConsent('denied')
    applyConsent('denied')
    dismiss()
  }

  const dismiss = () => {
    setAnimate(false)
    setTimeout(() => setVisible(false), 300)
  }

  if (!visible) return null

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie preferences"
      className={cn(
        'fixed bottom-0 left-0 right-0 z-[500] bg-kvrn-bg border-t border-kvrn-border',
        'transition-transform duration-300 ease-out',
        animate ? 'translate-y-0' : 'translate-y-full'
      )}
    >
      <div className="container-kvrn py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <p className="text-[12px] text-kvrn-muted leading-relaxed max-w-lg">
          We use analytics cookies to understand how you use our site. No advertising cookies.{' '}
          <a
            href="/cookies"
            className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity"
          >
            Learn more
          </a>
          .
        </p>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={handleDeny}
            className="text-[11px] font-light tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
            aria-label="Decline analytics cookies"
          >
            Decline
          </button>
          <button
            onClick={handleGrant}
            className="text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 h-9 hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
            aria-label="Accept analytics cookies"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
