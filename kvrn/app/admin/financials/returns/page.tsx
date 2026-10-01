import type { Metadata } from 'next'
import { ReturnsClient } from './ReturnsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Returns — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <ReturnsClient />
}
