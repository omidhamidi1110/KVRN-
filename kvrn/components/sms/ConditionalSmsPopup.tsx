'use client'

import { usePathname } from 'next/navigation'
import { SmsPopup } from './SmsPopup'

// Pages where the SMS popup must not appear
const EXCLUDED = ['/checkout', '/admin', '/support/track', '/cart']  // /checkout covers /checkout/success

function isExcluded(path: string): boolean {
  return EXCLUDED.some(p => path === p || path.startsWith(p + '/'))
}

export function ConditionalSmsPopup({enabled}: {enabled: boolean}) {
  const path = usePathname()
  if (!enabled) return null
  if (isExcluded(path)) return null
  return <SmsPopup />
}
