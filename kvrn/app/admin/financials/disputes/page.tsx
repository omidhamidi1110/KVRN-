import type { Metadata } from 'next'
import { DisputesClient } from './DisputesClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Disputes — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <DisputesClient />
}
