import type { Metadata } from 'next'
import { AdminOrdersClient } from './AdminOrdersClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title:  'Orders — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function AdminOrdersPage() {
  return <AdminOrdersClient />
}
