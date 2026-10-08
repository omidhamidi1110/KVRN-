'use client'
// Renders nothing. Sends the one session_start per browsing session, and forgets the session
// if analytics consent is withdrawn. Everything is gated by lib/funnel-client (consent first).
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useCookiePrefs } from '@/context/CookiePrefsContext'
import {
  captureEntryContext, trackSessionStart, clearFunnelSession, type EntryContext,
} from '@/lib/funnel-client'

export function FunnelTracker() {
  const { prefs } = useCookiePrefs()
  const pathname = usePathname()
  // The affiliate portal (/affiliate, /affiliate/*) is a partner area, not the storefront: no funnel session there.
  const inAffiliatePortal = pathname === '/affiliate' || (pathname ?? '').startsWith('/affiliate/')
  const consented = prefs?.analytics === true && !inAffiliatePortal
  // How the visit began is read once, in memory, even if consent arrives later.
  const entry = useRef<EntryContext | null>(null)
  if (entry.current === null && typeof window !== 'undefined') entry.current = captureEntryContext()

  useEffect(() => {
    if (!consented) {
      if (prefs !== null && !inAffiliatePortal) clearFunnelSession()   // an explicit "no" removes any stored session id
      return
    }
    if (entry.current) trackSessionStart(entry.current)
  }, [consented, prefs, inAffiliatePortal])

  return null
}
