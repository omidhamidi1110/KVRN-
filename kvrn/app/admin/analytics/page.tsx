import type { Metadata } from 'next'
import { AnalyticsClient } from './AnalyticsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Analytics — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <AnalyticsClient />
}
