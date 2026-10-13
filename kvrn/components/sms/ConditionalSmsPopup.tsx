'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { SmsPopup } from './SmsPopup'

// Pages where the SMS popup must not appear
const EXCLUDED = ['/checkout', '/admin', '/support/track', '/cart']  // /checkout covers /checkout/success

function isExcluded(path: string): boolean {
  return EXCLUDED.some(p => path === p || path.startsWith(p + '/'))
}

export function ConditionalSmsPopup({enabled}: {enabled: boolean}) {
  const path = usePathname()
  // Carrier approval gates enrollment, not the desktop visibility of the
  // existing designed popup. Mobile remains gated exactly as before.
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 900px)')
    const sync = () => setDesktop(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  if (isExcluded(path)) return null
  if (!enabled && !desktop) return null
  return <SmsPopup signupAvailable={enabled} />
}
