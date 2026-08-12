import type { Metadata } from 'next'
import { AdminDiscountsClient } from './AdminDiscountsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Discounts — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function AdminDiscountsPage() {
  return <AdminDiscountsClient />
}
