import type { Metadata } from 'next'
import { NewProductClient } from './NewProductClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'New product — KVRN Admin', robots: { index: false, follow: false } }

export default function NewProductPage() { return <NewProductClient /> }
