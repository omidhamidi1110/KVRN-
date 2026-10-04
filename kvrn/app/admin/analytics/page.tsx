import type { Metadata } from 'next'
import { AnalyticsClient } from './AnalyticsClient'
import { describeGaConfig } from '@/lib/ga4-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Analytics — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  // Configuration STATE only (never the secret) is handed to the client component.
  return <AnalyticsClient ga={describeGaConfig()} />
}
