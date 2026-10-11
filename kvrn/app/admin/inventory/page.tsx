import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Inventory — KVRN Admin',
  robots: { index: false, follow: false },
}

// Dynamic so inventory is always fresh
export const dynamic = 'force-dynamic'

export default function AdminInventoryPage() {
  return <AdminInventoryClient />
}

// ── All UI is client — Cloudflare Access handles auth at the edge ───────────
import AdminInventoryClient from './AdminInventoryClient'
