'use client'
// Renders nothing. Sends the one session_start per browsing session, and forgets the session
// if analytics consent is withdrawn. Everything is gated by lib/funnel-client (consent first).
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useCookiePrefs } from '@/context/CookiePrefsContext'
import {
  captureEntryContext, trackSessionStart, clearFunnelSession, analyticsConsentGranted,
  getExistingFunnelSessionIdIfConsented, type EntryContext,
} from '@/lib/funnel-client'

export function FunnelTracker() {
  const { prefs } = useCookiePrefs()
  const pathname = usePathname()
  // The affiliate portal (/affiliate, /affiliate/*) is a partner area, not the storefront: no funnel session there.
  const inAffiliatePortal = pathname === '/affiliate' || (pathname ?? '').startsWith('/affiliate/')
  const inCreditVerification = pathname === '/store-credit/verify'
  const consented = prefs?.analytics === true && !inAffiliatePortal && !inCreditVerification
  // How the visit began is read once, in memory, even if consent arrives later.
  const entry = useRef<EntryContext | null>(null)
  if (entry.current === null && typeof window !== 'undefined' && !inCreditVerification) entry.current = captureEntryContext()

  useEffect(() => {
    if (!consented) {
      if (prefs !== null && !inAffiliatePortal && !inCreditVerification) clearFunnelSession()   // an explicit "no" removes any stored session id
      return
    }
    if (entry.current) trackSessionStart(entry.current)
  }, [consented, prefs, inAffiliatePortal, inCreditVerification])

  // A heartbeat is only sent while the shopper has explicitly accepted analytics,
  // is on a public storefront page and the tab is in the foreground. It never
  // creates an identity or tracks location. Consent withdrawal stops the timer.
  useEffect(() => {
    if (!consented) return
    const ping = () => {
      if (document.visibilityState !== 'visible' || !analyticsConsentGranted()) return
      const sid = getExistingFunnelSessionIdIfConsented()
      if (!sid) return // no extra session just for presence
      void fetch('/api/analytics/presence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', keepalive: false, body: JSON.stringify({ sid }),
      }).catch(() => {})
    }
    const timer = window.setInterval(ping, 60000)
    const onVisible = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [consented])
  return null
}
