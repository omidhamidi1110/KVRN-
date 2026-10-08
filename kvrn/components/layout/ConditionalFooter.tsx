'use client'

import { usePathname } from 'next/navigation'
import { Footer } from '@/components/layout/Footer'
import type { ShellData } from '@/lib/content-shell'

export function ConditionalFooter({ shell }: { shell?: ShellData | null } = {}) {
  const pathname = usePathname()
  if (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/')) return null
  return <Footer shell={shell} />
}
