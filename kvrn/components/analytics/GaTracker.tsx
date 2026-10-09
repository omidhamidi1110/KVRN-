'use client'
// Renders nothing. Loads GA4 only while EFFECTIVE analytics consent exists (the existing cookie
// preference AND no Do Not Track AND no Global Privacy Control), sends exactly one page_view per
// route, and shuts GA down the moment consent is withdrawn or an opt-out signal blocks it.
//
// The measurement id is NOT a prop and NOT a build-time value: lib/ga-client fetches it from the
// runtime config route, and only after effective consent. All decisions live in lib/ga-client
// (syncGa) so they are unit-testable; this component only calls it when preferences / route change.
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useCookiePrefs, STORAGE_KEY } from '@/context/CookiePrefsContext'
import { syncGa, disableGa } from '@/lib/ga-client'
import { analyticsConsentGranted } from '@/lib/funnel-client'

export function GaTracker() {
  const { prefs } = useCookiePrefs()
  const pathname = usePathname()
  // null = preferences not read yet (do nothing); otherwise the stored analytics preference.
  const pref: boolean | null = prefs === null ? null : prefs.analytics === true

  // The affiliate portal (/affiliate, /affiliate/*) is a partner area, not the storefront: no GA there.
  const inAffiliatePortal = pathname === '/affiliate' || (pathname ?? '').startsWith('/affiliate/')
  const inCreditVerification = pathname === '/store-credit/verify'

  useEffect(() => {
    if (inAffiliatePortal || inCreditVerification) { disableGa(); return }
    void syncGa(pref)      // idempotent; declines/opt-outs disable GA immediately
  }, [pref, prefs, pathname, inAffiliatePortal, inCreditVerification])

  // Consent changed in ANOTHER tab (or DNT/GPC now blocks): stop here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && !analyticsConsentGranted()) disableGa()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return null
}
