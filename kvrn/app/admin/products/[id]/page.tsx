import type { Metadata } from 'next'
import { ProductEditorClient } from './ProductEditorClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Edit product — KVRN Admin', robots: { index: false, follow: false } }

export default async function AdminProductEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ProductEditorClient id={id} />
}
