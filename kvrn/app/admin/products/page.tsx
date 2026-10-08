import type { Metadata } from 'next'
import { ProductListClient } from './ProductListClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Products — KVRN Admin', robots: { index: false, follow: false } }

export default function AdminProductsPage() { return <ProductListClient /> }
