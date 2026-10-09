import type { Metadata } from 'next'
import { HomepageClient } from '@/components/homepage/HomepageClient'

export const metadata: Metadata = {
  title: 'KVRN — Premium Heavyweight Fleece',
  description: 'KVRN heavyweight hoodies and sweatpants. 400–500 GSM. Quiet luxury built for daily wear.',
  alternates: { canonical: '/' },
}

export default function HomePage() {
  return <HomepageClient />
}
