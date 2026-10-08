import type { Metadata } from 'next'
import { AbandonedCheckoutsClient } from './AbandonedCheckoutsClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Abandoned checkouts — KVRN Admin', robots: { index: false, follow: false } }

export default function AdminAbandonedCheckoutsPage() { return <AbandonedCheckoutsClient /> }
