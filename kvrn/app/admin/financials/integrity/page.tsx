import type { Metadata } from 'next'
import { IntegrityClient } from './IntegrityClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Reconciliation — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <IntegrityClient />
}
