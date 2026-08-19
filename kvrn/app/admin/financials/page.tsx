import type { Metadata } from 'next'
import { FinancialsClient } from './FinancialsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Financials — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <FinancialsClient />
}
