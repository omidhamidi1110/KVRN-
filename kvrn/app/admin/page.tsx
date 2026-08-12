import type { Metadata } from 'next'
import { AdminDashboardClient } from './AdminDashboardClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Overview — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function AdminPage() {
  return <AdminDashboardClient />
}
