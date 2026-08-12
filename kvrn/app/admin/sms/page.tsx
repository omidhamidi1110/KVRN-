import type { Metadata } from 'next'
import { AdminSmsClient } from './AdminSmsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'SMS Subscribers — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function AdminSmsPage() {
  return <AdminSmsClient />
}
