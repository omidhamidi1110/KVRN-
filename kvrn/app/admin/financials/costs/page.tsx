import type { Metadata } from 'next'
import { CostsClient } from './CostsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Product Costs — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <CostsClient />
}
