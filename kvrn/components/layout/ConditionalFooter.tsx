'use client'

import { usePathname } from 'next/navigation'
import { Footer } from '@/components/layout/Footer'

export function ConditionalFooter() {
  const pathname = usePathname()
  if (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/')) return null
  return <Footer />
}
