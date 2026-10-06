import type { Metadata } from 'next'
import { SupportInboxClient } from './SupportInboxClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Support — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <SupportInboxClient />
}
