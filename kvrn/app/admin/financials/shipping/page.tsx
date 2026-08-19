import type { Metadata } from 'next'
import { ShippingClient } from './ShippingClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Shipping Economics — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <ShippingClient />
}
