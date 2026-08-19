import type { Metadata } from 'next'
import { AdvertisingClient } from './AdvertisingClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advertising — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <AdvertisingClient />
}
