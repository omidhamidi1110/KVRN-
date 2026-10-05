import type { Metadata } from 'next'
import { BackupsClient } from './BackupsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Backups — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <BackupsClient />
}
