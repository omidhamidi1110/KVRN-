import type { Metadata } from 'next'
import { AiOperationsClient } from './AiOperationsClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'AI Operations — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <AiOperationsClient />
}
