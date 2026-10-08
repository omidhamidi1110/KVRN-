import type { Metadata } from 'next'
import { SystemClient } from './SystemClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'System — KVRN Admin', robots: { index: false, follow: false } }

export default function AdminSystemPage() { return <SystemClient /> }
