import type { Metadata } from 'next'
import { MediaLibraryClient } from './MediaLibraryClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Media — KVRN Admin', robots: { index: false, follow: false } }

export default function AdminMediaPage() { return <MediaLibraryClient /> }
