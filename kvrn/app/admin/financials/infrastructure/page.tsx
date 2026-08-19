import type { Metadata } from 'next'
import { InfrastructureClient } from './InfrastructureClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Infrastructure Costs — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <InfrastructureClient />
}
