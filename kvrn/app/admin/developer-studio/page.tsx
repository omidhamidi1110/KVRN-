import type { Metadata } from 'next'
import { DeveloperStudioClient } from './DeveloperStudioClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Developer Studio — KVRN Admin', robots: { index: false, follow: false } }
export default function DeveloperStudioPage() { return <DeveloperStudioClient /> }
