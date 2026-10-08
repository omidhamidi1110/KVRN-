'use client'

// After the visitor switches language or currency the cookies are already written (see
// context/I18nContext). This re-renders the server-rendered parts of the page (CMS text, prices
// seeded by the layout) with the new cookies, so server and client stay in step without a full
// reload. Renders nothing.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { PREFERENCES_CHANGED_EVENT } from '@/lib/i18n/preferences'

export function PreferenceRefresher() {
  const router = useRouter()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      if (timer) clearTimeout(timer)
      // One refresh for a language change that also changes the currency (two events, one tick).
      timer = setTimeout(() => router.refresh(), 60)
    }
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onChange)
    return () => { window.removeEventListener(PREFERENCES_CHANGED_EVENT, onChange); if (timer) clearTimeout(timer) }
  }, [router])
  return null
}
