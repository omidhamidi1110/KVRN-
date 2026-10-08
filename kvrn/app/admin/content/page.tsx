import type { Metadata } from 'next'
import { ContentHub } from '@/components/admin/content/ContentHub'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Site content — KVRN Admin', robots: { index: false, follow: false } }

export default function AdminContentPage() { return <ContentHub /> }
