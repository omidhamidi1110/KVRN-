import type { Metadata } from 'next'
import { ExpensesClient } from './ExpensesClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Expenses — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <ExpensesClient />
}
