import type { Metadata } from 'next'
import { InventoryClient } from './InventoryClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Inventory — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <InventoryClient />
}
