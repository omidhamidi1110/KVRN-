import type { Metadata } from 'next'
import { PreviewClient } from './PreviewClient'

export const dynamic = 'force-dynamic'
// Private: never indexed, never linked from the storefront or the sitemap.
export const metadata: Metadata = { title: 'Product preview — KVRN Admin', robots: { index: false, follow: false, nocache: true } }

export default async function ProductPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <PreviewClient id={id} />
}
