import type { Metadata } from 'next'
import { AffiliatesClient } from './AffiliatesClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Affiliates — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <AffiliatesClient />
}
