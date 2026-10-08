import type { Metadata } from 'next'
import { DefaultsClient } from './DefaultsClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Product defaults — KVRN Admin', robots: { index: false, follow: false } }

export default function ProductDefaultsPage() { return <DefaultsClient /> }
